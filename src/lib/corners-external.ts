/**
 * Optional external fundamental corner form (never odds).
 *
 * When FOOTBALL_DATA_API_KEY or API_FOOTBALL_KEY is bound on the Worker,
 * we may enrich team corner averages from public sports APIs.
 * Without a key (current deploy), this module is a no-op and predictions
 * fall back to the labeled goals/tempo proxy in corner-model.ts.
 *
 * Cached under HISTORIC_CACHE with versioned keys: cornerform:v1:{teamKey}
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
 * Returns null when no API key / no cache hit — caller uses goals-proxy.
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

  // No free corner endpoint without a vendor key. football-data.org free
  // match payloads omit corners; api-football requires API_FOOTBALL_KEY.
  // When a key appears later, fetch + put under KV_PREFIX here.
  const hasKey = !!(env.FOOTBALL_DATA_API_KEY || env.API_FOOTBALL_KEY);
  if (!hasKey) return null;

  // Key present but connector not implemented for corners yet — stay honest.
  void hasKey;
  return null;
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
