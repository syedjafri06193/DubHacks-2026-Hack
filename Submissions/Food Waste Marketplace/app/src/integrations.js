// Live sponsor integrations. Each is used only when its env vars are set; otherwise the mock in
// adapters.js runs, and a failing live call falls back to the mock (AUTO_FALLBACK).
const crypto = require('node:crypto');

const env = k => process.env[k];

// ---------------------------------------------------------------- Perceptron (vision)
// Option A: event-provided endpoint (OpenAI-compatible chat completions) via PERCEPTRON_URL + PERCEPTRON_API_KEY.
// Option B: Perceptron Isaac hosted on fal.ai via FAL_KEY.
const VISION_PROMPT = 'Identify every distinct food item in this photo and count how many of each. ' +
  'Reply with JSON only: {"items":[{"name":"croissant","qty":6,"confidence":0.9}]}. Use short singular names.';

function parseItemsJson(text) {
  const m = String(text).match(/\{[\s\S]*\}/);
  if (!m) throw new Error('vision: no JSON in model output');
  const j = JSON.parse(m[0]);
  if (!Array.isArray(j.items)) throw new Error('vision: missing items');
  return j.items;
}

const perceptron = {
  available: () => !!((env('PERCEPTRON_URL') && env('PERCEPTRON_API_KEY')) || env('FAL_KEY')),
  async detect({ buffer, mimetype }) {
    if (!buffer) throw new Error('vision: no photo (demo preset)');
    const dataUri = `data:${mimetype || 'image/jpeg'};base64,${buffer.toString('base64')}`;
    if (env('PERCEPTRON_URL')) {
      const r = await fetch(env('PERCEPTRON_URL'), {
        method: 'POST', signal: AbortSignal.timeout(15000),
        headers: { authorization: `Bearer ${env('PERCEPTRON_API_KEY')}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          model: env('PERCEPTRON_MODEL') || 'isaac-0.1',
          messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: dataUri } }, { type: 'text', text: VISION_PROMPT }] }],
        }),
      });
      if (!r.ok) throw new Error(`Perceptron HTTP ${r.status}: ${(await r.text()).slice(0, 200)}`);
      const j = await r.json();
      return { items: parseItemsJson(j.choices?.[0]?.message?.content ?? j.output ?? JSON.stringify(j)), provider: 'perceptron' };
    }
    const r = await fetch('https://fal.run/perceptron/isaac-01', {
      method: 'POST', signal: AbortSignal.timeout(30000),
      headers: { authorization: `Key ${env('FAL_KEY')}`, 'content-type': 'application/json' },
      body: JSON.stringify({ image_url: dataUri, prompt: VISION_PROMPT, response_style: 'text' }),
    });
    if (!r.ok) throw new Error(`Perceptron (fal) HTTP ${r.status}: ${(await r.text()).slice(0, 200)}`);
    const j = await r.json();
    return { items: parseItemsJson(j.output), provider: 'perceptron-isaac' };
  },
};

// ---------------------------------------------------------------- Visa (CyberSource REST, sandbox)
// Env: CYBS_MERCHANT_ID, CYBS_KEY_ID, CYBS_SECRET (base64 shared secret). CYBS_HOST defaults to sandbox.
function cybsHeaders(method, path, body) {
  const host = env('CYBS_HOST') || 'apitest.cybersource.com';
  const date = new Date().toUTCString();
  const digest = 'SHA-256=' + crypto.createHash('sha256').update(body).digest('base64');
  const mid = env('CYBS_MERCHANT_ID');
  const sigString = `host: ${host}\ndate: ${date}\nrequest-target: ${method} ${path}\ndigest: ${digest}\nv-c-merchant-id: ${mid}`;
  const signature = crypto.createHmac('sha256', Buffer.from(env('CYBS_SECRET'), 'base64')).update(sigString).digest('base64');
  return {
    host, date, digest, 'v-c-merchant-id': mid, 'content-type': 'application/json',
    signature: `keyid="${env('CYBS_KEY_ID')}", algorithm="HmacSHA256", headers="host date request-target digest v-c-merchant-id", signature="${signature}"`,
  };
}
const visa = {
  available: () => !!(env('CYBS_MERCHANT_ID') && env('CYBS_KEY_ID') && env('CYBS_SECRET')),
  async charge({ reservationId, amountCents, token, card = {}, buyer = {} }) {
    const [mm, yy] = String(card.exp || '12/28').split('/').map(s => s.trim());
    const body = JSON.stringify({
      clientReferenceInformation: { code: reservationId },
      processingInformation: { capture: true },
      paymentInformation: { card: {
        number: String(token || '').replace(/\D/g, ''), expirationMonth: mm.padStart(2, '0'),
        expirationYear: yy.length === 2 ? `20${yy}` : yy, securityCode: String(card.cvc || '123'),
      } },
      orderInformation: {
        amountDetails: { totalAmount: (amountCents / 100).toFixed(2), currency: 'USD' },
        billTo: { firstName: (buyer.name || 'Demo').split(' ')[0], lastName: 'Buyer', address1: '1 Main St', locality: 'Seattle',
          administrativeArea: 'WA', postalCode: '98105', country: 'US', email: buyer.email || 'buyer@example.com' },
      },
    });
    const path = '/pts/v2/payments';
    const r = await fetch(`https://${env('CYBS_HOST') || 'apitest.cybersource.com'}${path}`, {
      method: 'POST', headers: cybsHeaders('post', path, body), body, signal: AbortSignal.timeout(15000),
    });
    const j = await r.json().catch(() => ({}));
    if (r.status >= 500 || r.status === 401) throw new Error(`CyberSource HTTP ${r.status}: ${JSON.stringify(j).slice(0, 200)}`);
    const ok = j.status === 'AUTHORIZED';
    return { ok, txnId: j.id || `cybs_${reservationId}`, status: ok ? 'approved' : 'declined', raw: j.status };
  },
};

// ---------------------------------------------------------------- Solana (devnet payouts)
// Env: SOLANA_PAYER_SECRET (base58 secret key), SOL_USD (price used to convert cents → SOL, default 150),
// SOLANA_RPC (default devnet). Store wallets must be real public keys — run `npm run solana:setup`.
let sol;
function solanaLib() {
  if (!sol) {
    const w3 = require('@solana/web3.js');
    const bs58 = require('bs58').default || require('bs58');
    sol = { w3, conn: new w3.Connection(env('SOLANA_RPC') || w3.clusterApiUrl('devnet'), 'confirmed'),
      payer: w3.Keypair.fromSecretKey(bs58.decode(env('SOLANA_PAYER_SECRET'))) };
  }
  return sol;
}
const solana = {
  available: () => !!env('SOLANA_PAYER_SECRET'),
  async send({ wallet, amountCents }) {
    const { w3, conn, payer } = solanaLib();
    const lamports = Math.max(5000, Math.round((amountCents / 100) / Number(env('SOL_USD') || 150) * w3.LAMPORTS_PER_SOL));
    const tx = new w3.Transaction().add(w3.SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: new w3.PublicKey(wallet), lamports }));
    const signature = await w3.sendAndConfirmTransaction(conn, tx, [payer]);
    const cluster = (env('SOLANA_RPC') || '').includes('mainnet') ? '' : '?cluster=devnet';
    return { signature, explorerUrl: `https://explorer.solana.com/tx/${signature}${cluster}`, lamports };
  },
};

// ---------------------------------------------------------------- Backboard (buyer memory)
// Env: BACKBOARD_API_KEY, optional BACKBOARD_ASSISTANT_ID (auto-created and cached otherwise).
const BB = 'https://app.backboard.io/api';
let bbAssistant = null;
async function bbFetch(path, init = {}) {
  const r = await fetch(`${BB}${path}`, { ...init, signal: AbortSignal.timeout(8000),
    headers: { 'X-API-Key': env('BACKBOARD_API_KEY'), 'content-type': 'application/json', ...(init.headers || {}) } });
  if (!r.ok) throw new Error(`Backboard HTTP ${r.status}: ${(await r.text()).slice(0, 200)}`);
  return r.status === 204 ? {} : r.json();
}
async function bbAssistantId(db) {
  if (bbAssistant) return bbAssistant;
  if (env('BACKBOARD_ASSISTANT_ID')) return (bbAssistant = env('BACKBOARD_ASSISTANT_ID'));
  db.exec('CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT)');
  const row = db.prepare("SELECT v FROM kv WHERE k='backboard_assistant'").get();
  if (row) return (bbAssistant = row.v);
  const a = await bbFetch('/assistants', { method: 'POST', body: JSON.stringify({
    name: 'Last Call buyer memory',
    system_prompt: 'You remember food-rescue buyers: diet, budget, favourite stores, pickup habits and past purchases.',
  }) });
  db.prepare("INSERT OR REPLACE INTO kv VALUES ('backboard_assistant', ?)").run(a.assistant_id);
  return (bbAssistant = a.assistant_id);
}
function localPrefs(db, userId) {
  const row = db.prepare('SELECT data FROM preferences WHERE user_id = ?').get(userId);
  return row ? JSON.parse(row.data) : null;
}
function saveLocal(db, userId, prefs) {
  db.prepare(`INSERT INTO preferences (user_id, data, updated_at) VALUES (?, ?, ?)
    ON CONFLICT(user_id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at`).run(userId, JSON.stringify(prefs), Date.now());
}
const backboard = {
  available: () => !!env('BACKBOARD_API_KEY'),
  async get({ db, userId }) {
    const id = await bbAssistantId(db);
    const res = await bbFetch(`/assistants/${id}/memories/search`, { method: 'POST',
      body: JSON.stringify({ query: `food preferences and purchase history of buyer ${userId}`, limit: 20 }) });
    const mine = (res.memories || []).filter(m => (m.metadata?.user_id || '') === userId);
    const prefMem = mine.filter(m => m.metadata?.kind === 'prefs')
      .sort((a, b) => String(b.created_at || '').localeCompare(String(a.created_at || '')))[0];
    let prefs = localPrefs(db, userId);
    if (prefMem) { try { prefs = { ...prefs, ...JSON.parse(String(prefMem.content).replace(/^[^{]*/, '')) }; } catch {} }
    const history = mine.filter(m => m.metadata?.kind === 'purchase').map(m => m.content);
    return { prefs: prefs ? { ...prefs, memory: history.slice(0, 10) } : null };
  },
  async put({ db, userId, prefs }) {
    saveLocal(db, userId, prefs); // write-through so ranking still works if Backboard is slow
    const id = await bbAssistantId(db);
    await bbFetch(`/assistants/${id}/memories`, { method: 'POST',
      body: JSON.stringify({ content: `Buyer ${userId} preferences: ${JSON.stringify(prefs)}`, metadata: { user_id: userId, kind: 'prefs' } }) });
    return { prefs };
  },
  async remember({ db, userId, text, metadata = {} }) {
    const id = await bbAssistantId(db);
    await bbFetch(`/assistants/${id}/memories`, { method: 'POST',
      body: JSON.stringify({ content: text, metadata: { user_id: userId, kind: 'purchase', ...metadata } }) });
    return {};
  },
};

// ---------------------------------------------------------------- Tiger Data (impact metrics hypertable)
// Env: DATABASE_URL (Tiger Data / Timescale connection string). App tables stay local; every impact event
// is mirrored into a Timescale hypertable and the dashboard reads aggregates from it.
let pgPool;
const tiger = {
  available: () => !!env('DATABASE_URL'),
  pool() {
    if (!pgPool) {
      const { Pool } = require('pg');
      pgPool = new Pool({ connectionString: env('DATABASE_URL'), ssl: { rejectUnauthorized: false }, max: 4 });
    }
    return pgPool;
  },
  async init(sqliteDb) {
    const p = tiger.pool();
    await p.query(`CREATE TABLE IF NOT EXISTS impact_events (
      ts timestamptz NOT NULL, store_id text NOT NULL, store_name text, reservation_id text,
      meals_saved int NOT NULL, kg_saved numeric NOT NULL, co2e_kg numeric NOT NULL, cents_recovered int NOT NULL)`);
    try { await p.query(`SELECT create_hypertable('impact_events', 'ts', if_not_exists => TRUE)`); }
    catch (e) { console.warn('[tiger] hypertable:', e.message); }
    try {
      await p.query(`CREATE MATERIALIZED VIEW IF NOT EXISTS impact_daily WITH (timescaledb.continuous) AS
        SELECT time_bucket('1 day', ts) AS day, store_id, sum(meals_saved) AS meals, sum(kg_saved) AS kg,
               sum(co2e_kg) AS co2e, sum(cents_recovered) AS cents FROM impact_events GROUP BY day, store_id WITH NO DATA`);
      await p.query(`SELECT add_continuous_aggregate_policy('impact_daily', start_offset => INTERVAL '30 days',
        end_offset => INTERVAL '1 minute', schedule_interval => INTERVAL '1 minute', if_not_exists => TRUE)`);
    } catch (e) { console.warn('[tiger] continuous aggregate:', e.message); }
    const { rows } = await p.query('SELECT count(*)::int AS n FROM impact_events');
    if (!rows[0].n) { // backfill seeded history once
      const all = sqliteDb.prepare('SELECT e.*, s.name store_name FROM impact_events e JOIN stores s ON s.id = e.store_id').all();
      for (const e of all) await tiger.insert(e);
    }
  },
  async insert(e) {
    await tiger.pool().query(`INSERT INTO impact_events VALUES (to_timestamp($1 / 1000.0), $2, $3, $4, $5, $6, $7, $8)`,
      [e.ts, e.store_id, e.store_name || null, e.reservation_id || null, e.meals_saved, e.kg_saved, e.co2e_kg, e.cents_recovered]);
  },
  async summary(storeId) {
    const p = tiger.pool(); const args = storeId ? [storeId] : [];
    const where = storeId ? 'WHERE store_id = $1' : '';
    const t = (await p.query(`SELECT coalesce(sum(meals_saved),0)::int meals, coalesce(sum(kg_saved),0)::float kg,
      coalesce(sum(co2e_kg),0)::float co2e, coalesce(sum(cents_recovered),0)::int cents, count(*)::int pickups FROM impact_events ${where}`, args)).rows[0];
    const daily = (await p.query(`SELECT to_char(time_bucket('1 day', ts, 'America/Los_Angeles'), 'YYYY-MM-DD') AS day,
      sum(meals_saved)::int meals, sum(cents_recovered)::int cents FROM impact_events ${where}
      GROUP BY 1 ORDER BY 1 DESC LIMIT 14`, args)).rows.reverse();
    const by_store = (await p.query(`SELECT store_id id, max(store_name) AS name, sum(meals_saved)::int meals, sum(cents_recovered)::int cents
      FROM impact_events GROUP BY store_id ORDER BY meals DESC`)).rows;
    return { totals: { ...t, kg: +t.kg.toFixed(1), co2e: +t.co2e.toFixed(1) }, daily, by_store };
  },
};

// ---------------------------------------------------------------- Photon 2.0 (iMessage / SMS agent)
// Env: PHOTON_API_KEY (project key pho_sk_...), PHOTON_PROJECT_ID, PHOTON_AGENT_USER_ID (your agent's user id,
// used as senderId), optional PHOTON_PLATFORM (imessage | sms | whatsapp ...).
// Flow: buyer texts the agent "JOIN priya" once → that conversation (Space) is linked to the buyer.
// Deal alerts go to that Space; buyer replies RESERVE / STOP / any question (answered by Gemini).
let photonClient;
async function photonSdk() {
  if (!photonClient) {
    const { Photon } = await import('@photon-ai/api');
    photonClient = new Photon({ headers: { Authorization: `Bearer ${env('PHOTON_API_KEY')}` } });
  }
  return photonClient;
}
const photon = {
  available: () => !!(env('PHOTON_API_KEY') && env('PHOTON_PROJECT_ID')),
  async send({ spaceId, text, parentMessageId, senderId }) {
    const p = await photonSdk();
    return p.projects.sendMessage({
      path: { id: env('PHOTON_PROJECT_ID') },
      headers: { 'idempotency-key': crypto.randomUUID() },
      body: { spaceId, senderId: senderId || env('PHOTON_AGENT_USER_ID'), ...(parentMessageId ? { parentMessageId } : {}),
        content: { type: 'text', format: 'plain', text } },
    });
  },
  async poll(since) {
    const p = await photonSdk();
    const out = []; let pageToken;
    do {
      const page = await p.projects.listMessages({ path: { id: env('PHOTON_PROJECT_ID') },
        query: { createdSince: since, direction: 'received', order: 'asc', pageSize: 100, ...(env('PHOTON_PLATFORM') ? { platform: env('PHOTON_PLATFORM') } : {}), ...(pageToken ? { pageToken } : {}) } });
      out.push(...page.items); pageToken = page.nextPageToken;
    } while (pageToken);
    return out;
  },
};

module.exports = { perceptron, visa, solana, backboard, tiger, photon };
