// SQLite stand-in for Tiger Data (Postgres). Schema mirrors the design doc §4:
// money in integer cents, times in epoch ms (UTC), status values checked at write time.
const { DatabaseSync } = require('node:sqlite');
const crypto = require('node:crypto');
const path = require('node:path');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, '..', 'data.db');
const db = new DatabaseSync(DB_PATH);
db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');

db.exec(`
CREATE TABLE IF NOT EXISTS stores (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, type TEXT NOT NULL, address TEXT NOT NULL,
  lat REAL NOT NULL, lng REAL NOT NULL, closes_at TEXT NOT NULL, timezone TEXT NOT NULL,
  solana_wallet TEXT NOT NULL, visa_merchant_ref TEXT NOT NULL, created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY, role TEXT NOT NULL CHECK (role IN ('buyer','seller')), name TEXT NOT NULL,
  email TEXT NOT NULL, store_id TEXT REFERENCES stores(id), backboard_user_id TEXT, created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS preferences (
  user_id TEXT PRIMARY KEY REFERENCES users(id), data TEXT NOT NULL, updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS listings (
  id TEXT PRIMARY KEY, store_id TEXT NOT NULL REFERENCES stores(id), title TEXT NOT NULL,
  description TEXT NOT NULL, items TEXT NOT NULL, tags TEXT NOT NULL, photo_url TEXT,
  original_cents INTEGER NOT NULL CHECK (original_cents > 0),
  price_cents INTEGER NOT NULL CHECK (price_cents > 0 AND price_cents <= original_cents),
  discount_pct INTEGER NOT NULL, qty_total INTEGER NOT NULL CHECK (qty_total > 0),
  qty_available INTEGER NOT NULL CHECK (qty_available >= 0), pickup_until INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','sold_out','expired','withdrawn')),
  ai_meta TEXT, created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS listings_active ON listings (status, pickup_until);
CREATE TABLE IF NOT EXISTS reservations (
  id TEXT PRIMARY KEY, listing_id TEXT NOT NULL REFERENCES listings(id), buyer_id TEXT NOT NULL REFERENCES users(id),
  qty INTEGER NOT NULL CHECK (qty > 0), total_cents INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending','paid','picked_up','cancelled')),
  hold_expires_at INTEGER NOT NULL, pickup_code TEXT NOT NULL, idempotency_key TEXT,
  created_at INTEGER NOT NULL, paid_at INTEGER, picked_up_at INTEGER,
  UNIQUE (buyer_id, idempotency_key)
);
CREATE TABLE IF NOT EXISTS payments (
  id TEXT PRIMARY KEY, reservation_id TEXT NOT NULL UNIQUE REFERENCES reservations(id),
  visa_txn_id TEXT, visa_status TEXT, payout_cents INTEGER, solana_sig TEXT, explorer_url TEXT,
  payout_status TEXT NOT NULL DEFAULT 'queued', created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS jobs (
  id TEXT PRIMARY KEY, kind TEXT NOT NULL, payload TEXT NOT NULL, run_at INTEGER NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0, last_error TEXT, done_at INTEGER
);
CREATE TABLE IF NOT EXISTS impact_events (
  ts INTEGER NOT NULL, store_id TEXT NOT NULL, reservation_id TEXT,
  meals_saved INTEGER NOT NULL, kg_saved REAL NOT NULL, co2e_kg REAL NOT NULL, cents_recovered INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS impact_ts ON impact_events (ts);
`);

const uuid = () => crypto.randomUUID();

function tx(fn) {
  db.exec('BEGIN IMMEDIATE');
  try { const r = fn(); db.exec('COMMIT'); return r; }
  catch (e) { db.exec('ROLLBACK'); throw e; }
}

module.exports = { db, uuid, tx };
