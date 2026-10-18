try { require('dotenv').config(); } catch {}
const express = require('express');
const multer = require('multer');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const QRCode = require('qrcode');
const { db, uuid, tx } = require('./db');
const { seed } = require('./seed');
const { adapters, status: adapterStatus, normaliseItems, itemCents } = require('./adapters');
const live = require('./integrations');
const photonAgent = require('./photon-agent');
const { minutesToClose, localTime, clampDiscount, priceFor } = require('./pricing');

const PORT = +process.env.PORT || 3000;
const SECRET = process.env.SESSION_SECRET || 'dev-secret-change-me';
const HOLD_MS = 10 * 60e3;
const KG_PER_MEAL = 0.4, CO2E_PER_KG = 2.5; // §4.4 estimates, labelled in the UI
const UPLOADS = path.join(__dirname, '..', 'uploads');
fs.mkdirSync(UPLOADS, { recursive: true });

seed();
photonAgent.init(db);
if (live.tiger.available()) live.tiger.init(db).then(() => { tigerReady = true; console.log('[tiger] connected'); })
  .catch(e => { tigerError = e.message; console.warn('[tiger] init failed:', e.message); });
let tigerReady = false, tigerError = null;
const app = express();
app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, '..', 'public')));
app.use('/uploads', express.static(UPLOADS));
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 8 * 1024 * 1024 } });

// ---------- helpers ----------
class ApiError extends Error { constructor(http, code, message) { super(message); this.http = http; this.code = code; } }
const wrap = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const J = s => (s ? JSON.parse(s) : null);
const sign = v => `${v}.${crypto.createHmac('sha256', SECRET).update(v).digest('base64url')}`;
function readSession(req) {
  const m = /(?:^|;\s*)fwm=([^;]+)/.exec(req.headers.cookie || '');
  if (!m) return null;
  const raw = decodeURIComponent(m[1]); const i = raw.lastIndexOf('.');
  const v = raw.slice(0, i);
  if (sign(v) !== raw) return null;
  return db.prepare('SELECT * FROM users WHERE id = ?').get(v) || null;
}
function auth(role) {
  return (req, _res, next) => {
    req.user = readSession(req);
    if (!req.user) return next(new ApiError(401, 'unauthenticated', 'Log in first'));
    if (role && req.user.role !== role) return next(new ApiError(403, 'forbidden', `Only ${role}s can do this`));
    next();
  };
}
function km(a, b) {
  const R = 6371, rad = x => x * Math.PI / 180;
  const dLat = rad(b.lat - a.lat), dLng = rad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}
function listingOut(l) {
  const s = db.prepare('SELECT id, name, type, address, lat, lng, closes_at FROM stores WHERE id = ?').get(l.store_id);
  return { ...l, items: J(l.items), tags: J(l.tags), ai_meta: undefined, store: s };
}
function enqueue(kind, payload, delayMs = 0) {
  db.prepare('INSERT INTO jobs (id, kind, payload, run_at) VALUES (?,?,?,?)').run(uuid(), kind, JSON.stringify(payload), Date.now() + delayMs);
}

// ---------- SSE (§5.3) ----------
const clients = new Set(); // { res, user }
function emit(event, data, filter = () => true) {
  const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const c of clients) if (filter(c.user)) c.res.write(msg);
}
const api = express.Router();
api.get('/stream', (req, res) => {
  const user = readSession(req);
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
  res.write(': connected\n\n');
  const c = { res, user }; clients.add(c);
  const ping = setInterval(() => res.write(': ping\n\n'), 20000);
  req.on('close', () => { clearInterval(ping); clients.delete(c); });
});

// ---------- auth ----------
api.get('/auth/users', (_req, res) => res.json(db.prepare(`SELECT u.id, u.role, u.name, s.name store_name FROM users u
  LEFT JOIN stores s ON s.id = u.store_id ORDER BY u.role, u.name`).all()));
api.post('/auth/demo-login', (req, res) => {
  const u = db.prepare('SELECT * FROM users WHERE id = ?').get(req.body.user_id);
  if (!u) throw new ApiError(404, 'not_found', 'Unknown user');
  res.setHeader('set-cookie', `fwm=${encodeURIComponent(sign(u.id))}; Path=/; HttpOnly; SameSite=Lax; Max-Age=604800`);
  res.json(u);
});
api.post('/auth/logout', (_req, res) => { res.setHeader('set-cookie', 'fwm=; Path=/; Max-Age=0'); res.json({ ok: true }); });
api.get('/me', auth(), (req, res) => {
  const store = req.user.store_id ? db.prepare('SELECT * FROM stores WHERE id = ?').get(req.user.store_id) : null;
  res.json({ ...req.user, store });
});

// ---------- seller: listings ----------
api.post('/listings/draft', auth('seller'), upload.single('photo'), wrap(async (req, res) => {
  const store = db.prepare('SELECT * FROM stores WHERE id = ?').get(req.user.store_id);
  let photo_url = null;
  if (req.file) {
    if (!/^image\//.test(req.file.mimetype)) throw new ApiError(400, 'invalid_input', 'Photo must be an image');
    const name = `${uuid()}${path.extname(req.file.originalname) || '.jpg'}`;
    fs.writeFileSync(path.join(UPLOADS, name), req.file.buffer);
    photo_url = `/uploads/${name}`;
  } else if (req.body.preset) {
    photo_url = `/demo/${req.body.preset}.svg`;
  } else throw new ApiError(400, 'invalid_input', 'Attach a photo');

  const vis = await adapters.vision.detect({ buffer: req.file?.buffer, mimetype: req.file?.mimetype,
    originalname: req.file?.originalname, hint: req.body.preset });
  const items = normaliseItems(vis.items || []);
  if (!items.length) throw new ApiError(400, 'invalid_input', 'No food items recognised; try another photo');
  const minutes = minutesToClose(store.closes_at, store.timezone);
  const original_cents = items.reduce((a, i) => a + itemCents(i.name) * i.qty, 0);
  const llm = await adapters.listing.write({ items, minutes, store, time: localTime(store.timezone), originalCents: original_cents });
  const discount_pct = clampDiscount(llm.discount_pct, minutes);
  const closeAt = Date.now() + minutes * 60e3;
  res.json({
    items, title: llm.title, description: llm.description, tags: llm.tags, original_cents, discount_pct,
    price_cents: priceFor(original_cents, discount_pct), qty_total: 1,
    pickup_until: new Date(Math.min(closeAt, Date.now() + 4 * 3600e3)).toISOString(), photo_url,
    minutes_to_close: minutes, proposed_discount: llm.discount_pct,
    source: { vision: vis._source, llm: llm._source },
  });
}));

function validateListing(b) {
  const bad = m => { throw new ApiError(400, 'invalid_input', m); };
  if (!b.title || String(b.title).length > 80) bad('Title is required (max 80 chars)');
  if (!b.description || String(b.description).length > 240) bad('Description is required (max 240 chars)');
  const o = Math.round(+b.original_cents), p = Math.round(+b.price_cents), q = Math.round(+b.qty_total);
  if (!(o > 0)) bad('Original price must be positive');
  if (!(p >= 50 && p <= o)) bad('Price must be at least $0.50 and no more than the original');
  if (!(q > 0 && q <= 100)) bad('Quantity must be 1 to 100');
  const until = Date.parse(b.pickup_until);
  if (!(until > Date.now())) bad('Pickup window must end in the future');
  return { o, p, q, until };
}
api.post('/listings', auth('seller'), (req, res) => {
  const b = req.body; const { o, p, q, until } = validateListing(b);
  const id = uuid();
  db.prepare(`INSERT INTO listings (id, store_id, title, description, items, tags, photo_url, original_cents, price_cents, discount_pct,
    qty_total, qty_available, pickup_until, status, ai_meta, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,'active',?,?)`)
    .run(id, req.user.store_id, String(b.title), String(b.description), JSON.stringify(b.items || []), JSON.stringify(b.tags || []),
      b.photo_url || null, o, p, Math.round(100 - (p / o) * 100), q, q, until, JSON.stringify({ source: b.source || null }), Date.now());
  enqueue('alert_fanout', { listing_id: id });
  res.status(201).json(listingOut(db.prepare('SELECT * FROM listings WHERE id = ?').get(id)));
});
api.patch('/listings/:id', auth('seller'), (req, res) => {
  const l = db.prepare('SELECT * FROM listings WHERE id = ?').get(req.params.id);
  if (!l) throw new ApiError(404, 'not_found', 'Unknown listing');
  if (l.store_id !== req.user.store_id) throw new ApiError(403, 'forbidden', "Not your store's listing");
  if (req.body.status === 'withdrawn') db.prepare("UPDATE listings SET status='withdrawn' WHERE id=?").run(l.id);
  if (req.body.price_cents) {
    const p = Math.round(+req.body.price_cents);
    if (!(p >= 50 && p <= l.original_cents)) throw new ApiError(400, 'invalid_input', 'Bad price');
    db.prepare('UPDATE listings SET price_cents=?, discount_pct=? WHERE id=?').run(p, Math.round(100 - p / l.original_cents * 100), l.id);
  }
  const out = listingOut(db.prepare('SELECT * FROM listings WHERE id = ?').get(l.id));
  emit('listing.updated', { id: out.id, qty_available: out.qty_available, status: out.status, price_cents: out.price_cents });
  res.json(out);
});
api.get('/store/listings', auth('seller'), (req, res) => {
  res.json(db.prepare('SELECT * FROM listings WHERE store_id = ? ORDER BY created_at DESC LIMIT 30').all(req.user.store_id).map(listingOut));
});

// ---------- buyer: discovery ----------
function prefsFit(l, prefs) {
  if (!prefs) return { ok: true, score: 0 };
  const tags = J(l.tags) || []; let score = 0;
  const diet = prefs.diet || [];
  const dietOk = diet.every(d => tags.includes(d) || (d === 'vegetarian' && tags.includes('vegan')));
  const priceOk = !prefs.max_price_cents || l.price_cents <= prefs.max_price_cents;
  if (dietOk) score += 2; if (priceOk) score += 1;
  if ((prefs.favourite_stores || []).includes(l.store_id)) score += 2;
  return { ok: dietOk && priceOk, score };
}
api.get('/listings/nearby', auth(), wrap(async (req, res) => {
  const { prefs } = await adapters.memory.get({ db, userId: req.user.id });
  const here = { lat: +req.query.lat || prefs?.lat || 47.6553, lng: +req.query.lng || prefs?.lng || -122.3035 };
  const radius = +req.query.radius_km || prefs?.radius_km || 5;
  const rows = db.prepare("SELECT * FROM listings WHERE status='active' AND pickup_until > ? AND qty_available > 0").all(Date.now());
  const out = rows.map(l => {
    const s = db.prepare('SELECT lat, lng FROM stores WHERE id=?').get(l.store_id);
    const distance_km = km(here, s); const fit = prefsFit(l, prefs);
    const hoursLeft = (l.pickup_until - Date.now()) / 3600e3;
    return { ...listingOut(l), distance_km: +distance_km.toFixed(2), match: fit.ok,
      rank: fit.score * 2 + (fit.ok ? 3 : 0) - distance_km * 0.6 + Math.max(0, 3 - hoursLeft) * 0.5 };
  }).filter(l => l.distance_km <= radius).sort((a, b) => b.rank - a.rank);
  res.json({ here, radius_km: radius, listings: out });
}));
api.get('/listings/:id', auth(), (req, res) => {
  const l = db.prepare('SELECT * FROM listings WHERE id = ?').get(req.params.id);
  if (!l) throw new ApiError(404, 'not_found', 'Unknown listing');
  res.json(listingOut(l));
});
api.get('/me/preferences', auth('buyer'), wrap(async (req, res) => {
  const r = await adapters.memory.get({ db, userId: req.user.id });
  res.json({ prefs: r.prefs || { diet: [], max_price_cents: 2000, radius_km: 5, favourite_stores: [] }, source: r._source });
}));
api.put('/me/preferences', auth('buyer'), wrap(async (req, res) => {
  const b = req.body || {};
  const prefs = {
    diet: (b.diet || []).filter(d => ['vegetarian', 'vegan'].includes(d)),
    max_price_cents: Math.max(0, Math.round(+b.max_price_cents || 0)),
    radius_km: Math.min(50, Math.max(0.5, +b.radius_km || 5)),
    favourite_stores: (b.favourite_stores || []).map(String),
    lat: +b.lat || undefined, lng: +b.lng || undefined,
  };
  const r = await adapters.memory.put({ db, userId: req.user.id, prefs });
  res.json({ prefs: r.prefs, source: r._source });
}));
api.get('/stores', (_req, res) => res.json(db.prepare('SELECT id, name, type, address, lat, lng, closes_at FROM stores').all()));

// ---------- reservations & payments (§4.3, §5.2) ----------
const code = () => Array.from(crypto.randomBytes(6), b => 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'[b % 31]).join('');
function createHold({ userId, listingId, qty }) {
  if (!(qty > 0)) throw new ApiError(400, 'invalid_input', 'Quantity must be positive');
  const r = tx(() => {
    const l = db.prepare('SELECT * FROM listings WHERE id = ?').get(listingId);
    if (!l) throw new ApiError(404, 'not_found', 'Unknown listing');
    if (l.status !== 'active' || l.pickup_until <= Date.now()) throw new ApiError(409, 'sold_out', 'This listing is no longer available');
    if (l.qty_available < qty) throw new ApiError(409, 'sold_out', `Only ${l.qty_available} left`);
    const left = l.qty_available - qty;
    db.prepare('UPDATE listings SET qty_available = ?, status = ? WHERE id = ?').run(left, left === 0 ? 'sold_out' : 'active', l.id);
    const id = uuid();
    db.prepare(`INSERT INTO reservations (id, listing_id, buyer_id, qty, total_cents, status, hold_expires_at, pickup_code, created_at)
      VALUES (?,?,?,?,?,'pending',?,?,?)`).run(id, l.id, userId, qty, l.price_cents * qty, Date.now() + HOLD_MS, code(), Date.now());
    return { id, listing_id: l.id, qty_available: left, status: left === 0 ? 'sold_out' : 'active' };
  });
  emit('listing.updated', { id: r.listing_id, qty_available: r.qty_available, status: r.status });
  return r;
}
api.post('/reservations', auth('buyer'), (req, res) => {
  const r = createHold({ userId: req.user.id, listingId: req.body.listing_id, qty: Math.round(+req.body.qty || 1) });
  res.status(201).json(reservationOut(r.id));
});
function reservationOut(id) {
  const r = db.prepare('SELECT * FROM reservations WHERE id = ?').get(id);
  if (!r) return null;
  const l = db.prepare('SELECT * FROM listings WHERE id = ?').get(r.listing_id);
  const pay = db.prepare('SELECT * FROM payments WHERE reservation_id = ?').get(id);
  return { ...r, pickup_code: r.status === 'paid' || r.status === 'picked_up' ? r.pickup_code : undefined,
    listing: listingOut(l), payment: pay || null };
}
function ownReservation(req) {
  const r = db.prepare('SELECT * FROM reservations WHERE id = ?').get(req.params.id);
  if (!r) throw new ApiError(404, 'not_found', 'Unknown reservation');
  if (r.buyer_id !== req.user.id) throw new ApiError(403, 'forbidden', 'Not your reservation');
  return r;
}
api.get('/reservations/:id', auth('buyer'), (req, res) => { ownReservation(req); res.json(reservationOut(req.params.id)); });
api.get('/me/reservations', auth('buyer'), (req, res) => {
  res.json(db.prepare("SELECT id FROM reservations WHERE buyer_id = ? AND status != 'cancelled' ORDER BY created_at DESC LIMIT 20")
    .all(req.user.id).map(r => reservationOut(r.id)));
});
api.post('/reservations/:id/pay', auth('buyer'), wrap(async (req, res) => {
  const r = ownReservation(req);
  const key = req.headers['idempotency-key'] || req.body.idempotency_key;
  if (!key) throw new ApiError(400, 'invalid_input', 'Idempotency-Key header required');
  if (r.status === 'paid' || r.status === 'picked_up') {
    if (r.idempotency_key === key) return res.json({ status: r.status, replay: true, ...reservationOut(r.id) });
    throw new ApiError(409, 'invalid_input', 'Already paid');
  }
  if (r.status === 'cancelled' || r.hold_expires_at < Date.now()) throw new ApiError(409, 'hold_expired', 'Your 10-minute hold expired');
  const ch = await adapters.pay.charge({ reservationId: r.id, amountCents: r.total_cents, token: req.body.payment_token, idempotencyKey: key,
    card: { exp: req.body.card_exp, cvc: req.body.card_cvc }, buyer: { name: req.user.name, email: req.user.email } });
  if (!ch.ok) throw new ApiError(402, 'payment_declined', 'Card declined. Try a different card.');
  const l = db.prepare('SELECT * FROM listings WHERE id = ?').get(r.listing_id);
  tx(() => {
    db.prepare("UPDATE reservations SET status='paid', paid_at=?, idempotency_key=? WHERE id=? AND status='pending'").run(Date.now(), key, r.id);
    db.prepare(`INSERT INTO payments (id, reservation_id, visa_txn_id, visa_status, payout_cents, payout_status, created_at)
      VALUES (?,?,?,?,?,'queued',?)`).run(uuid(), r.id, ch.txnId, ch.status, Math.round(r.total_cents * 0.95), Date.now()); // 5% platform fee
    enqueue('payout', { reservation_id: r.id });
  });
  emit('reservation.paid', { reservation_id: r.id, qty: r.qty, total_cents: r.total_cents, title: l.title },
    u => u && u.store_id === l.store_id);
  const store = db.prepare('SELECT name FROM stores WHERE id = ?').get(l.store_id);
  adapters.memory.remember({ db, userId: req.user.id, text: `Buyer ${req.user.id} bought "${l.title}" (${(J(l.tags) || []).join(', ')}) from ${store.name} for $${(r.total_cents / 100).toFixed(2)} at ${new Date().toLocaleTimeString('en-US', { timeZone: 'America/Los_Angeles' })}`, metadata: { store_id: l.store_id } }).catch(() => {});
  const code = db.prepare('SELECT pickup_code FROM reservations WHERE id = ?').get(r.id).pickup_code;
  photonAgent.notifyUser(db, req.user.id, `Paid ✅ ${l.title} at ${store.name}. Pickup code: ${code}`).catch(() => {});
  res.json({ status: 'paid', visa_txn_id: ch.txnId, payout: { status: 'queued' }, source: ch._source, ...reservationOut(r.id) });
}));
function cancel(r) {
  tx(() => {
    const ok = db.prepare("UPDATE reservations SET status='cancelled' WHERE id=? AND status='pending'").run(r.id).changes;
    if (!ok) return;
    db.prepare(`UPDATE listings SET qty_available = qty_available + ?, status = CASE WHEN status='sold_out' AND pickup_until > ? THEN 'active' ELSE status END WHERE id = ?`)
      .run(r.qty, Date.now(), r.listing_id);
  });
  const l = db.prepare('SELECT * FROM listings WHERE id=?').get(r.listing_id);
  emit('listing.updated', { id: l.id, qty_available: l.qty_available, status: l.status });
}
api.post('/reservations/:id/cancel', auth('buyer'), (req, res) => {
  const r = ownReservation(req);
  if (r.status !== 'pending') throw new ApiError(409, 'invalid_input', 'Only unpaid holds can be cancelled');
  cancel(r); res.json(reservationOut(r.id));
});
api.get('/reservations/:id/qr.svg', auth('buyer'), wrap(async (req, res) => {
  const r = ownReservation(req);
  if (r.status !== 'paid') throw new ApiError(409, 'invalid_input', 'QR available after payment');
  res.type('image/svg+xml').send(await QRCode.toString(`FWM:${r.id}:${r.pickup_code}`, { type: 'svg', margin: 1 }));
}));
// Seller pickup: accepts the QR payload or the 6-character code.
api.post('/pickup', auth('seller'), (req, res) => {
  const raw = String(req.body.code || '').trim().toUpperCase();
  const pickupCode = raw.startsWith('FWM:') ? raw.split(':')[2] : raw;
  const r = db.prepare(`SELECT r.*, l.store_id, l.items FROM reservations r JOIN listings l ON l.id = r.listing_id
    WHERE r.pickup_code = ? AND l.store_id = ?`).get(pickupCode, req.user.store_id);
  if (!r) throw new ApiError(404, 'not_found', 'No order with that code at your store');
  if (r.status === 'picked_up') throw new ApiError(409, 'invalid_input', 'Already picked up');
  if (r.status !== 'paid') throw new ApiError(409, 'invalid_input', 'Order is not paid');
  const itemsPerUnit = Math.max(1, (J(r.items) || []).reduce((a, i) => a + i.qty, 0));
  const meals = itemsPerUnit * r.qty; const kg = +(meals * KG_PER_MEAL).toFixed(2);
  tx(() => {
    db.prepare("UPDATE reservations SET status='picked_up', picked_up_at=? WHERE id=?").run(Date.now(), r.id);
    db.prepare('INSERT INTO impact_events VALUES (?,?,?,?,?,?,?)').run(Date.now(), r.store_id, r.id, meals, kg, +(kg * CO2E_PER_KG).toFixed(2), r.total_cents);
  });
  if (live.tiger.available()) {
    const st = db.prepare('SELECT name FROM stores WHERE id = ?').get(r.store_id);
    live.tiger.insert({ ts: Date.now(), store_id: r.store_id, store_name: st.name, reservation_id: r.id, meals_saved: meals, kg_saved: kg,
      co2e_kg: +(kg * CO2E_PER_KG).toFixed(2), cents_recovered: r.total_cents }).catch(e => console.warn('[tiger] insert failed:', e.message));
  }
  emit('impact.updated', impactSummary());
  emit('reservation.picked_up', { reservation_id: r.id }, u => u && u.id === r.buyer_id);
  res.json({ ok: true, meals_saved: meals, kg_saved: kg, reservation: reservationOut(r.id) });
});
api.get('/orders', auth('seller'), (req, res) => {
  res.json(db.prepare(`SELECT r.id FROM reservations r JOIN listings l ON l.id = r.listing_id
    WHERE l.store_id = ? AND r.status != 'cancelled' ORDER BY r.created_at DESC LIMIT 40`).all(req.user.store_id)
    .map(x => { const o = reservationOut(x.id); o.buyer = db.prepare('SELECT name FROM users WHERE id=?').get(o.buyer_id).name; return o; }));
});

// ---------- impact (§4.4) ----------
function impactSummary(storeId) {
  const where = storeId ? 'WHERE store_id = ?' : ''; const args = storeId ? [storeId] : [];
  const t = db.prepare(`SELECT coalesce(sum(meals_saved),0) meals, coalesce(sum(kg_saved),0) kg, coalesce(sum(co2e_kg),0) co2e,
    coalesce(sum(cents_recovered),0) cents, count(*) pickups FROM impact_events ${where}`).get(...args);
  const daily = db.prepare(`SELECT date(ts/1000, 'unixepoch', '-7 hours') day, sum(meals_saved) meals, sum(cents_recovered) cents
    FROM impact_events ${where} GROUP BY day ORDER BY day DESC LIMIT 14`).all(...args).reverse();
  const by_store = db.prepare(`SELECT s.id, s.name, coalesce(sum(e.meals_saved),0) meals, coalesce(sum(e.cents_recovered),0) cents
    FROM stores s LEFT JOIN impact_events e ON e.store_id = s.id GROUP BY s.id ORDER BY meals DESC`).all();
  return { totals: { ...t, kg: +(+t.kg).toFixed(1), co2e: +(+t.co2e).toFixed(1) }, daily, by_store,
    assumptions: { kg_per_meal: KG_PER_MEAL, co2e_per_kg: CO2E_PER_KG } };
}
api.get('/impact/summary', wrap(async (req, res) => {
  if (live.tiger.available() && tigerReady) {
    try { return res.json({ ...(await live.tiger.summary(req.query.store_id)), assumptions: { kg_per_meal: KG_PER_MEAL, co2e_per_kg: CO2E_PER_KG }, source: 'tiger-data' }); }
    catch (e) { tigerError = e.message; }
  }
  res.json({ ...impactSummary(req.query.store_id), source: 'local' });
}));
api.get('/impact/card/:storeId.svg', (req, res) => {
  const s = db.prepare('SELECT * FROM stores WHERE id = ?').get(req.params.storeId);
  if (!s) throw new ApiError(404, 'not_found', 'Unknown store');
  const t = impactSummary(s.id).totals;
  const esc = x => String(x).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  res.type('image/svg+xml').send(`<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630">
<rect width="1200" height="630" fill="#1f3d2b"/><circle cx="1080" cy="110" r="220" fill="#2d5a3f"/>
<text x="80" y="130" font-family="Georgia,serif" font-size="40" fill="#f4c46b">Rescued at ${esc(s.name)}</text>
<text x="80" y="300" font-family="Georgia,serif" font-size="150" font-weight="700" fill="#fdf6e9">${t.meals} meals</text>
<text x="80" y="390" font-family="Helvetica,Arial,sans-serif" font-size="44" fill="#fdf6e9">$${(t.cents / 100).toFixed(0)} recovered · ${t.kg} kg kept out of the bin</text>
<text x="80" y="560" font-family="Helvetica,Arial,sans-serif" font-size="30" fill="#a9c8b4">Last Call · surplus food, rescued nightly · estimates</text></svg>`);
});
api.get('/health', (_req, res) => {
  let dbOk = true; try { db.prepare('SELECT 1').get(); } catch { dbOk = false; }
  res.json({ ok: dbOk, db: dbOk ? 'ok' : 'down', adapters: adapterStatus, sse_clients: clients.size,
    tiger_data: live.tiger.available() ? (tigerReady ? 'live' : `error: ${tigerError || 'connecting'}`) : 'off',
    photon: photonAgent.status, public_url: process.env.PUBLIC_URL || null });
});
api.post('/admin/reset', (req, res) => {
  if (process.env.ADMIN_TOKEN && req.headers['x-admin-token'] !== process.env.ADMIN_TOKEN && req.body?.token !== process.env.ADMIN_TOKEN) throw new ApiError(403, 'forbidden', 'Admin token required'); seed({ force: true }); emit('impact.updated', impactSummary()); res.json({ ok: true }); });

app.use('/api/v1', api);
app.use('/api', (req, res) => res.status(404).json({ error: { code: 'not_found', message: 'No such endpoint' } }));
app.use((err, _req, res, _next) => {
  if (err instanceof ApiError) return res.status(err.http).json({ error: { code: err.code, message: err.message } });
  if (err.code === 'LIMIT_FILE_SIZE') return res.status(400).json({ error: { code: 'invalid_input', message: 'Photo too large (8 MB max)' } });
  console.error(err);
  res.status(500).json({ error: { code: 'internal', message: 'Something went wrong' } });
});

// ---------- worker (§3: jobs table, payouts, expiry, alert fan-out) ----------
let working = false;
async function tick() {
  if (working) return; working = true;
  try {
    const now = Date.now();
    for (const r of db.prepare("SELECT * FROM reservations WHERE status='pending' AND hold_expires_at < ?").all(now)) cancel(r);
    for (const l of db.prepare("SELECT id FROM listings WHERE status IN ('active','sold_out') AND pickup_until < ?").all(now)) {
      db.prepare("UPDATE listings SET status='expired' WHERE id=?").run(l.id);
      emit('listing.updated', { id: l.id, status: 'expired', qty_available: 0 });
    }
    const jobs = db.prepare('SELECT * FROM jobs WHERE done_at IS NULL AND run_at <= ? AND attempts < 5 ORDER BY run_at LIMIT 10').all(now);
    for (const j of jobs) {
      db.prepare('UPDATE jobs SET attempts = attempts + 1 WHERE id = ?').run(j.id);
      try { await runJob(j.kind, JSON.parse(j.payload)); db.prepare('UPDATE jobs SET done_at=? WHERE id=?').run(Date.now(), j.id); }
      catch (e) { db.prepare('UPDATE jobs SET last_error=?, run_at=? WHERE id=?').run(String(e.message), Date.now() + 2000 * (j.attempts + 1), j.id); }
    }
  } finally { working = false; }
}
async function runJob(kind, p) {
  if (kind === 'payout') {
    const r = db.prepare('SELECT r.*, l.store_id FROM reservations r JOIN listings l ON l.id = r.listing_id WHERE r.id = ?').get(p.reservation_id);
    const pay = db.prepare('SELECT * FROM payments WHERE reservation_id = ?').get(r.id);
    if (pay.payout_status === 'confirmed') return;
    const store = db.prepare('SELECT * FROM stores WHERE id = ?').get(r.store_id);
    const out = await adapters.payout.send({ wallet: store.solana_wallet, amountCents: pay.payout_cents, reservationId: r.id });
    db.prepare("UPDATE payments SET solana_sig=?, explorer_url=?, payout_status='confirmed' WHERE id=?").run(out.signature, out.explorerUrl, pay.id);
    emit('payout.confirmed', { reservation_id: r.id, solana_sig: out.signature, amount_cents: pay.payout_cents, explorer_url: out.explorerUrl, source: out._source },
      u => u && u.store_id === r.store_id);
  } else if (kind === 'alert_fanout') {
    const l = db.prepare('SELECT * FROM listings WHERE id = ?').get(p.listing_id);
    const s = db.prepare('SELECT * FROM stores WHERE id = ?').get(l.store_id);
    const summary = { id: l.id, title: l.title, price_cents: l.price_cents, discount_pct: l.discount_pct, store: s.name };
    for (const c of clients) {
      if (!c.user || c.user.role !== 'buyer') continue;
      const { prefs } = await adapters.memory.get({ db, userId: c.user.id });
      const here = { lat: prefs?.lat || 47.6553, lng: prefs?.lng || -122.3035 };
      const d = km(here, s); const fit = prefsFit(l, prefs);
      const inRadius = d <= (prefs?.radius_km || 5);
      c.res.write(`event: listing.new\ndata: ${JSON.stringify({ ...summary, distance_km: +d.toFixed(2), match: fit.ok && inRadius })}\n\n`);
    }
    await photonAgent.alertListing(db, { listing: l, store: s, matches: async userId => {
      const { prefs } = await adapters.memory.get({ db, userId });
      const here = { lat: prefs?.lat || 47.6553, lng: prefs?.lng || -122.3035 };
      return prefsFit(l, prefs).ok && km(here, s) <= (prefs?.radius_km || 5);
    } });
  }
}
const timer = setInterval(() => tick().catch(e => console.error('worker', e)), 1000);
const stopPhoton = photonAgent.start(db, { reserve: createHold });

const server = app.listen(PORT, () => console.log(`Last Call running on http://localhost:${PORT}`));
module.exports = { app, close: () => { clearInterval(timer); stopPhoton(); for (const c of clients) c.res.end(); server.closeAllConnections(); server.close(); } };
