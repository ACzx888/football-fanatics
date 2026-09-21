/**
 * Workers-safe HKJC GraphQL client using native fetch.
 * Replaces hkjc-api / graphql-request (which swallow errors and can fail
 * silently on Cloudflare Workers).
 *
 * HKJC whitelists exact query shapes — do not slim foPools away or the
 * API returns WHITELIST_ERROR / schema mismatch.
 */

const HKJC_ENDPOINT = "https://info.cld.hkjc.com/graphql/base/";

const BROWSER_HEADERS: Record<string, string> = {
  "Content-Type": "application/json",
  Accept: "application/json",
  Origin: "https://bet.hkjc.com",
  Referer: "https://bet.hkjc.com/",
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
};

/** Exact whitelisted live match-list query from hkjc-api. */
export const footballMatchesQuery = `
query matchList($startIndex: Int, $endIndex: Int,$startDate: String, $endDate: String, $matchIds: [String], $tournIds: [String], $fbOddsTypes: [FBOddsType]!, $fbOddsTypesM: [FBOddsType]!, $inplayOnly: Boolean, $featuredMatchesOnly: Boolean, $frontEndIds: [String], $earlySettlementOnly: Boolean, $showAllMatch: Boolean) {
    matches(startIndex: $startIndex,endIndex: $endIndex, startDate: $startDate, endDate: $endDate, matchIds: $matchIds, tournIds: $tournIds, fbOddsTypes: $fbOddsTypesM, inplayOnly: $inplayOnly, featuredMatchesOnly: $featuredMatchesOnly, frontEndIds: $frontEndIds, earlySettlementOnly: $earlySettlementOnly, showAllMatch: $showAllMatch) {
      id
      frontEndId
      matchDate
      kickOffTime
      status
      updateAt
      sequence
      esIndicatorEnabled
      homeTeam {
        id
        name_en
        name_ch
      }
      awayTeam {
        id
        name_en
        name_ch
      }
      tournament {
        id
        frontEndId
        nameProfileId
        isInteractiveServiceAvailable
        code
        name_en
        name_ch
      }
      isInteractiveServiceAvailable
      inplayDelay
      venue {
        code
        name_en
        name_ch
      }
      tvChannels {
        code
        name_en
        name_ch
      }
      liveEvents {
        id
        code
      }
      featureStartTime
      featureMatchSequence
      poolInfo {
        normalPools
        inplayPools
        sellingPools
        ntsInfo
        entInfo
        definedPools
      }
      runningResult {
        homeScore
        awayScore
        corner
        homeCorner
        awayCorner
      }
      runningResultExtra {
        homeScore
        awayScore
        corner
        homeCorner
        awayCorner
      }
      adminOperation {
        remark {
          typ
        }
      }
      foPools(fbOddsTypes: $fbOddsTypes) {
        id
        status
        oddsType
        instNo
        inplay
        name_ch
        name_en
        updateAt
        expectedSuspendDateTime
        lines {
          lineId
          status
          condition
          main
          combinations {
            combId
            str
            status
            offerEarlySettlement
            currentOdds
            selections {
              selId
              str
              name_ch
              name_en
            }
          }
        }
      }
    }
  }
`;

/** Exact whitelisted historic results query from hkjc-api. */
export const historicFootballMatchesQuery = `
query matchResults($startDate: String, $endDate: String, $startIndex: Int,$endIndex: Int,$teamId: String) {
    timeOffset {
    fb
    }
    matchNumByDate(startDate: $startDate, endDate: $endDate, teamId: $teamId) {
    total
    }
    matches: matchResult(startDate: $startDate, endDate: $endDate, startIndex: $startIndex,endIndex: $endIndex, teamId: $teamId) {
    id
    status
    frontEndId
    matchDayOfWeek
    matchNumber
    matchDate
    kickOffTime
    sequence
    homeTeam {
        id
        name_en
        name_ch
    }
    awayTeam {
        id
        name_en
        name_ch
    }
    tournament {
        code
        name_en
        name_ch
    }
    results {
        homeResult
        awayResult
        ttlCornerResult
        resultConfirmType
        payoutConfirmed
        stageId
        resultType
        sequence
    }
    poolInfo {
        payoutRefundPools
        refundPools
        ntsInfo
        entInfo
        definedPools
        ngsInfo {
        str
        name_en
        name_ch
        instNo
        }
        agsInfo {
        str
        name_en
        name_ch
        }
    }
    }
}
`;

export type HkjcGraphqlError = {
  message?: string;
  extensions?: { code?: string };
};

export class HkjcFetchError extends Error {
  status?: number;
  graphqlErrors?: HkjcGraphqlError[];

  constructor(
    message: string,
    opts?: { status?: number; graphqlErrors?: HkjcGraphqlError[] }
  ) {
    super(message);
    this.name = "HkjcFetchError";
    this.status = opts?.status;
    this.graphqlErrors = opts?.graphqlErrors;
  }
}

export async function hkjcGraphql<T = unknown>(
  query: string,
  variables: Record<string, unknown>,
  opts?: { signal?: AbortSignal; timeoutMs?: number }
): Promise<T> {
  const timeoutMs = opts?.timeoutMs ?? 12_000;
  const controller = new AbortController();
  const onAbort = () => controller.abort();
  if (opts?.signal) {
    if (opts.signal.aborted) controller.abort();
    else opts.signal.addEventListener("abort", onAbort, { once: true });
  }
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(HKJC_ENDPOINT, {
      method: "POST",
      headers: BROWSER_HEADERS,
      body: JSON.stringify({ query, variables }),
      signal: controller.signal,
    });

    const text = await res.text();
    let json: {
      data?: T;
      errors?: HkjcGraphqlError[];
    };
    try {
      json = JSON.parse(text) as typeof json;
    } catch {
      throw new HkjcFetchError(
        `HKJC returned non-JSON (HTTP ${res.status}): ${text.slice(0, 200)}`,
        { status: res.status }
      );
    }

    if (!res.ok) {
      const gqlMsg = json.errors?.[0]?.message;
      throw new HkjcFetchError(
        gqlMsg
          ? `HKJC HTTP ${res.status}: ${gqlMsg}`
          : `HKJC HTTP ${res.status}: ${text.slice(0, 200)}`,
        { status: res.status, graphqlErrors: json.errors }
      );
    }

    if (json.errors?.length) {
      const msg = json.errors.map((e) => e.message || "unknown").join("; ");
      throw new HkjcFetchError(`HKJC GraphQL error: ${msg}`, {
        status: res.status,
        graphqlErrors: json.errors,
      });
    }

    if (json.data == null) {
      throw new HkjcFetchError("HKJC GraphQL returned empty data", {
        status: res.status,
      });
    }

    return json.data;
  } catch (err) {
    if (err instanceof HkjcFetchError) throw err;
    if (err instanceof Error && err.name === "AbortError") {
      throw new HkjcFetchError(`HKJC request timed out after ${timeoutMs}ms`);
    }
    throw new HkjcFetchError(
      err instanceof Error ? err.message : "HKJC fetch failed"
    );
  } finally {
    clearTimeout(timer);
    if (opts?.signal) opts.signal.removeEventListener("abort", onAbort);
  }
}

export type RawLiveMatch = {
  id?: string;
  frontEndId?: string;
  kickOffTime?: string;
  matchDate?: string;
  status?: string;
  homeTeam?: { id?: string; name_en?: string; name_ch?: string };
  awayTeam?: { id?: string; name_en?: string; name_ch?: string };
  tournament?: { name_en?: string; code?: string };
  runningResult?: {
    homeScore?: number;
    awayScore?: number;
    corner?: number;
    homeCorner?: number;
    awayCorner?: number;
  } | null;
};

/**
 * Fetch open football matches. Empty oddsTypes keeps foPools empty
 * (predictions stay odds-free) while satisfying the whitelist.
 */
export async function fetchLiveFootballMatches(
  oddsTypes: string[] = [],
  opts?: { signal?: AbortSignal; timeoutMs?: number }
): Promise<RawLiveMatch[]> {
  const data = await hkjcGraphql<{ matches?: RawLiveMatch[] | null }>(
    footballMatchesQuery,
    {
      fbOddsTypes: oddsTypes,
      fbOddsTypesM: oddsTypes,
      startDate: null,
      endDate: null,
      tournIds: null,
      matchIds: null,
      featuredMatchesOnly: false,
      frontEndIds: null,
      earlySettlementOnly: false,
      showAllMatch: false,
      startIndex: null,
      endIndex: null,
      inplayOnly: null,
    },
    opts
  );
  return data.matches ?? [];
}

export type RawHistoricMatch = {
  id?: string;
  matchDate?: string;
  homeTeam?: { id?: string; name_en?: string };
  awayTeam?: { id?: string; name_en?: string };
  results?: Array<{
    homeResult?: number;
    awayResult?: number;
    ttlCornerResult?: number;
    stageId?: number;
    resultType?: number;
    payoutConfirmed?: boolean;
    sequence?: number;
  }>;
};

export type HistoricSearchResult = {
  timeOffset: { fb: number };
  matchNumByDate: { total: number };
  matches: RawHistoricMatch[];
};

export async function searchHistoricFootballMatches(
  options: {
    startDate?: string | null;
    endDate?: string | null;
    startIndex?: number | null;
    endIndex?: number | null;
    teamId?: string | null;
  } = {},
  opts?: { signal?: AbortSignal; timeoutMs?: number }
): Promise<HistoricSearchResult> {
  const data = await hkjcGraphql<{
    timeOffset?: { fb?: number };
    matchNumByDate?: { total?: number };
    matches?: RawHistoricMatch[] | null;
  }>(
    historicFootballMatchesQuery,
    {
      startDate: options.startDate ?? null,
      endDate: options.endDate ?? null,
      startIndex: options.startIndex ?? null,
      endIndex: options.endIndex ?? null,
      teamId: options.teamId ?? null,
    },
    opts
  );
  return {
    timeOffset: { fb: data.timeOffset?.fb ?? 0 },
    matchNumByDate: { total: data.matchNumByDate?.total ?? 0 },
    matches: data.matches ?? [],
  };
}
