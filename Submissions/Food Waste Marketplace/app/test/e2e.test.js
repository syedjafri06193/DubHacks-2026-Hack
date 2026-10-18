// End-to-end core loop (design doc §11.1): photo → listing → alert → reserve → pay → payout → pickup → impact.
const test = require('node:test');
const assert = require('node:assert');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');

process.env.PORT = '3999';
process.env.DB_PATH = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'lc-')), 'test.db');
const srv = require('../src/server');
const B = 'http://localhost:3999/api/v1';

async function login(id) {
  const r = await fetch(`${B}/auth/demo-login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ user_id: id }) });
  return r.headers.get('set-cookie').split(';')[0];
}
const call = (cookie, p, opts = {}) => fetch(`${B}${p}`, { ...opts, headers: { cookie, 'content-type': 'application/json', ...(opts.headers || {}) },
  body: opts.body && typeof opts.body !== 'string' && !(opts.body instanceof FormData) ? JSON.stringify(opts.body) : opts.body })
  .then(async r => ({ status: r.status, body: await r.json().catch(() => null) }));
const wait = ms => new Promise(r => setTimeout(r, ms));

test.after(() => srv.close());

test('full core loop', async () => {
  const seller = await login('u-maya'), buyer = await login('u-priya');
  await call(buyer, '/me/preferences', { method: 'PUT', body: { diet: ['vegetarian'], max_price_cents: 5000, radius_km: 3, favourite_stores: ['s-bakery'] } });

  // SSE: buyer listens for alerts
  const events = [];
  const ctl = new AbortController();
  fetch(`${B}/stream`, { headers: { cookie: buyer }, signal: ctl.signal }).then(async r => {
    const rd = r.body.getReader(); const dec = new TextDecoder();
    for (;;) { const { value, done } = await rd.read().catch(() => ({ done: true })); if (done) break; events.push(dec.decode(value)); }
  }).catch(() => {});
  await wait(200);

  // Draft from a demo photo (mock vision + mock Gemini)
  const fd = new FormData(); fd.append('preset', 'pastry');
  const draft = await fetch(`${B}/listings/draft`, { method: 'POST', headers: { cookie: seller }, body: fd }).then(r => r.json());
  assert.equal(draft.items.length, 2);
  assert.ok(draft.price_cents > 0 && draft.price_cents < draft.original_cents);
  assert.ok(draft.tags.includes('vegetarian'));

  // Server clamps prices: $0 listing is rejected
  const bad = await call(seller, '/listings', { method: 'POST', body: { ...draft, price_cents: 0, qty_total: 2 } });
  assert.equal(bad.status, 400);

  const pub = await call(seller, '/listings', { method: 'POST', body: { ...draft, qty_total: 2 } });
  assert.equal(pub.status, 201);
  const id = pub.body.id;
  await wait(1500);
  assert.ok(events.join('').includes('listing.new'), 'buyer received live alert');
  assert.ok(events.join('').includes('"match":true'), 'alert matched vegetarian prefs');

  const feed = await call(buyer, '/listings/nearby');
  assert.ok(feed.body.listings.some(l => l.id === id));

  // Reserve both, third reserve should fail sold_out
  const res = await call(buyer, '/reservations', { method: 'POST', body: { listing_id: id, qty: 2 } });
  assert.equal(res.status, 201);
  const sold = await call(await login('u-sam'), '/reservations', { method: 'POST', body: { listing_id: id, qty: 1 } });
  assert.equal(sold.status, 409); assert.equal(sold.body.error.code, 'sold_out');

  // Declined card, then approved; idempotent replay
  const dec = await call(buyer, `/reservations/${res.body.id}/pay`, { method: 'POST', headers: { 'idempotency-key': 'k1' }, body: { payment_token: '4000 0000 0000 0002' } });
  assert.equal(dec.status, 402);
  const paid = await call(buyer, `/reservations/${res.body.id}/pay`, { method: 'POST', headers: { 'idempotency-key': 'k2' }, body: { payment_token: '4111111111111111' } });
  assert.equal(paid.body.status, 'paid');
  const again = await call(buyer, `/reservations/${res.body.id}/pay`, { method: 'POST', headers: { 'idempotency-key': 'k2' }, body: { payment_token: '4111111111111111' } });
  assert.equal(again.body.replay, true);

  await wait(2500);
  const orders = await call(seller, '/orders');
  const o = orders.body.find(x => x.id === res.body.id);
  assert.equal(o.payment.payout_status, 'confirmed');
  assert.match(o.payment.explorer_url, /explorer\.solana\.com/);

  // Pickup via QR payload → impact
  const before = (await call(seller, '/impact/summary')).body.totals.meals;
  const pk = await call(seller, '/pickup', { method: 'POST', body: { code: `FWM:${o.id}:${paid.body.pickup_code}` } });
  assert.equal(pk.body.meals_saved, 20); // (6 + 4 items) × 2 boxes
  const after = (await call(seller, '/impact/summary')).body.totals.meals;
  assert.equal(after - before, 20);

  // Other seller cannot redeem or edit
  const other = await login('u-omar');
  assert.equal((await call(other, `/listings/${id}`, { method: 'PATCH', body: { status: 'withdrawn' } })).status, 403);

  const card = await fetch(`${B}/impact/card/s-bakery.svg`);
  assert.match(await card.text(), /meals/);
  ctl.abort();
});
