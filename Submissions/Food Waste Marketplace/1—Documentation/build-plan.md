# Last Call: Finishing Guide (all integrations)

Here's the order I'd do it in, with each step as small as possible. Each integration replaces one function in `src/adapters.js`, and the mocks stay as fallbacks so the demo never breaks.

Where I'm unsure of a sponsor's exact API (Perceptron, Backboard, nebulaONE, T-Mobile), I've said so. Check the hacker guide or the sponsor's booth for those, because their APIs may be hackathon-specific.

## Phase 0: Setup (about 30 min)

1. **Push the code to your repo.** Put it in `Submissions/Food Waste Marketplace/app/`, then commit and push.
2. **Create `.env`** in the project root, copying the variable names from the README.
3. **Load it at startup.** Run `npm i dotenv`, then add `require('dotenv').config()` as the first line of `src/server.js`.
4. **Collect your keys now**, since sandbox signups can take hours:
   - Gemini, from Google AI Studio.
   - Visa Acceptance (CyberSource) sandbox, from developer.cybersource.com.
   - Tiger Data, from console.cloud.timescale.com.
   - Vultr and GoDaddy accounts.
   - Backboard and Perceptron keys, from their sponsor booths.

## Phase 1: Gemini (about 15 min)

1. Add `GEMINI_API_KEY=...`, `MOCK_GEMINI=0` and `MOCK_PERCEPTRON=0` to `.env`.
2. Restart the server and list a food photo.
3. The review screen should now say "Listing: live" and "Vision: live". If not, check `/api/v1/health` for the fallback error.

## Phase 2: Tiger Data, replacing SQLite (2–3 h)

1. Create a Tiger Data service and copy its connection string into `DATABASE_URL`.
2. Run `npm i pg`.
3. Rewrite `src/db.js` so it uses a `pg` Pool and exposes the same `prepare().get/all/run`-style helpers.
   - Simplest approach: make each helper an async function, then add `await` at every call site in `server.js`.
4. Convert the schema to Postgres:
   - Use `uuid DEFAULT gen_random_uuid()`, `timestamptz` and Postgres enums, exactly as in design doc §4.2.
   - Replace `INTEGER` epoch-ms columns with `timestamptz`, and `Date.now()` with `now()`.
5. Set up the hypertable:
   - Run `SELECT create_hypertable('impact_events','ts');`.
   - Add the `impact_daily` continuous aggregate from the doc.
   - Point `impactSummary` at it, using `time_bucket` instead of SQLite's `date()`.
6. Use `SELECT ... FOR UPDATE` inside transactions:
   - In `/reservations`, lock the listing row.
   - In the worker, use `FOR UPDATE SKIP LOCKED` on `jobs` so that two workers never take the same job.
7. Run `npm test` and fix whatever breaks.

## Phase 3: Visa checkout (3–4 h; start this early)

1. In the CyberSource sandbox, create a REST shared-secret key and note your merchant ID, key ID and secret.
2. Tokenize the card in the browser with **Flex Microform**, so card numbers never touch your server.
   - Add `POST /api/v1/checkout/capture-context`, which calls CyberSource's `/microform/v2/sessions` and returns a capture context.
   - In `viewCheckout`, replace the card input with the Microform fields. On submit, call `microform.createToken()` and send that token as `payment_token`.
3. Rewrite `payLive.charge` to call the Payments API (`POST /pts/v2/payments`):
   - Send the transient token and the amount.
   - Set `processingInformation.capture: true`.
   - Use the reservation ID as `clientReferenceInformation.code`.
   - The `cybersource-rest-client` npm package handles HTTP-signature auth for you.
4. Map the response:
   - `AUTHORIZED` becomes `{ok:true, txnId:id, status:'approved'}`.
   - Anything else becomes `declined`.
5. Set `VISA_API_KEY` (or rename the check to `CYBS_MERCHANT_ID`) and `MOCK_VISA=0`.
6. Test with CyberSource's sandbox test cards.

## Phase 4: Solana payouts on devnet (1–2 h)

1. Run `npm i @solana/web3.js bs58`.
2. Create a payer wallet:
   - Run `solana-keygen new -o payer.json`.
   - Fund it with `solana airdrop 2 <pubkey> --url devnet`. If the faucet is rate-limited, use faucet.solana.com.
3. Put the secret key in base58 into `SOLANA_PAYER_SECRET`.
4. Create a real devnet keypair for each store and save its public key in `stores.solana_wallet`. The seeded fake addresses won't work.
5. Rewrite `payoutLive.send`:

```js
const { Connection, Keypair, PublicKey, SystemProgram, Transaction, sendAndConfirmTransaction, LAMPORTS_PER_SOL } = require('@solana/web3.js');
const bs58 = require('bs58');
const conn = new Connection('https://api.devnet.solana.com', 'confirmed');
const payer = Keypair.fromSecretKey(bs58.decode(process.env.SOLANA_PAYER_SECRET));
async send({ wallet, amountCents }) {
  const lamports = Math.round((amountCents / 100) / Number(process.env.SOL_USD || 150) * LAMPORTS_PER_SOL);
  const tx = new Transaction().add(SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: new PublicKey(wallet), lamports }));
  const signature = await sendAndConfirmTransaction(conn, tx, [payer]);
  return { signature, explorerUrl: `https://explorer.solana.com/tx/${signature}?cluster=devnet` };
}
```

6. Optionally, pay out in devnet USDC with `@solana/spl-token` instead. Stablecoin payouts pitch better.
7. Set `MOCK_SOLANA=0`, then pay for an order and click the explorer link. It should show a real transaction.

## Phase 5: Backboard memory (1–2 h, depends on their API)

1. Get the API docs and key from the Backboard sponsor.
2. Rewrite `memoryLive.get` and `memoryLive.put` to store and read the preference JSON per user, using `users.backboard_user_id`.
3. Store more than the form. When a buyer reserves, also write what they bought, for example "likes pastries, buys after 8pm". Use that in ranking, because it shows the memory doing something the preference form alone can't.
4. Keep a write-through to the local table so ranking still works if Backboard is slow.

## Phase 6: Perceptron vision (about 1 h)

1. Get the endpoint, key and response format from the Perceptron sponsor.
2. Set `PERCEPTRON_URL` and `PERCEPTRON_API_KEY`.
3. Adapt `visionLive.detect` so it maps their output to `[{name, qty, confidence}]`.
4. Resize photos before sending them, as design doc §6.1 specifies: `npm i sharp`, then `sharp(buf).resize(1280,1280,{fit:'inside'}).jpeg({quality:80})`.

## Phase 7: Real push alerts, the T-Mobile track (about 1.5 h)

1. Confirm the T-Mobile track requirement in the hacker guide. If they require a specific API, add it as another adapter.
2. Set up Web Push:
   - Run `npm i web-push`, then `npx web-push generate-vapid-keys`.
   - Put the keys in `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY` and `VAPID_SUBJECT=mailto:you@...`.
3. Add a `push_subscriptions` table and `POST /api/v1/push/subscribe`.
4. In the client, after notification permission is granted, call `reg.pushManager.subscribe({userVisibleOnly:true, applicationServerKey})` and POST the result.
5. In `sw.js`, add a `push` listener that calls `showNotification`.
6. In the `alert_fanout` job, call `webpush.sendNotification()` for matching buyers who aren't connected over SSE. Delete any subscriptions that return 410.
7. iPhone users must "Add to Home Screen" first (iOS 16.4+). Mention this in the demo.

## Phase 8: CloudForce nebulaONE (about 1 h)

1. Confirm nebulaONE's API in the hacker guide.
2. Add a `checkLive` adapter that runs after Gemini to verify allergen tags and tone (doc §6.1 step 4). Skip it if it times out.
3. Switch the impact card to PNG for social previews:
   - Run `npm i sharp`.
   - Use `sharp(Buffer.from(svg)).png()`.
   - Add an `og:image` meta tag to a share page.

## Phase 9: Production hardening (about 1 h)

1. Delete or protect `/admin/reset` with an `ADMIN_TOKEN`.
2. Set a strong `SESSION_SECRET` and add `Secure` to the session cookie.
3. Add rate limiting (`npm i express-rate-limit`) on login, draft and pay.
4. Store photos in Vultr Object Storage, which is S3-compatible (`@aws-sdk/client-s3`), instead of the local `uploads/` folder.
5. Run the worker as its own process (`node src/worker.js`) so that a server restart doesn't double-process jobs.

## Phase 10: Deploy on Vultr with GoDaddy (about 1 h; do the DNS part early)

1. On GoDaddy, buy the domain and add an **A record** pointing `@` to your Vultr server's IP. DNS can take up to an hour to update.
2. On Vultr, create an Ubuntu 24.04 server. 1 vCPU and 2 GB is enough.
3. Install the software:

```bash
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo bash - && sudo apt install -y nodejs caddy
git clone <repo> && cd app && npm ci
sudo npm i -g pm2 && pm2 start src/server.js --name lastcall && pm2 save && pm2 startup
```

4. Create `/etc/caddy/Caddyfile` with the following. Caddy gets the HTTPS certificate automatically, which camera and push both need.

```
yourdomain.com {
  reverse_proxy localhost:3000
}
```

5. Run `sudo systemctl reload caddy`.
6. Copy `.env` to the server and restart with `pm2 restart lastcall --update-env`.
7. Check `https://yourdomain.com/api/v1/health`. Every adapter should show `live`.

## Phase 11: Demo readiness (morning)

1. Reseed with realistic stores, use real food photos, and fund the devnet wallets.
2. Run the full loop on two phones over cellular data, not campus Wi-Fi.
3. Record a backup video of a successful run.
4. Fill in the Devpost:
   - Declare every track.
   - For each sponsor, write one line on where it appears in the demo.
5. Leave mocks enabled as automatic fallbacks (`AUTO_FALLBACK=1`), so a sandbox outage doesn't kill the demo.

## Rough split for four people

- **C:** Visa and Solana. Start immediately; these are the riskiest.
- **D:** Tiger Data and Vultr/GoDaddy.
- **A:** Perceptron and nebulaONE.
- **B:** Backboard and push.
