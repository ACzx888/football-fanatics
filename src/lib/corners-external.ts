/**
 * Optional external fundamental corner form (never odds).
 *
 * Prefer real corner averages from:
 *  - football-data.co.uk CSV HC+AC (via ext-form enricher → TeamMatchSample.totalCorners)
 *  - api-football statistics when API_FOOTBALL_KEY is set
 *  - Settled live HKJC totals written back via putExternalCornerForm
 *
 * Cached under HISTORIC_CACHE: cornerform:v1:{teamKey}
 * Without a key, this module still serves KV hits + league base constant.
 */

import { getCloudflareContext } from "@opennextjs/cloudflare";
import { LEAGUE_CORNER_BASE } from "./corner-model";

const KV_PREFIX = "cornerform:v1:";
const KV_TTL_SECONDS = 24 * 60 * 60; // 24h

export type ExternalCornerForm = {
  teamKey: string;
  avgTotalCorners: number | null;
  sampleN: number;
  source: string;
  cachedAt: number;
};

type FfKv = {
  get(key: string): Promise<string | null>;
  put(
    key: string,
    value: string,
    options?: { expirationTtl?: number }
  ): Promise<void>;
};

type CornerEnv = {
  HISTORIC_CACHE?: FfKv;
  FOOTBALL_DATA_API_KEY?: string;
  API_FOOTBALL_KEY?: string;
};

async function getEnv(): Promise<CornerEnv | null> {
  try {
    const ctx = await getCloudflareContext({ async: true });
    return (ctx?.env as CornerEnv | undefined) ?? null;
  } catch {
    return null;
  }
}

/** League-default corner rate for proxy anchoring (KV-cached constant). */
export async function getLeagueCornerBase(): Promise<number> {
  const env = await getEnv();
  const kv = env?.HISTORIC_CACHE;
  if (!kv) return LEAGUE_CORNER_BASE;
  try {
    const raw = await kv.get(`${KV_PREFIX}league-base`);
    if (raw) {
      const n = Number(JSON.parse(raw)?.avgTotalCorners);
      if (Number.isFinite(n) && n > 5 && n < 16) return n;
    }
  } catch {
    // ignore
  }
  try {
    await kv.put(
      `${KV_PREFIX}league-base`,
      JSON.stringify({
        teamKey: "league-base",
        avgTotalCorners: LEAGUE_CORNER_BASE,
        sampleN: 0,
        source: "empirical-default",
        cachedAt: Date.now(),
      } satisfies ExternalCornerForm),
      { expirationTtl: KV_TTL_SECONDS * 7 }
    );
  } catch {
    // ignore
  }
  return LEAGUE_CORNER_BASE;
}

/**
 * Look up cached external corner form for a team name.
 * When API_FOOTBALL_KEY is present and cache miss, attempt last-fixture
 * statistics corners (best-effort; swallow errors).
 */
export async function getExternalCornerForm(
  teamName: string
): Promise<ExternalCornerForm | null> {
  const env = await getEnv();
  if (!env) return null;
  const key = teamName.trim().toLowerCase();
  if (!key) return null;

  const kv = env.HISTORIC_CACHE;
  if (kv) {
    try {
      const raw = await kv.get(`${KV_PREFIX}${key}`);
      if (raw) {
        const parsed = JSON.parse(raw) as ExternalCornerForm;
        if (parsed?.avgTotalCorners != null && parsed.sampleN > 0) {
          return parsed;
        }
      }
    } catch {
      // ignore
    }
  }

  const apiKey = env.API_FOOTBALL_KEY;
  if (!apiKey) return null;

  // Best-effort: search team → last fixtures → statistics corners average
  try {
    const searchRes = await fetch(
      `https://v3.football.api-sports.io/teams?search=${encodeURIComponent(teamName)}`,
      {
        headers: { "x-apisports-key": apiKey },
        signal: AbortSignal.timeout(6000),
      }
    );
    if (!searchRes.ok) return null;
    const search = (await searchRes.json()) as {
      response?: Array<{ team?: { id?: number; name?: string } }>;
    };
    const teamId = search.response?.[0]?.team?.id;
    if (!teamId) return null;

    const fixRes = await fetch(
      `https://v3.football.api-sports.io/fixtures?team=${teamId}&last=5`,
      {
        headers: { "x-apisports-key": apiKey },
        signal: AbortSignal.timeout(6000),
      }
    );
    if (!fixRes.ok) return null;
    const fix = (await fixRes.json()) as {
      response?: Array<{ fixture?: { id?: number } }>;
    };
    const ids = (fix.response || [])
      .map((r) => r.fixture?.id)
      .filter((x): x is number => typeof x === "number")
      .slice(0, 3);

    const totals: number[] = [];
    for (const fid of ids) {
      const stRes = await fetch(
        `https://v3.football.api-sports.io/fixtures/statistics?fixture=${fid}`,
        {
          headers: { "x-apisports-key": apiKey },
          signal: AbortSignal.timeout(6000),
        }
      );
      if (!stRes.ok) continue;
      const st = (await stRes.json()) as {
        response?: Array<{
          statistics?: Array<{ type?: string; value?: number | string | null }>;
        }>;
      };
      let sum = 0;
      let hit = 0;
      for (const side of st.response || []) {
        for (const row of side.statistics || []) {
          if ((row.type || "").toLowerCase() === "corner kicks") {
            const v = Number(row.value);
            if (Number.isFinite(v) && v >= 0) {
              sum += v;
              hit++;
            }
          }
        }
      }
      if (hit >= 2) totals.push(sum);
    }
    if (!totals.length) return null;
    const avg = totals.reduce((a, b) => a + b, 0) / totals.length;
    const payload: ExternalCornerForm = {
      teamKey: key,
      avgTotalCorners: avg,
      sampleN: totals.length,
      source: "api-football",
      cachedAt: Date.now(),
    };
    if (kv) {
      await kv.put(`${KV_PREFIX}${key}`, JSON.stringify(payload), {
        expirationTtl: KV_TTL_SECONDS,
      });
    }
    return payload;
  } catch {
    return null;
  }
}

/** Persist a measured team corner average (e.g. from settled live results). */
export async function putExternalCornerForm(
  teamName: string,
  avgTotalCorners: number,
  sampleN: number,
  source: string
): Promise<void> {
  const env = await getEnv();
  const kv = env?.HISTORIC_CACHE;
  if (!kv) return;
  const key = teamName.trim().toLowerCase();
  if (!key || sampleN <= 0) return;
  try {
    const payload: ExternalCornerForm = {
      teamKey: key,
      avgTotalCorners,
      sampleN,
      source,
      cachedAt: Date.now(),
    };
    await kv.put(`${KV_PREFIX}${key}`, JSON.stringify(payload), {
      expirationTtl: KV_TTL_SECONDS,
    });
  } catch {
    // ignore
  }
}
