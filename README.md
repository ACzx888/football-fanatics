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

1. **Historic form (HKJC)** — team-targeted `searchHistoricFootballMatches` stacked ~14d windows (~84d), KV `teamform:v2:*`. Per team: last ≤12 results → PPG, home/away scoring rates, form score.
2. **External form enricher** (`src/lib/ext-form.ts`) — fills thin/missing HKJC form from **KV-warmed** public sources (never odds):
   - Warm via `GET /api/warm-ext?source=all-small&offset=0` (repeat with rising offset) or `?source=fotmob&id=9821` / `?source=csv&div=E0`
   - **FotMob** league fixtures (keyless) — internationals / cups / women’s / U21 when warmed (large leagues size-skipped)
   - **football-data.co.uk** season CSVs (keyless) — goals + **real HC/AC corners** for major EU leagues
   - **OpenLigaDB** (DE) via `?source=openliga`
   - **TheSportsDB** is **429 from Cloudflare IPs** — not used at runtime (see `/api/debug-ext`)
   - Optional: `FOOTBALL_DATA_API_KEY` / `API_FOOTBALL_KEY` for deeper club/corner paths
   - Team matching: fuzzy English name + alias table + HKJC tournament code → league map; KV `extform:v2:*`
   - `/api/matches` only **reads** KV (avoids Free Worker CPU 1102 from large JSON parses)
3. **HAD / team scores** — Poisson from attack/defence rates. Soft gate ≥1 sample each side (prefer ≥2). Confidence from sample size / stability / separation — **not** market.
4. **Corners** — prefer real totals on samples (HKJC `ttlCornerResult`, CSV HC+AC, api-football stats). Else labeled **goals-proxy / tempo-proxy** from λ (never called “historic corners”).
5. UI shows honest **source chips** (`hkjc` / `fotmob` / `football-data` / `goals-proxy` / …). Forecast lock after first write is unchanged.
6. Never invent high-confidence numbers when data is missing — show **Insufficient Data**.

Analysis is for entertainment only — **not betting advice**.

## Optional API secrets (max coverage)

Keyless sources ship by default. For broader club coverage / real corner stats:

```bash
npx wrangler secret put FOOTBALL_DATA_API_KEY   # free: https://www.football-data.org/client/register
npx wrangler secret put API_FOOTBALL_KEY        # free tier: https://www.api-football.com/
```

Local: copy `.dev.vars.example` → `.dev.vars` and fill values. Bindings are declared in `cloudflare-env.d.ts`.

## Limitations

- HKJC `startDate`/`endDate` on *live* matches often error; filtering is done locally by kickoff HKT date.
- `/api/matches` is Free-Worker cheap: memory+KV form first, ≤4 zero-sample HKJC fills, KV-only external merge (no inline FotMob/CSV parses). Cold form may be thin — warm via `/api/warm-ext` (cron) for coverage. `?light=1` skips historic network entirely. Homepage SSR uses light mode so fixtures never 1102.
- Match minute is estimated from kickoff + status; HKJC payloads here do not expose an official clock.
- Obscure cups / AM / friendlies may still be unmatched after fuzzy aliasing — we stay honest with **Insufficient Data**.
- CSV / FotMob unofficial JSON can change shape; enricher degrades gracefully per source.

## Disclaimer

Not affiliated with the Hong Kong Jockey Club. Predictions use fundamental signals only (no odds). Do not use this demo as gambling advice.
