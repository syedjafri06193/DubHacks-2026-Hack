// Design doc §7: every sponsor sits behind an adapter with a live and a mock implementation.
// MOCK_<NAME>=0 selects live (when its key is present); AUTO_FALLBACK (default on) drops to the
// mock if a live call throws. Status is surfaced on GET /api/v1/health.
const crypto = require('node:crypto');
const { band } = require('./pricing');

const AUTO_FALLBACK = process.env.AUTO_FALLBACK !== '0';
const status = {}; // name -> { mode, lastFallback }

// Typical full price per item (cents) and dietary tags, used by mocks and to price live detections.
const CATALOG = {
  croissant: { cents: 425, tags: ['vegetarian', 'contains-gluten', 'contains-dairy'], kind: 'bakery' },
  'blueberry muffin': { cents: 375, tags: ['vegetarian', 'contains-gluten', 'contains-dairy'], kind: 'bakery' },
  bagel: { cents: 300, tags: ['vegan', 'vegetarian', 'contains-gluten'], kind: 'bread' },
  'sourdough loaf': { cents: 900, tags: ['vegan', 'vegetarian', 'contains-gluten'], kind: 'bread' },
  'turkey sandwich': { cents: 1050, tags: ['contains-gluten'], kind: 'perishable' },
  'veggie wrap': { cents: 950, tags: ['vegetarian', 'contains-gluten'], kind: 'perishable' },
  'green salad': { cents: 1100, tags: ['vegan', 'vegetarian'], kind: 'perishable' },
  'sushi roll': { cents: 1200, tags: [], kind: 'perishable' },
  'almond cookie': { cents: 250, tags: ['vegetarian', 'contains-gluten', 'contains-nuts'], kind: 'bakery' },
  'banana bread slice': { cents: 400, tags: ['vegetarian', 'contains-gluten', 'contains-nuts'], kind: 'bakery' },
};
const SYNONYMS = { croissants: 'croissant', muffin: 'blueberry muffin', muffins: 'blueberry muffin', bagels: 'bagel',
  sandwich: 'turkey sandwich', sandwiches: 'turkey sandwich', wrap: 'veggie wrap', salad: 'green salad',
  sushi: 'sushi roll', cookie: 'almond cookie', cookies: 'almond cookie', bread: 'sourdough loaf', loaf: 'sourdough loaf' };

function normaliseName(n) {
  const k = String(n).toLowerCase().trim();
  return SYNONYMS[k] || k;
}

// §6.1 step 2: drop low-confidence items, merge synonyms.
function normaliseItems(items) {
  const merged = {};
  for (const it of items) {
    if ((it.confidence ?? 1) < 0.5) continue;
    const name = normaliseName(it.name);
    if (!merged[name]) merged[name] = { name, qty: 0, confidence: it.confidence ?? 1 };
    merged[name].qty += Math.max(1, Math.round(it.qty || 1));
    merged[name].confidence = Math.max(merged[name].confidence, it.confidence ?? 1);
  }
  return Object.values(merged);
}

function itemCents(name) { return (CATALOG[name] || { cents: 500 }).cents; }

function pick(name, live, mock) {
  const wantLive = process.env[`MOCK_${name.toUpperCase()}`] === '0' && live.available();
  status[name] = { mode: wantLive ? 'live' : 'mock', lastFallback: status[name]?.lastFallback || null };
  return new Proxy({}, {
    get(_, method) {
      return async (...args) => {
        if (!wantLive) return { ...(await mock[method](...args)), _source: 'mock' };
        try { return { ...(await live[method](...args)), _source: 'live' }; }
        catch (e) {
          if (!AUTO_FALLBACK) throw e;
          status[name].lastFallback = { at: new Date().toISOString(), error: String(e.message || e) };
          console.warn(`[${name}] live call failed, using mock:`, e.message);
          return { ...(await mock[method](...args)), _source: 'mock-fallback' };
        }
      };
    },
  });
}

// ---------- Gemini (live) ----------
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-2.5-flash';
async function gemini(parts, { timeoutMs = 8000 } = {}) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${process.env.GEMINI_API_KEY}`, {
      method: 'POST', signal: ctl.signal, headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ contents: [{ parts }], generationConfig: { responseMimeType: 'application/json', temperature: 0.4 } }),
    });
    if (!r.ok) throw new Error(`Gemini HTTP ${r.status}`);
    const j = await r.json();
    return JSON.parse(j.candidates[0].content.parts[0].text);
  } finally { clearTimeout(t); }
}
const hasGemini = () => !!process.env.GEMINI_API_KEY;

// ---------- Vision (Perceptron) ----------
// Live: Perceptron if configured; otherwise Gemini vision is used as the live detector.
const visionLive = {
  available: () => !!process.env.PERCEPTRON_API_KEY || hasGemini(),
  async detect({ buffer, mimetype }) {
    if (process.env.PERCEPTRON_API_KEY && process.env.PERCEPTRON_URL) {
      const r = await fetch(process.env.PERCEPTRON_URL, {
        method: 'POST', headers: { authorization: `Bearer ${process.env.PERCEPTRON_API_KEY}`, 'content-type': mimetype },
        body: buffer, signal: AbortSignal.timeout(6000),
      });
      if (!r.ok) throw new Error(`Perceptron HTTP ${r.status}`);
      return { items: (await r.json()).items };
    }
    const out = await gemini([
      { text: 'List the distinct food items visible with counts. JSON: {"items":[{"name":string,"qty":int,"confidence":0..1}]}. Use simple singular names like "croissant".' },
      { inline_data: { mime_type: mimetype, data: buffer.toString('base64') } },
    ], { timeoutMs: 6000 });
    return { items: out.items };
  },
};
const PRESETS = {
  pastry: [{ name: 'croissant', qty: 6, confidence: 0.93 }, { name: 'blueberry muffin', qty: 4, confidence: 0.88 }],
  bagel: [{ name: 'bagels', qty: 6, confidence: 0.91 }, { name: 'sourdough loaf', qty: 1, confidence: 0.84 }],
  deli: [{ name: 'turkey sandwich', qty: 3, confidence: 0.9 }, { name: 'veggie wrap', qty: 2, confidence: 0.86 }, { name: 'green salad', qty: 2, confidence: 0.42 }],
  sushi: [{ name: 'sushi roll', qty: 5, confidence: 0.95 }],
};
const visionMock = {
  async detect({ originalname = '', hint }) {
    const key = hint || Object.keys(PRESETS).find(k => originalname.toLowerCase().includes(k))
      || Object.keys(CATALOG).map(n => n.split(' ').pop()).find(w => originalname.toLowerCase().includes(w));
    if (PRESETS[key]) return { items: PRESETS[key] };
    const hit = Object.keys(CATALOG).find(n => key && n.includes(key));
    if (hit) return { items: [{ name: hit, qty: 4, confidence: 0.8 }] };
    return { items: [{ name: 'croissant', qty: 3, confidence: 0.7 }, { name: 'almond cookie', qty: 6, confidence: 0.7 }] };
  },
};

// ---------- Listing writer (Gemini) ----------
const TAGS = ['vegetarian', 'vegan', 'contains-gluten', 'contains-dairy', 'contains-nuts'];
function tagsFor(items) {
  const all = items.map(i => (CATALOG[i.name] || { tags: [] }).tags);
  const tags = new Set(all.flat().filter(t => t.startsWith('contains-')));
  if (all.length && all.every(t => t.includes('vegetarian'))) tags.add('vegetarian');
  if (all.length && all.every(t => t.includes('vegan'))) tags.add('vegan');
  return [...tags];
}
const plural = (n, w) => n > 1 ? `${n} ${w.endsWith('loaf') ? w.slice(0, -1) + 'ves' : w.endsWith('s') ? w : w + 's'}` : `1 ${w}`;
const listingMock = {
  async write({ items, minutes }) {
    const b = band(minutes);
    const perishable = items.some(i => CATALOG[i.name]?.kind === 'perishable');
    const bread = items.every(i => CATALOG[i.name]?.kind === 'bread');
    const top = [...items].sort((a, b2) => b2.qty - a.qty).slice(0, 2);
    const title = `Evening rescue box: ${top.map(i => plural(i.qty, i.name)).join(' + ')}`.slice(0, 60);
    const description = (perishable ? 'Made fresh today and best enjoyed tonight.' : bread
      ? 'Baked this morning; toasts beautifully tomorrow.' : 'Baked this morning, still lovely. Great for tomorrow\'s breakfast.') + ' Bring a bag!';
    const mid = Math.round((b.floor + b.ceiling) / 2);
    return { title, description: description.slice(0, 160), tags: tagsFor(items), discount_pct: perishable ? b.ceiling - 3 : bread ? b.floor + 2 : mid };
  },
};
const listingLive = {
  available: hasGemini,
  async write({ items, minutes, store, time, originalCents }) {
    const b = band(minutes);
    const prompt = `You write short, appetizing listings for surplus food sold at a discount.
Return JSON only: {"title","description","tags":[],"discount_pct"}.
Title max 60 chars. Description max 160 chars, no exaggeration, no health claims.
Tags from: ${TAGS.join(', ')}.
discount_pct must be between ${b.floor} and ${b.ceiling}.
Store: ${store.name} (${store.type}). Local time ${time}, closes in ${minutes} min.
Items: ${JSON.stringify(items)}. Original total price: $${(originalCents / 100).toFixed(2)}.`;
    let out;
    try { out = await gemini([{ text: prompt }]); } catch { out = await gemini([{ text: prompt }]); } // one retry
    if (typeof out.title !== 'string' || typeof out.description !== 'string') throw new Error('schema');
    return {
      title: out.title.slice(0, 60), description: out.description.slice(0, 160),
      tags: (out.tags || []).filter(t => TAGS.includes(t)), discount_pct: out.discount_pct, raw: out,
    };
  },
};

// ---------- Backboard (buyer memory) ----------
// Mock stores preferences in the local DB (passed in by the caller).
const memoryMock = {
  async get({ db, userId }) {
    const row = db.prepare('SELECT data FROM preferences WHERE user_id = ?').get(userId);
    return { prefs: row ? JSON.parse(row.data) : null };
  },
  async put({ db, userId, prefs }) {
    db.prepare(`INSERT INTO preferences (user_id, data, updated_at) VALUES (?, ?, ?)
      ON CONFLICT(user_id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at`)
      .run(userId, JSON.stringify(prefs), Date.now());
    return { prefs };
  },
};
const memoryLive = { available: () => !!process.env.BACKBOARD_API_KEY, get: memoryMock.get, put: memoryMock.put };

// ---------- Visa (checkout) ----------
// Sandbox test numbers: 4111 1111 1111 1111 approves, 4000 0000 0000 0002 declines.
const payMock = {
  async charge({ amountCents, token }) {
    await new Promise(r => setTimeout(r, 400));
    const digits = String(token || '').replace(/\D/g, '');
    const declined = digits === '4000000000000002' || amountCents <= 0;
    return { ok: !declined, txnId: `sbx_${crypto.randomBytes(6).toString('hex')}`, status: declined ? 'declined' : 'approved' };
  },
};
const payLive = { available: () => !!process.env.VISA_API_KEY, charge: payMock.charge };

// ---------- Solana (payouts, devnet) ----------
const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const fakeSig = () => Array.from(crypto.randomBytes(64), b => B58[b % 58]).join('').slice(0, 88);
const payoutMock = {
  async send() {
    await new Promise(r => setTimeout(r, 1200));
    const signature = fakeSig();
    return { signature, explorerUrl: `https://explorer.solana.com/tx/${signature}?cluster=devnet` };
  },
};
const payoutLive = { available: () => !!process.env.SOLANA_PAYER_SECRET, send: payoutMock.send };

const adapters = {
  vision: pick('perceptron', visionLive, visionMock),
  listing: pick('gemini', listingLive, listingMock),
  memory: pick('backboard', memoryLive, memoryMock),
  pay: pick('visa', payLive, payMock),
  payout: pick('solana', payoutLive, payoutMock),
};

module.exports = { adapters, status, normaliseItems, itemCents, CATALOG, PRESETS };
