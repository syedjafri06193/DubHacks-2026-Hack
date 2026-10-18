// Photon 2.0 messaging agent: deal alerts over iMessage/SMS, reserve by text, Q&A via Gemini.
const crypto = require('node:crypto');
const { photon } = require('./integrations');
const { gemini, hasGemini } = require('./adapters');

const BASE_URL = () => process.env.PUBLIC_URL || `http://localhost:${process.env.PORT || 3000}`;
const status = { mode: photon.available() ? 'live' : 'off', lastError: null, linked: 0 };

function init(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS photon_links (
    user_id TEXT PRIMARY KEY REFERENCES users(id), space_id TEXT NOT NULL, handle TEXT, last_listing_id TEXT,
    opted_in INTEGER NOT NULL DEFAULT 1, created_at INTEGER NOT NULL)`);
  db.exec('CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT)');
  status.linked = db.prepare('SELECT count(*) c FROM photon_links WHERE opted_in = 1').get().c;
}

async function say(spaceId, text, parentMessageId) {
  try { await photon.send({ spaceId, text, parentMessageId }); }
  catch (e) { status.lastError = { at: new Date().toISOString(), error: String(e.message) }; console.warn('[photon] send failed:', e.message); }
}

// Called from the alert fan-out job for every new listing.
async function alertListing(db, { listing, store, matches }) {
  if (!photon.available()) return;
  const links = db.prepare('SELECT * FROM photon_links WHERE opted_in = 1').all();
  for (const link of links) {
    if (!(await matches(link.user_id))) continue;
    db.prepare('UPDATE photon_links SET last_listing_id = ? WHERE user_id = ?').run(listing.id, link.user_id);
    await say(link.space_id, `🥐 Last Call: ${store.name} just listed "${listing.title}" for $${(listing.price_cents / 100).toFixed(2)} ` +
      `(${listing.discount_pct}% off). Reply RESERVE to hold one for 10 min, or STOP to opt out.`);
  }
}

async function notifyUser(db, userId, text) {
  if (!photon.available()) return;
  const link = db.prepare('SELECT * FROM photon_links WHERE user_id = ? AND opted_in = 1').get(userId);
  if (link) await say(link.space_id, text);
}

// Inbound loop: poll received messages and act on them.
function start(db, { reserve }) {
  if (!photon.available()) return () => {};
  init(db);
  const kvGet = () => db.prepare("SELECT v FROM kv WHERE k='photon_since'").get()?.v;
  const kvSet = v => db.prepare("INSERT OR REPLACE INTO kv VALUES ('photon_since', ?)").run(v);
  if (!kvGet()) kvSet(new Date().toISOString());
  const seen = new Set();
  let busy = false;
  const loop = async () => {
    if (busy) return; busy = true;
    try {
      const msgs = await photon.poll(kvGet());
      for (const m of msgs) {
        if (seen.has(m.id)) continue; seen.add(m.id);
        if (m.createdAt) kvSet(m.createdAt);
        if (process.env.PHOTON_AGENT_USER_ID && m.senderId === process.env.PHOTON_AGENT_USER_ID) continue;
        await handle(db, m, reserve);
      }
      status.lastError = null;
    } catch (e) { status.lastError = { at: new Date().toISOString(), error: String(e.message) }; }
    finally { busy = false; }
  };
  const t = setInterval(loop, 3000); loop();
  return () => clearInterval(t);
}

async function handle(db, m, reserve) {
  const text = String(m.content?.text || '').trim();
  if (!text) return;
  const upper = text.toUpperCase();
  const link = db.prepare('SELECT * FROM photon_links WHERE space_id = ?').get(m.spaceId);

  if (upper.startsWith('JOIN')) {
    const who = text.slice(4).trim().toLowerCase();
    const user = who && db.prepare("SELECT * FROM users WHERE role='buyer' AND (lower(name) LIKE ? OR lower(email) = ? OR id = ?)")
      .get(`${who}%`, who, who);
    if (!user) return say(m.spaceId, 'Hi! Reply "JOIN <your Last Call name or email>" to get nearby food-rescue deals by text.', m.id);
    db.prepare(`INSERT INTO photon_links (user_id, space_id, handle, opted_in, created_at) VALUES (?,?,?,1,?)
      ON CONFLICT(user_id) DO UPDATE SET space_id = excluded.space_id, opted_in = 1`).run(user.id, m.spaceId, m.senderId || null, Date.now());
    status.linked = db.prepare('SELECT count(*) c FROM photon_links WHERE opted_in = 1').get().c;
    return say(m.spaceId, `You're in, ${user.name.split(' ')[0]}! I'll text you when surplus food matching your preferences is listed nearby. Reply STOP anytime.`, m.id);
  }
  if (!link) return say(m.spaceId, 'Hi! Reply "JOIN <your Last Call name or email>" to link this chat to your account.', m.id);
  if (upper === 'STOP') {
    db.prepare('UPDATE photon_links SET opted_in = 0 WHERE user_id = ?').run(link.user_id);
    return say(m.spaceId, "You're unsubscribed. Text JOIN to come back.", m.id);
  }
  if (upper.startsWith('RESERVE')) {
    if (!link.last_listing_id) return say(m.spaceId, "No deal to reserve yet — I'll text you when one appears.", m.id);
    try {
      const r = reserve({ userId: link.user_id, listingId: link.last_listing_id, qty: 1 });
      return say(m.spaceId, `Held for 10 minutes ✅ Pay here: ${BASE_URL()}/#/checkout/${r.id}`, m.id);
    } catch (e) { return say(m.spaceId, `Sorry — ${e.message}.`, m.id); }
  }
  // Free-form question → Gemini answers with tonight's live listings as context (guard-railed).
  const deals = db.prepare(`SELECT l.title, l.price_cents, l.tags, s.name store FROM listings l JOIN stores s ON s.id = l.store_id
    WHERE l.status='active' AND l.qty_available > 0 AND l.pickup_until > ? LIMIT 10`).all(Date.now());
  if (!hasGemini()) return say(m.spaceId, `Tonight: ${deals.map(d => `${d.title} @ ${d.store} $${(d.price_cents / 100).toFixed(2)}`).join('; ') || 'nothing yet'}. Reply RESERVE for the latest alert.`, m.id);
  try {
    const out = await gemini([{ text: `You are Last Call, a friendly SMS assistant for discounted surplus food. Answer in under 300 characters, plain text.
Only use these live listings; never invent items, prices or health/allergen guarantees (say "check with the store" for allergies).
Listings: ${JSON.stringify(deals)}
User: ${text}
Return JSON {"reply": string}.` }]);
    return say(m.spaceId, String(out.reply || '').slice(0, 480) || 'Reply RESERVE to hold the latest deal.', m.id);
  } catch { return say(m.spaceId, 'Reply RESERVE to hold the latest deal, or STOP to opt out.', m.id); }
}

module.exports = { init, start, alertListing, notifyUser, status, uid: () => crypto.randomUUID() };
