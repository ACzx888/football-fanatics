import { FootballAPI } from "hkjc-api";
import { buildDemoMatches } from "./demo-data";
import { getHistoricBundle, getTeamForm } from "./historic";
import { buildPredictions } from "./predictions";
import type { FootballMatch, MatchesApiResponse } from "./types";
import {
  addDaysHkt,
  estimateMinuteLabel,
  formatHktDate,
  hktDateFromIso,
  isInPlayStatus,
} from "./time";

type RawMatch = {
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

function normalizeMatch(
  raw: RawMatch,
  today: string,
  tomorrow: string,
  now: Date,
  historic: Awaited<ReturnType<typeof getHistoricBundle>> | null
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
 * HKJC GraphQL rejects startDate/endDate filters in this environment.
 * Fetch open matches with empty oddsTypes (schedule + live scores/corners
 * only — no foPools for prediction). Historic form is fetched in parallel
 * (process-cached ~20min) and drives all picks.
 */
export async function fetchMatchesPayload(): Promise<MatchesApiResponse> {
  const now = new Date();
  const today = formatHktDate(now);
  const tomorrow = addDaysHkt(now, 1);
  const fetchedAt = now.toISOString();

  try {
    const api = new FootballAPI();
    // Empty oddsTypes → no market pools; keeps pipeline odds-free for picks.
    const [rawMatches, historic] = await Promise.all([
      api.getAllFootballMatches({ oddsTypes: [] }),
      getHistoricBundle().catch(() => null),
    ]);

    const matches = ((rawMatches || []) as RawMatch[])
      .map((m) => normalizeMatch(m, today, tomorrow, now, historic))
      .filter((m): m is FootballMatch => !!m)
      .sort(
        (a, b) =>
          new Date(a.kickOffTime).getTime() - new Date(b.kickOffTime).getTime()
      );

    if (!matches.length) {
      const demo = buildDemoMatches(now);
      return {
        ok: true,
        source: "demo",
        error:
          "Live HKJC returned no today/tomorrow matches after filter; showing demo fixtures.",
        timezone: "Asia/Hong_Kong",
        today,
        tomorrow,
        fetchedAt,
        matchCount: demo.length,
        matches: demo,
        historicNote: historic?.note ?? null,
      };
    }

    return {
      ok: true,
      source: "live",
      error: null,
      timezone: "Asia/Hong_Kong",
      today,
      tomorrow,
      fetchedAt,
      matchCount: matches.length,
      matches,
      historicNote: historic?.note ?? null,
    };
  } catch (err) {
    const message =
      err instanceof Error ? err.message : "Unknown HKJC fetch error";
    const demo = buildDemoMatches(now);
    return {
      ok: false,
      source: "demo",
      error: `Live HKJC fetch failed: ${message}`,
      timezone: "Asia/Hong_Kong",
      today,
      tomorrow,
      fetchedAt,
      matchCount: demo.length,
      matches: demo,
      historicNote: null,
    };
  }
}
