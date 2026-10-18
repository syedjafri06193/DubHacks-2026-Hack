# Last Call: Finishing Guide (updated for the DubHacks '26 tracks)

**Targeting:** Visa (main track) · Perceptron (Perception) · Photon · VEYZL · SideShift (Best Startup Idea) · DubHacks NEXT. Gemini, Backboard, Tiger Data, Solana, Vultr and GoDaddy stay in only if they're on the MLH prize list.

**Dropped:** T-Mobile, Cloudforce, SpaceXAI.

Each integration replaces one function in `src/adapters.js`, and the mocks stay as fallbacks so the demo never breaks. Where a sponsor's exact API isn't public (Perceptron, Photon), get the details at their workshop or booth.

## Hard rules from the judging page

- **Upload a demo video to Devpost, or you won't be judged.** Record it before submissions close.
- Keep the presentation **under 3 minutes**; judges cut you off on time.
- Perceptron, Photon, VEYZL, SideShift and DubHacks NEXT judge **in person in the HUB Ballroom**. Don't leave until each one has seen you, and check your hacker profile for slot times.
- If you miss a slot, wait for the overflow round (round 7). Don't squeeze your pitch into someone else's slot.

## Phase 0: Setup (about 30 min)

1. **Create `.env`** in `Submissions/Food Waste Marketplace/app/`. It's already gitignored, so never commit it.
2. **Load it at startup.** Run `npm i dotenv`, then add `require('dotenv').config()` as the first line of `src/server.js`.
3. **Start the slow signups now:**
   - Perceptron API access, from their workshop or booth.
   - Photon 2.0 beta, at photon.co/beta.
   - VEYZL, by connecting your GitHub repo.
   - Visa Acceptance (CyberSource) sandbox, at developer.cybersource.com.
   - Gemini key, from Google AI Studio.
4. **Submit the Devpost draft by 10:30 PM**, with all members, their Discord handles and the tracks.

## Phase 1: Gemini listing writer (about 15 min)

1. Add `GEMINI_API_KEY=...` and `MOCK_GEMINI=0` to `.env`.
2. Restart the server and list a food photo. The review screen should say "Listing: live". If not, check `/api/v1/health` for the fallback error.

## Phase 2: Perceptron vision, Perception track (1–2 h)

1. Get the Mk/Isaac endpoint, key and response format at the Perceptron workshop.
2. Set `PERCEPTRON_URL`, `PERCEPTRON_API_KEY` and `MOCK_PERCEPTRON=0`.
3. Rewrite `visionLive.detect` to call their **object localization** and map the output to `[{name, qty, confidence}]`. Count items from the detected boxes.
4. Go beyond counting, because they judge creative use:
   - **OCR** the best-by labels and price tags. Use the date to set `pickup_until`, and the printed price as `original_cents`.
   - **Captioning** drafts the description, which Gemini then polishes.
   - Draw the detected boxes on the review screen so judges can see the model working.
5. Resize photos before sending: `npm i sharp`, then `sharp(buf).resize(1280,1280,{fit:'inside'}).jpeg({quality:80})`.

## Phase 3: Visa checkout, main track (3–4 h; start early)

1. Get the Visa judging rubric from the hacker guide and check this plan against it.
2. In the CyberSource sandbox, create a REST shared-secret key and note your merchant ID, key ID and secret.
3. Tokenize the card in the browser with **Flex Microform**, so card numbers never touch your server.
   - Add `POST /api/v1/checkout/capture-context`, which calls `/microform/v2/sessions` and returns a capture context.
   - In `viewCheckout` (`public/app.js`), replace the card input with the Microform fields. On submit, call `microform.createToken()` and send the token as `payment_token`.
4. Rewrite `payLive.charge` to call `POST /pts/v2/payments`:
   - Send the transient token and the amount.
   - Set `processingInformation.capture: true`.
   - Use the reservation ID as `clientReferenceInformation.code`.
   - The `cybersource-rest-client` npm package handles signature auth for you.
5. Map the response: `AUTHORIZED` becomes `{ok:true, txnId:id, status:'approved'}`, and anything else becomes `declined`.
6. Set the merchant variables and `MOCK_VISA=0`, then test with CyberSource's sandbox test cards.

## Phase 4: Photon SMS/iMessage alerts (2–3 h)

The rule: the project must be built on Photon 2.0 and live on at least one Photon channel. Full details are at https://somethingreat.notion.site/Hackathon-Guidelines-for-Photon-2-0-3f8e443f36bb81f9893fed0d08a4c01d

1. Sign up at photon.co/beta, create an agent, and get its phone number and API key. Put them in `PHOTON_API_KEY` and `PHOTON_NUMBER`.
2. Add a `phone` field to buyer preferences, with an opt-in checkbox on the Preferences screen.
3. **Outbound:** in the `alert_fanout` job (`src/server.js`), text each matching buyer who has opted in. For example: *"Ave Street Bakery: 6 bagels + 1 loaf, $21.10 (22% off), 0.9 km away. Reply RESERVE to hold one for 10 min."*
4. **Inbound:** add a webhook route, for example `POST /api/v1/photon/webhook`, and register it with Photon. Map the sender's number to a buyer, then handle these replies:
   - `RESERVE`: create the hold for that buyer's most recent alert, then reply with a checkout link (`https://yourdomain.com/#/checkout/<id>`).
   - `STOP`: turn alerts off.
   - Anything else: let Gemini answer, for example "anything vegan tonight?". This is what makes it an agent rather than a notifier.
5. Also text the pickup code once payment succeeds.
6. Keep the in-app SSE alerts as they are; Photon is an extra channel.
7. Demo: a judge's phone gets the text, they reply RESERVE, and pay from the link.

## Phase 5: VEYZL audit (about 1 h, alongside other work)

What they need to see: a real audit on a pull request, plus evidence the findings changed the build. A passing check on its own isn't enough.

1. Connect the GitHub repo to VEYZL.
2. Do the Perceptron, Visa or Photon work on a **branch** and open a pull request so the audit runs.
3. Fix what it flags. Likely findings for this app, which also fit the Gemini pricing and Photon agent:
   - **Human oversight of AI pricing.** This already exists: the seller reviews the price and the server clamps it. Make it explicit in the UI.
   - **Allergen accuracy.** Show "AI-detected, confirm with the store" on listings.
   - **Logging model output.** Store `ai_meta` for live calls too.
   - **Agent guardrails for Photon replies.** Add a system prompt limit, refuse health claims, and require opt-in and STOP handling.
4. Screenshot the failing check, then the fix, then the passing check. Put them in the Devpost and walk through them in the pitch.

## Phase 6: Optional MLH-dependent integrations

Do these only if they're on the MLH prize list.

**Solana payouts (devnet, 1–2 h)**
1. Run `npm i @solana/web3.js bs58`.
2. Create a payer wallet with `solana-keygen new`, fund it with `solana airdrop 2 <pubkey> --url devnet`, and put the base58 secret in `SOLANA_PAYER_SECRET`.
3. Give each store a real devnet public key in `stores.solana_wallet`.
4. Rewrite `payoutLive.send` to do a `SystemProgram.transfer` and return the signature and an explorer link with `?cluster=devnet`.
5. Set `MOCK_SOLANA=0`.

**Tiger Data (2–3 h):** Port `src/db.js` to `pg` with the same helpers, use the Postgres schema from design doc §4.2, then add the `impact_events` hypertable and `impact_daily` continuous aggregate.

**Backboard (1–2 h):** Implement `memoryLive.get` and `memoryLive.put` against their API. Also store purchase history, and use it in ranking.

## Phase 7: Hardening (about 45 min)

1. Delete or protect `/admin/reset` with an `ADMIN_TOKEN`.
2. Set a strong `SESSION_SECRET` and add `Secure` to the cookie.
3. Rate-limit login, draft, pay and the Photon webhook with `express-rate-limit`.
4. Verify Photon webhook signatures if Photon provides them.

## Phase 8: Deploy (about 1 h; HTTPS is needed for the camera, the Photon webhook and the links in texts)

1. Get a server: a Vultr Ubuntu 24.04 box (1 vCPU, 2 GB) or any VPS.
2. Point a domain's **A record** at the server's IP, through GoDaddy or any registrar.
3. Install and start the app:

```bash
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo bash - && sudo apt install -y nodejs caddy
git clone https://github.com/syedjafri06193/DubHacks-2026-Hack.git
cd "DubHacks-2026-Hack/Submissions/Food Waste Marketplace/app" && npm ci
sudo npm i -g pm2 && pm2 start src/server.js --name lastcall && pm2 save && pm2 startup
```

4. Create `/etc/caddy/Caddyfile` with the following, then run `sudo systemctl reload caddy`:

```
yourdomain.com {
  reverse_proxy localhost:3000
}
```

5. Copy `.env` to the server, then run `pm2 restart lastcall --update-env`.
6. Point the Photon webhook at `https://yourdomain.com/api/v1/photon/webhook`.
7. Check `https://yourdomain.com/api/v1/health`.

**Short on time?** Run `npx cloudflared tunnel --url http://localhost:3000` on a laptop to get a temporary HTTPS URL.

## Phase 9: Video, pitch and submission (morning)

1. Reseed with realistic stores, use real food photos, and run the full loop on two phones over cellular data.
2. **Record the video, under 3 minutes:**
   1. **Problem:** how much a bakery throws out each night.
   2. **Seller:** a photo, then Perceptron boxes and OCR, then the Gemini listing with a clamped price, then publish.
   3. **Buyer:** a Photon text arrives, they reply RESERVE, then pay through Visa checkout.
   4. **Seller:** sees the paid order, then scans the pickup QR.
   5. **Impact:** the dashboard and a shareable impact card.
   6. **VEYZL:** a 10-second before-and-after of the audit fix.
3. **Devpost:**
   - Upload the video.
   - Declare Visa, Perceptron (Perception), Photon, VEYZL, SideShift and DubHacks NEXT, plus any MLH tracks.
   - Write one paragraph per sponsor on exactly where it appears.
4. **SideShift and DubHacks NEXT pitch:**
   - Market: food waste costs stores money every night.
   - Business model: a 5% platform fee, which is already in the code.
   - Distribution: stores and buyers share their impact cards on social media, which brings new users for free.
5. Keep mocks on as automatic fallbacks (`AUTO_FALLBACK=1`) so a sandbox outage doesn't kill the live demo.

## Team split

- **A:** Perceptron, plus the seller UI for boxes and OCR.
- **B:** Photon, covering outbound alerts, the webhook and the agent replies.
- **C:** Visa checkout, then Solana if it's an MLH prize.
- **D:** VEYZL pull requests, deploy, video, Devpost and the pitch.
