# Food Waste Marketplace — DubHacks '26 Build Plan

> Stores list surplus food at a discount near closing time. Buyers reserve and pay in-app.

## Track Mapping

| Track | Role |
|---|---|
| **Visa** (title) | Reserve and pay in-app |
| **T-Mobile** | Real-time nearby deals on your phone |
| **Perceptron** | Sellers photograph surplus to list it instantly |
| **Gemini** | Writes listings and sets discount prices |
| **Backboard** | Remembers buyer preferences for alerts |
| **Tiger Data** | Food-saved and waste-reduction metrics |
| **Solana** | Instant, low-fee payouts to small restaurants |
| **Vultr** | Hosts the backend |
| **GoDaddy** | Project domain |
| **CloudForce** | nebulaONE in the AI pipeline; shareable impact cards for Most Viral |
| **DubHacks Next / Commit Fellowship** | Pitch it as a real startup |
| **DEV Writing** | Write-up after the event |

---

## Core Loop (build first)

1. **Seller** photographs surplus food → **Perceptron** identifies the items
2. **Gemini** writes the listing and suggests a discount based on time to closing
3. **Buyer** gets a nearby-deal alert (**T-Mobile**), matched to saved preferences (**Backboard**)
4. Buyer reserves and pays (**Visa**) → seller paid out instantly (**Solana**)
5. Pickup logs meals saved → impact dashboard (**Tiger Data**)

> If only this flow works end to end, you still have a winning demo.

---

## Stack

- **Frontend:** mobile-first web app / PWA (React or Next.js), no app-store builds
- **Backend:** Node or Python API on **Vultr**
- **Database:** Tiger Data (Postgres) for app data *and* metrics, so there's only one database to run
- **Domain:** register via **GoDaddy** early (DNS takes time)

---

## Team Split

| Person | Owns |
|---|---|
| **A** | Seller flow: photo upload, Perceptron, Gemini listing and pricing |
| **B** | Buyer flow: deal feed, alerts, Backboard preferences |
| **C** | Payments: Visa checkout, Solana payouts |
| **D** | Backend and data: API, Tiger Data, impact dashboard, Vultr deploy, design polish |

---

## Timeline

| When | What |
|---|---|
| **Now → 5 PM** | Repo setup, hello-world deploy to Vultr, all sponsor API keys, buy domain |
| **5 → 10 PM** | Each person gets their piece working on its own |
| **By 10:30 PM** | 🚨 **Submit Devpost draft**: all members, their Discords, tracks declared |
| **Overnight** | Connect everything into the full loop |
| **6 → 9 AM** | UI polish (Design = 20%), seed realistic demo data, record a backup video |
| **Before 10 AM** | 🚨 **Final submission** |
| **After event** | DEV post + Commit Fellowship supplemental form |

---

## Demo Script (~2 min)

1. **Problem:** how much food a nearby bakery throws out each night
2. **Seller:** snap a photo of leftover pastries → listing appears with a price
3. **Buyer:** switch phones → alert arrives → reserve and pay with Visa
4. **Payout:** the seller's Solana payout lands within seconds
5. **Impact:** dashboard shows meals saved and dollars recovered

---

## Risks

- **Visa and Solana sandbox setup can eat hours.** Person C starts on both immediately.
- Keep a **mocked fallback** for each integration so the demo works even if one breaks.
- Confirm T-Mobile, Perceptron and CloudForce requirements in the hacker guide.

## Judging Weights

Functionality 30% · Track Applicability 30% · Design 20% · Creativity 20%
