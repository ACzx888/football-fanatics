import { buildDemoMatches } from "./demo-data";
import {
  getTeamForm,
  loadHistoricForTeams,
  type HistoricBundle,
  type TeamRef,
} from "./historic";
import {
  fetchLiveFootballMatches,
  type RawLiveMatch,
} from "./hkjc-graphql";
import { buildPredictions } from "./predictions";
import type { FootballMatch, MatchesApiResponse } from "./types";
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

  const predictions = buildPredictions({
    homeForm,
    awayForm,
    leagueAvgGoals: historic?.leagueAvgGoals ?? 1.3,
    isInPlay,
    minuteLabel,
    live,
    historicOk: !!(historic?.ok && (homeForm || awayForm)),
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

function collectTeamRefs(rawMatches: RawLiveMatch[], today: string, tomorrow: string): TeamRef[] {
  const map = new Map<string, string>();
  const order: string[] = [];
  for (const raw of rawMatches) {
    if (!raw.kickOffTime) continue;
    const day = hktDateFromIso(raw.kickOffTime);
    if (day !== today && day !== tomorrow) continue;
    // Interleave home/away so pair fetches stay adjacent under a budget cut-off
    for (const team of [raw.homeTeam, raw.awayTeam]) {
      if (!team?.id) continue;
      if (!map.has(team.id)) {
        map.set(team.id, team.name_en || team.id);
        order.push(team.id);
      }
    }
  }
  return order.map((id) => ({ id, name: map.get(id)! }));
}

/**
 * Fetch live HKJC matches via Workers-safe native GraphQL, then enrich with
 * team-targeted historic form (KV-cached). Prefer live matches (even with
 * Incomplete Data) over demo fixtures whenever the filtered list is non-empty.
 */
export async function fetchMatchesPayload(): Promise<MatchesApiResponse> {
  const now = new Date();
  const today = formatHktDate(now);
  const tomorrow = addDaysHkt(now, 1);
  const fetchedAt = now.toISOString();

  let rawMatches: RawLiveMatch[] = [];
  let liveError: string | null = null;

  try {
    // Empty oddsTypes → foPools empty; whitelist still satisfied.
    rawMatches = await fetchLiveFootballMatches([]);
  } catch (err) {
    liveError =
      err instanceof Error ? err.message : "Unknown HKJC fetch error";
  }

  const rawMatchCount = rawMatches.length;
  const teamRefs = collectTeamRefs(rawMatches, today, tomorrow);
  const matchPairs = collectMatchPairs(rawMatches, today, tomorrow);

  let historic: HistoricBundle | null = null;
  if (teamRefs.length > 0) {
    try {
      historic = await loadHistoricForTeams(teamRefs, {
        matchPairs,
      });
    } catch {
      historic = null;
    }
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

  // No today/tomorrow matches after filter — only then fall back to demo.
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
