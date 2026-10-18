// Creates a devnet payer + one wallet per store, saves store wallets to the DB, and prints .env lines.
// Usage: npm run solana:setup   (then fund the payer at https://faucet.solana.com, devnet)
try { require('dotenv').config(); } catch {}
const w3 = require('@solana/web3.js');
const bs58 = require('bs58').default || require('bs58');
const { db } = require('../src/db');
require('../src/seed').seed();

let payer;
if (process.env.SOLANA_PAYER_SECRET) payer = w3.Keypair.fromSecretKey(bs58.decode(process.env.SOLANA_PAYER_SECRET));
else payer = w3.Keypair.generate();
for (const s of db.prepare('SELECT id, name FROM stores').all()) {
  const kp = w3.Keypair.generate();
  db.prepare('UPDATE stores SET solana_wallet = ? WHERE id = ?').run(kp.publicKey.toBase58(), s.id);
  console.log(`${s.name.padEnd(24)} wallet ${kp.publicKey.toBase58()}`);
}
console.log('\nPayer address (fund this with devnet SOL at https://faucet.solana.com):\n  ' + payer.publicKey.toBase58());
if (!process.env.SOLANA_PAYER_SECRET) console.log('\nAdd to .env:\nSOLANA_PAYER_SECRET=' + bs58.encode(payer.secretKey));
console.log('\nNote: "Reset demo data" re-seeds fake wallets — run this script again after a reset.');
