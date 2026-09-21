import { buildDemoMatches } from "./demo-data";
import { getHistoricBundleSoft, getTeamForm } from "./historic";
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
  historic: Awaited<ReturnType<typeof getHistoricBundleSoft>>
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

/**
 * Fetch live HKJC matches via Workers-safe native GraphQL, then enrich with
 * soft-timeout historic form. Prefer live matches (even with Incomplete
 * Data) over demo fixtures whenever the live list is non-empty after filter.
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

  // Soft historic: never block the live schedule on a cold ~15s fill.
  const historic = await getHistoricBundleSoft(4_000).catch(() => null);

  const matches = rawMatches
    .map((m) => normalizeMatch(m, today, tomorrow, now, historic))
    .filter((m): m is FootballMatch => !!m)
    .sort(
      (a, b) =>
        new Date(a.kickOffTime).getTime() - new Date(b.kickOffTime).getTime()
    );

  const filteredCount = matches.length;
  const historicNote = historic?.note ?? null;

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
    rawMatchCount,
    filteredCount,
  };
}
