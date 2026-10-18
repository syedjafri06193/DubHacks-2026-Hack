// Seed realistic demo data (design doc §11.2): stores near UW, demo users, live listings, a week of impact.
const { db, uuid } = require('./db');
const { clampDiscount, priceFor, minutesToClose } = require('./pricing');
const { itemCents } = require('./adapters');

function seed({ force = false } = {}) {
  const n = db.prepare('SELECT count(*) c FROM stores').get().c;
  if (n && !force) return false;
  if (force) for (const t of ['impact_events', 'jobs', 'payments', 'reservations', 'listings', 'preferences', 'users', 'stores']) db.exec(`DELETE FROM ${t}`);

  const now = Date.now();
  const stores = [
    { id: 's-bakery', name: 'Ave Street Bakery', type: 'bakery', address: '4310 University Way NE', lat: 47.6596, lng: -122.3131, closes_at: '21:00' },
    { id: 's-deli', name: 'Husky Corner Deli', type: 'deli', address: '1415 NE 45th St', lat: 47.6612, lng: -122.3125, closes_at: '22:00' },
    { id: 's-sushi', name: 'Fremont Roll House', type: 'sushi bar', address: '3509 Fremont Ave N', lat: 47.6510, lng: -122.3505, closes_at: '22:30' },
  ];
  const insStore = db.prepare(`INSERT INTO stores VALUES (?,?,?,?,?,?,?,?,?,?,?)`);
  for (const s of stores) insStore.run(s.id, s.name, s.type, s.address, s.lat, s.lng, s.closes_at, 'America/Los_Angeles',
    `${s.id.slice(2, 6).toUpperCase()}devnet${Math.random().toString(36).slice(2, 10)}Wa11et`, `vmr_${s.id}`, now);

  const insUser = db.prepare(`INSERT INTO users VALUES (?,?,?,?,?,?,?)`);
  insUser.run('u-maya', 'seller', 'Maya (Ave Street Bakery)', 'maya@example.com', 's-bakery', null, now);
  insUser.run('u-omar', 'seller', 'Omar (Husky Corner Deli)', 'omar@example.com', 's-deli', null, now);
  insUser.run('u-kenji', 'seller', 'Kenji (Fremont Roll House)', 'kenji@example.com', 's-sushi', null, now);
  insUser.run('u-priya', 'buyer', 'Priya (student)', 'priya@example.com', null, 'bb-priya', now);
  insUser.run('u-sam', 'buyer', 'Sam (commuter)', 'sam@example.com', null, 'bb-sam', now);

  db.prepare(`INSERT INTO preferences VALUES (?,?,?)`).run('u-priya', JSON.stringify({ diet: ['vegetarian'], max_price_cents: 3000, radius_km: 3, favourite_stores: ['s-bakery'], lat: 47.6553, lng: -122.3035 }), now);
  db.prepare(`INSERT INTO preferences VALUES (?,?,?)`).run('u-sam', JSON.stringify({ diet: [], max_price_cents: 2500, radius_km: 6, favourite_stores: [], lat: 47.6553, lng: -122.3035 }), now);

  const insListing = db.prepare(`INSERT INTO listings (id, store_id, title, description, items, tags, photo_url, original_cents, price_cents,
    discount_pct, qty_total, qty_available, pickup_until, status, ai_meta, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  const L = (store, title, desc, items, tags, photo, qty, hoursLeft) => {
    const s = stores.find(x => x.id === store);
    const original = items.reduce((a, i) => a + itemCents(i.name) * i.qty, 0);
    const disc = clampDiscount(undefined, minutesToClose(s.closes_at, 'America/Los_Angeles'));
    insListing.run(uuid(), store, title, desc, JSON.stringify(items), JSON.stringify(tags), photo, original, priceFor(original, disc),
      disc, qty, qty, now + hoursLeft * 3600e3, 'active', JSON.stringify({ seeded: true }), now - 20 * 60e3);
  };
  L('s-bakery', 'Pastry box: 6 croissants + 4 muffins', "Baked this morning, still flaky. Great for tomorrow's breakfast.",
    [{ name: 'croissant', qty: 6, confidence: 0.93 }, { name: 'blueberry muffin', qty: 4, confidence: 0.88 }],
    ['vegetarian', 'contains-gluten', 'contains-dairy'], '/demo/pastry.svg', 2, 2.5);
  L('s-deli', 'Deli rescue: 3 turkey sandwiches + 2 veggie wraps', 'Made fresh at lunch; best enjoyed tonight.',
    [{ name: 'turkey sandwich', qty: 3, confidence: 0.9 }, { name: 'veggie wrap', qty: 2, confidence: 0.86 }],
    ['contains-gluten'], '/demo/deli.svg', 3, 3);
  L('s-sushi', 'Chef\'s sushi set: 5 rolls', 'Rolled this afternoon. Pick up before close.',
    [{ name: 'sushi roll', qty: 5, confidence: 0.95 }], [], '/demo/sushi.svg', 4, 3.5);

  // A week of history so the impact dashboard has a shape.
  const ins = db.prepare(`INSERT INTO impact_events VALUES (?,?,?,?,?,?,?)`);
  for (let d = 7; d >= 1; d--) for (const s of stores) {
    const k = 1 + Math.floor(Math.random() * 4);
    for (let i = 0; i < k; i++) {
      const meals = 2 + Math.floor(Math.random() * 6);
      ins.run(now - d * 86400e3 + i * 3600e3, s.id, null, meals, +(meals * 0.4).toFixed(2), +(meals * 0.4 * 2.5).toFixed(2), meals * 180 + Math.floor(Math.random() * 300));
    }
  }
  return true;
}

module.exports = { seed };
if (require.main === module) { seed({ force: true }); console.log('Seeded demo data.'); }
