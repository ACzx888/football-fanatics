# FootballFanatics

**Purly Fundemental Analysis for Football Lovers!**

Dark, modern sports desk for Hong Kong Jockey Club (HKJC) football fixtures — today & tomorrow in `Asia/Hong_Kong` (UTC+8) — with **purely fundamental** predictions (no odds) and in-play tracking.

## Features

- **HKJC schedule** — live matches via native Workers-safe GraphQL fetch to HKJC. Date filters are unreliable upstream, so we fetch open matches and filter to today/tomorrow in HKT. Odds pools are **not** used for prediction (empty `fbOddsTypes`).
- **Predictions (fundamental-only / no odds)** — HAD, total corners, home/away team corners from historic results, recent form (W/D/L), goals for/against, home/away splits, attack/defence rates, tempo, and in-play score/corner rate projection. Missing fundamentals show **Insufficient Data** — never a fallback to odds.
- **In-play** — `INPLAY` badge, estimated minute, Expected vs Actual corner panels; corner expectations tilt from the live corner rate when available.
- **Fallback** — if live HKJC fails, labeled demo fixtures + error banner.

## Stack

- Next.js App Router + TypeScript + Tailwind CSS v4
- Server API route `/api/matches` (avoids CORS)
- Native `fetch` GraphQL client (`src/lib/hkjc-graphql.ts`) for schedule + live scores/corners + historic `matchResult`
- Deployed via **[@opennextjs/cloudflare](https://opennext.js.org/cloudflare)** to Cloudflare Workers (Workers Assets / Pages-compatible Git deploy)

## Run locally

```bash
cd football-fanatics
npm install
npm run dev -- -p 3001
```

Open [http://localhost:3001](http://localhost:3001).

Production / Cloudflare build locally:

```bash
npm run build          # standard Next.js build
npm run pages:build    # OpenNext → `.open-next/` Worker bundle
npm run preview        # build + run locally in Workers runtime (needs wrangler; no deploy login for preview of built assets in some setups)
```

> **Note:** `wrangler` **4.x** requires **Node.js ≥ 22**. Cloudflare Workers Builds should use Node 22+. Local `next` / `npm run build` still work on Node 20.

## Deploy to Cloudflare (GitHub)

OpenNext targets **Cloudflare Workers** (with static assets). Connecting a GitHub repo in the Cloudflare dashboard uses **Workers Builds** (the successor path for what used to be “Pages + Next.js”). You do **not** need `wrangler login` on this machine to prepare the repo — login is only needed for `npm run deploy` from the CLI.

### Option A — Connect GitHub in Cloudflare dashboard (recommended)

1. Push this repo to GitHub (create an empty repo, then add remote and push).
2. In [Cloudflare Dashboard](https://dash.cloudflare.com/) → **Workers & Pages** → **Create** → connect the GitHub repository.
3. Use these build settings:

| Setting | Value |
| --- | --- |
| **Build command** | `npx @opennextjs/cloudflare build` (or `npm run pages:build`) |
| **Deploy command** | `npx @opennextjs/cloudflare deploy` |
| **Root directory** | `/` (or `football-fanatics` if the app is in a monorepo subfolder) |
| **Node.js version** | `22` (or higher) |

There is **no separate “output directory”** like a static Pages site: OpenNext emits `.open-next/` and Wrangler deploys the Worker + assets from `wrangler.jsonc` (`main`: `.open-next/worker.js`, `assets.directory`: `.open-next/assets`).

4. Ensure the Worker name matches `wrangler.jsonc` → `"name": "football-fanatics"`.
5. Compatibility: `nodejs_compat` is already set in `wrangler.jsonc`.

### Option B — CLI deploy (requires login)

```bash
npx wrangler login   # once, on a machine with a browser
npm run deploy       # opennextjs-cloudflare build && deploy
```

### Local preview (Workers runtime)

```bash
npm run preview
```

## How predictions work

1. **Historic form** — last ~28 days of completed matches via `searchHistoricFootballMatches`, cached in-process (~20 min TTL). Per team: last ≤12 results → PPG, home/away scoring rates, form score.
2. **HAD** — Poisson from attack/defence rates (home/away adjusted). Pick H/D/A from model probs. Requires ≥3 recent games each side; otherwise **Insufficient Data**. Confidence from sample size, rate stability, and separation between top outcomes (capped ~82%) — **not** from market.
3. **Corners** — prefer historic averages when HKJC provides `ttlCornerResult` (≥0). When historic corners are missing (common: often `-1`) but HAD form exists, use a labeled **goals-proxy / tempo-proxy** from Poisson λ and attack tempo (empirical ~10.2 base corners, scaled by combined xG) — never odds, never called “historic corners”, lower confidence. Settled live corner totals are written back into teamform KV to grow real corner history over time.
4. Never invent high-confidence numbers when data is missing — show **Insufficient Data**.

Analysis is for entertainment only — **not betting advice**.

## Limitations

- HKJC `startDate`/`endDate` on *live* matches often error; filtering is done locally by kickoff HKT date.
- Historic lookback is capped for latency (~15–20s cold cache); sparse leagues may lack form.
- Match minute is estimated from kickoff + status; HKJC payloads here do not expose an official clock.
- Historic corner totals are generally unavailable from the search API (`ttlCornerResult` typically `-1`) — pre-match corners then use the labeled goals/tempo proxy whenever HAD form is available. Optional `API_FOOTBALL_KEY` / `FOOTBALL_DATA_API_KEY` hooks exist for future external corner form (KV `cornerform:v1:*`); no key is configured in the current deploy.

## Disclaimer

Not affiliated with the Hong Kong Jockey Club. Predictions use fundamental signals only (no odds). Do not use this demo as gambling advice.
