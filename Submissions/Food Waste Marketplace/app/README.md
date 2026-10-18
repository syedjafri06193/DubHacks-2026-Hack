# Last Call: Food Waste Marketplace (MVP)

Working MVP of the DubHacks '26 Food Waste Marketplace. Stores photograph surplus food, AI turns it into a priced listing, nearby buyers get a live alert, reserve and pay, the store gets an instant payout, and every pickup is logged as meals saved.

## Run it

```bash
npm install
npm start          # http://localhost:3000
npm test           # end-to-end core-loop test
npm run seed       # reset demo data (or "Reset demo data" on the login screen)
```

Requires Node 22.5+ (uses the built-in `node:sqlite`, so there are no native dependencies).

## Demo (two windows)

1. Window A: log in as **Priya (student)**. Allow notifications if you like.
2. Window B: log in as **Maya (Ave Street Bakery)**, tap a demo photo (or upload your own) and publish.
3. Window A gets a live "New deal nearby" alert, then reserve, then pay with `4111 1111 1111 1111` (`4000 0000 0000 0002` declines).
4. Window B sees "order paid", then the Solana payout with an explorer link a second later.
5. Type the buyer's pickup code (or scan the QR) in Orders. The Impact page updates live.

## What's implemented (maps to the design doc)

| Area | Status |
|---|---|
| Seller flow: photo, vision, AI listing, server-clamped price (§6.2), review, publish, withdraw | ✅ |
| Buyer flow: ranked nearby feed, preferences, 10-min hold, checkout, QR pickup | ✅ |
| Reservation lifecycle with oversell protection, hold expiry, idempotent pay (§4.3, §5.2) | ✅ |
| Worker on a jobs table: payouts, hold expiry, listing expiry, alert fan-out | ✅ |
| Real-time SSE events: `listing.new/updated`, `reservation.paid`, `payout.confirmed`, `impact.updated` | ✅ |
| Impact dashboard plus shareable impact card (`/api/v1/impact/card/:storeId.svg`) | ✅ |
| PWA: manifest, service worker, camera capture, notifications | ✅ |
| `/api/v1/health` with live/mock status per adapter | ✅ |

## Sponsor adapters (live or mock)

Everything runs on mocks out of the box. Set `MOCK_<NAME>=0` plus the key to go live. If a live call fails, it falls back to the mock automatically (turn this off with `AUTO_FALLBACK=0`).

| Adapter | Live today | To wire up |
|---|---|---|
| `gemini` (`GEMINI_API_KEY`) | ✅ Real Gemini call with JSON mode, schema check and one retry | Nothing more needed |
| `perceptron` (`PERCEPTRON_API_KEY`, `PERCEPTRON_URL`) | ✅ Generic POST. Without it, live vision uses Gemini | Confirm the response shape |
| `visa`, `solana`, `backboard` | Stubs that delegate to the mocks | Replace the `*Live` functions in `src/adapters.js` |

## Differences from the design doc

- SQLite stands in for Tiger Data so it runs with zero setup. The schema mirrors §4, so porting to Postgres/Timescale is a matter of changing SQL dialect in `src/db.js` and `impactSummary`.
- Express replaces Next.js, with a vanilla-JS PWA. It's one process and one deploy, which fits Vultr behind Caddy.
- Impact cards are SVG, not PNG.
- Alerts use SSE plus browser notifications. Web Push (VAPID) is not wired yet.

## Layout

```
src/server.js    API routes, SSE, worker
src/adapters.js  sponsor adapters + mocks
src/pricing.js   discount bands and clamping
src/db.js        schema
src/seed.js      demo stores/users/listings/history
public/          PWA client
test/            e2e test
```
