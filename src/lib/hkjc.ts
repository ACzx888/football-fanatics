import { buildDemoMatches } from "./demo-data";
import {
  getTeamForm,
  loadHistoricForTeams,
  type HistoricBundle,
  type TeamRef,
} from "./historic";
import {
  enrichHistoricWithExternal,
  teamFormSources,
  type ExtTeamRef,
} from "./ext-form";
import {
  fetchLiveFootballMatches,
  type RawLiveMatch,
} from "./hkjc-graphql";
import { buildPredictions } from "./predictions";
import type { FootballMatch, MatchesApiResponse, PredictionSource } from "./types";
import {
  addDaysHkt,
  estimateMinuteLabel,
  formatHktDate,
  hktDateFromIso,
  isInPlayStatus,
} from "./time";

function normalizeMatch(
  raw: RawLiveMatch,
  today: string,
  tomorrow: string,
  now: Date,
  historic: HistoricBundle | null
): FootballMatch | null {
  if (!raw.id || !raw.kickOffTime) return null;
  const day = hktDateFromIso(raw.kickOffTime);
  if (day !== today && day !== tomorrow) return null;

  const status = raw.status || "UNKNOWN";
  const homeTeam = raw.homeTeam?.name_en || "Home";
  const awayTeam = raw.awayTeam?.name_en || "Away";
  const homeTeamId = raw.homeTeam?.id;
  const awayTeamId = raw.awayTeam?.id;

  const homeForm = historic
    ? getTeamForm(historic, homeTeamId, homeTeam)
    : null;
  const awayForm = historic
    ? getTeamForm(historic, awayTeamId, awayTeam)
    : null;

  const formSources: PredictionSource[] = [];
  if (historic) {
    formSources.push(
      ...teamFormSources(historic, homeTeamId, homeTeam),
      ...teamFormSources(historic, awayTeamId, awayTeam)
    );
  }

  const rr = raw.runningResult;
  const live =
    rr &&
    (rr.homeScore != null ||
      rr.awayScore != null ||
      rr.corner != null ||
      rr.homeCorner != null ||
      rr.awayCorner != null)
      ? {
          homeScore: rr.homeScore ?? null,
          awayScore: rr.awayScore ?? null,
          corner: rr.corner ?? null,
          homeCorner: rr.homeCorner ?? null,
          awayCorner: rr.awayCorner ?? null,
        }
      : null;

  const isInPlay = isInPlayStatus(status);
  const minuteLabel = estimateMinuteLabel(raw.kickOffTime, status, now);

  // Forecasts are fundamental/historic only — never live minute/score/corners.
  const predictions = buildPredictions({
    homeForm,
    awayForm,
    leagueAvgGoals: historic?.leagueAvgGoals ?? 1.3,
    historicOk: !!(historic?.ok && (homeForm || awayForm)),
    formSources: [...new Set(formSources)],
  });

  return {
    id: String(raw.id),
    frontEndId: raw.frontEndId || String(raw.id),
    kickOffTime: raw.kickOffTime,
    matchDate: day,
    status,
    league: raw.tournament?.name_en || "Unknown League",
    leagueCode: raw.tournament?.code || "",
    homeTeam,
    awayTeam,
    homeTeamCh: raw.homeTeam?.name_ch,
    awayTeamCh: raw.awayTeam?.name_ch,
    homeTeamId,
    awayTeamId,
    isInPlay,
    minuteLabel,
    live,
    predictions,
    dayBucket: day === today ? "today" : "tomorrow",
  };
}

function collectMatchPairs(
  rawMatches: RawLiveMatch[],
  today: string,
  tomorrow: string
): Array<[string, string]> {
  const pairs: Array<[string, string]> = [];
  for (const raw of rawMatches) {
    if (!raw.kickOffTime || !raw.homeTeam?.id || !raw.awayTeam?.id) continue;
    const day = hktDateFromIso(raw.kickOffTime);
    if (day !== today && day !== tomorrow) continue;
    pairs.push([raw.homeTeam.id, raw.awayTeam.id]);
  }
  return pairs;
}

function collectTeamRefs(
  rawMatches: RawLiveMatch[],
  today: string,
  tomorrow: string
): ExtTeamRef[] {
  const map = new Map<string, ExtTeamRef>();
  const order: string[] = [];
  for (const raw of rawMatches) {
    if (!raw.kickOffTime) continue;
    const day = hktDateFromIso(raw.kickOffTime);
    if (day !== today && day !== tomorrow) continue;
    const league = raw.tournament?.name_en || "";
    const leagueCode = raw.tournament?.code || "";
    for (const team of [raw.homeTeam, raw.awayTeam]) {
      if (!team?.id) continue;
      if (!map.has(team.id)) {
        map.set(team.id, {
          id: team.id,
          name: team.name_en || team.id,
          league,
          leagueCode,
        });
        order.push(team.id);
      }
    }
  }
  return order.map((id) => map.get(id)!);
}

export type FetchMatchesOptions = {
  /**
   * Light mode: live fixtures only (no form KV/ext/network).
   * Prefer for homepage / ?light=1 so Free Workers never 1102.
   */
  light?: boolean;
  /**
   * Allow a tiny memory+KV form merge (still no HKJC historic network).
   * Ignored when light=true.
   */
  form?: boolean;
};

/**
 * Fetch live HKJC matches via Workers-safe native GraphQL, then enrich with
 * team-targeted historic form (KV-cached) + external public form sources.
 *
 * Request path is deliberately cheap (Free Worker CPU): low historic budget,
 * cap network teams, KV-only external merge. Heavy deepen → /api/warm-ext.
 */
export async function fetchMatchesPayload(
  opts?: FetchMatchesOptions
): Promise<MatchesApiResponse> {
  const light = opts?.light === true;
  // Default board path stays cheap: form only when explicitly requested
  // or when not light (small memory+KV merge). Network historic is off.
  const wantForm = !light && opts?.form !== false;
  const now = new Date();
  const today = formatHktDate(now);
  const tomorrow = addDaysHkt(now, 1);
  const fetchedAt = now.toISOString();

  let rawMatches: RawLiveMatch[] = [];
  let liveError: string | null = null;

  try {
    rawMatches = await fetchLiveFootballMatches([]);
  } catch (err) {
    liveError =
      err instanceof Error ? err.message : "Unknown HKJC fetch error";
  }

  const rawMatchCount = rawMatches.length;
  const teamRefs = collectTeamRefs(rawMatches, today, tomorrow);
  const matchPairs = collectMatchPairs(rawMatches, today, tomorrow);

  let historic: HistoricBundle | null = null;
  let extEnriched = 0;
  let extSources: string[] = [];
  if (teamRefs.length > 0 && wantForm) {
    try {
      // Memory + capped KV only — never HKJC multi-window on the board path
      historic = await loadHistoricForTeams(teamRefs as TeamRef[], {
        matchPairs,
        budgetMs: 2_000,
        skipNetwork: true,
        maxNetworkTeams: 0,
        concurrency: 2,
        onlyZeroSample: true,
        skipDeepen: true,
        maxKvReads: 10,
      });
    } catch {
      historic = null;
    }
    // KV-only ext form merge (indexes written by /api/warm-ext).
    // Safe on board rebuild because board:v1 is cached ~3h and warm invalidates it —
    // do NOT reintroduce large outbound JSON parses on this path.
    if (historic) {
      try {
        const enriched = await enrichHistoricWithExternal(historic, teamRefs, {
          budgetMs: 2_500,
          maxLeagues: 4,
        });
        historic = enriched.bundle;
        extEnriched = enriched.stats.teamsEnriched;
        extSources = enriched.stats.sourcesUsed;
      } catch {
        // keep memory/KV historic — fixtures still returned
        if (historic.note) {
          historic.note = `${historic.note} · ext[merge-error]`;
        }
      }
    }
  } else if (teamRefs.length > 0 && light) {
    historic = null; // fixtures with Insufficient Data
  }

  const matches = rawMatches
    .map((m) => normalizeMatch(m, today, tomorrow, now, historic))
    .filter((m): m is FootballMatch => !!m)
    .sort(
      (a, b) =>
        new Date(a.kickOffTime).getTime() - new Date(b.kickOffTime).getTime()
    );

  const filteredCount = matches.length;
  const historicNote = historic?.note ?? null;
  const formCoverage = historic?.formCoverage
    ? {
        teamsWithForm: historic.formCoverage.teamsWithForm,
        total: historic.formCoverage.teamsRequested,
        teamsWithAtLeast2: historic.formCoverage.teamsWithAtLeast2,
        teamsFromKv: historic.formCoverage.teamsFromKv,
        teamsFetched: historic.formCoverage.teamsFetched,
        timedOut: historic.formCoverage.timedOut,
        lookbackDays: historic.formCoverage.lookbackDays,
        numWindows: historic.formCoverage.numWindows,
        extEnriched,
        extSources,
      }
    : null;

  if (filteredCount > 0) {
    return {
      ok: true,
      source: "live",
      error: liveError,
      timezone: "Asia/Hong_Kong",
      today,
      tomorrow,
      fetchedAt,
      matchCount: filteredCount,
      matches,
      historicNote,
      formCoverage,
      rawMatchCount,
      filteredCount,
    };
  }

  const demo = buildDemoMatches(now);
  const filterNote =
    rawMatchCount > 0
      ? `Live HKJC returned ${rawMatchCount} matches but 0 for today/tomorrow (${today}/${tomorrow}) after filter`
      : liveError
        ? `Live HKJC fetch failed: ${liveError}`
        : "Live HKJC returned no matches";

  return {
    ok: !liveError,
    source: "demo",
    error: `${filterNote}; showing demo fixtures.`,
    timezone: "Asia/Hong_Kong",
    today,
    tomorrow,
    fetchedAt,
    matchCount: demo.length,
    matches: demo,
    historicNote,
    formCoverage,
    rawMatchCount,
    filteredCount,
  };
}
