import type { TeamForm, TeamMatchSample } from "./historic";
import { buildPredictions } from "./predictions";
import type { FootballMatch } from "./types";
import {
  addDaysHkt,
  formatHktDate,
  estimateMinuteLabel,
  isInPlayStatus,
} from "./time";

function sample(
  partial: Omit<TeamMatchSample, "opponentId" | "opponentName"> & {
    opponentId?: string;
    opponentName?: string;
  }
): TeamMatchSample {
  return {
    opponentId: partial.opponentId ?? "opp",
    opponentName: partial.opponentName ?? "Opp",
    ...partial,
  };
}

function formFrom(
  teamId: string,
  teamName: string,
  samples: TeamMatchSample[]
): TeamForm {
  const home = samples.filter((s) => s.isHome);
  const away = samples.filter((s) => !s.isHome);
  const avg = (nums: number[]) =>
    nums.length ? nums.reduce((a, b) => a + b, 0) / nums.length : 0;
  const pts = samples.reduce(
    (a, s) => a + (s.result === "W" ? 3 : s.result === "D" ? 1 : 0),
    0
  );
  const formVals = samples.map((s) =>
    s.result === "W" ? 1 : s.result === "D" ? 0 : -1
  );
  let wSum = 0;
  let wTot = 0;
  formVals.forEach((v, i) => {
    const w = 1 + (formVals.length - 1 - i) * 0.08;
    wSum += v * w;
    wTot += w;
  });
  return {
    teamId,
    teamName,
    samples,
    ppg: pts / samples.length,
    avgScored: avg(samples.map((s) => s.goalsFor)),
    avgConceded: avg(samples.map((s) => s.goalsAgainst)),
    avgScoredHome: home.length
      ? avg(home.map((s) => s.goalsFor))
      : avg(samples.map((s) => s.goalsFor)),
    avgConcededHome: home.length
      ? avg(home.map((s) => s.goalsAgainst))
      : avg(samples.map((s) => s.goalsAgainst)),
    avgScoredAway: away.length
      ? avg(away.map((s) => s.goalsFor))
      : avg(samples.map((s) => s.goalsFor)),
    avgConcededAway: away.length
      ? avg(away.map((s) => s.goalsAgainst))
      : avg(samples.map((s) => s.goalsAgainst)),
    formScore: wTot > 0 ? wSum / wTot : 0,
    homeSamples: home.length,
    awaySamples: away.length,
  };
}

/** Deterministic demo fixtures for today/tomorrow when live HKJC is unavailable. */
export function buildDemoMatches(now = new Date()): FootballMatch[] {
  const today = formatHktDate(now);
  const tomorrow = addDaysHkt(now, 1);

  const mkKick = (day: string, hh: number, mm: number) =>
    `${day}T${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}:00.000+08:00`;

  const harbour = formFrom("demo-h1", "Harbour FC", [
    sample({ matchId: "h1", date: today, isHome: true, goalsFor: 2, goalsAgainst: 0, result: "W", totalCorners: 11 }),
    sample({ matchId: "h2", date: today, isHome: true, goalsFor: 1, goalsAgainst: 1, result: "D", totalCorners: 9 }),
    sample({ matchId: "h3", date: today, isHome: true, goalsFor: 3, goalsAgainst: 1, result: "W", totalCorners: 12 }),
    sample({ matchId: "h4", date: today, isHome: false, goalsFor: 1, goalsAgainst: 0, result: "W", totalCorners: 8 }),
    sample({ matchId: "h5", date: today, isHome: true, goalsFor: 2, goalsAgainst: 1, result: "W", totalCorners: 10 }),
  ]);
  const peak = formFrom("demo-a1", "Peak Rovers", [
    sample({ matchId: "p1", date: today, isHome: false, goalsFor: 0, goalsAgainst: 2, result: "L", totalCorners: 7 }),
    sample({ matchId: "p2", date: today, isHome: false, goalsFor: 1, goalsAgainst: 1, result: "D", totalCorners: 9 }),
    sample({ matchId: "p3", date: today, isHome: true, goalsFor: 1, goalsAgainst: 2, result: "L", totalCorners: 8 }),
    sample({ matchId: "p4", date: today, isHome: false, goalsFor: 0, goalsAgainst: 1, result: "L", totalCorners: 6 }),
  ]);
  const costa = formFrom("demo-h2", "Costa Norte", [
    sample({ matchId: "c1", date: today, isHome: true, goalsFor: 1, goalsAgainst: 1, result: "D", totalCorners: null }),
    sample({ matchId: "c2", date: today, isHome: true, goalsFor: 2, goalsAgainst: 0, result: "W", totalCorners: null }),
    sample({ matchId: "c3", date: today, isHome: false, goalsFor: 0, goalsAgainst: 0, result: "D", totalCorners: null }),
    sample({ matchId: "c4", date: today, isHome: true, goalsFor: 1, goalsAgainst: 2, result: "L", totalCorners: null }),
  ]);
  const sierra = formFrom("demo-a2", "Sierra Sur", [
    sample({ matchId: "s1", date: today, isHome: false, goalsFor: 1, goalsAgainst: 0, result: "W", totalCorners: null }),
    sample({ matchId: "s2", date: today, isHome: false, goalsFor: 2, goalsAgainst: 2, result: "D", totalCorners: null }),
    sample({ matchId: "s3", date: today, isHome: true, goalsFor: 1, goalsAgainst: 1, result: "D", totalCorners: null }),
  ]);
  const azzurro = formFrom("demo-h3", "Azzurro City", [
    sample({ matchId: "a1", date: today, isHome: true, goalsFor: 3, goalsAgainst: 0, result: "W", totalCorners: null }),
    sample({ matchId: "a2", date: today, isHome: true, goalsFor: 2, goalsAgainst: 1, result: "W", totalCorners: null }),
    sample({ matchId: "a3", date: today, isHome: true, goalsFor: 1, goalsAgainst: 0, result: "W", totalCorners: null }),
    sample({ matchId: "a4", date: today, isHome: false, goalsFor: 2, goalsAgainst: 0, result: "W", totalCorners: null }),
    sample({ matchId: "a5", date: today, isHome: true, goalsFor: 2, goalsAgainst: 2, result: "D", totalCorners: null }),
  ]);
  const verde = formFrom("demo-a3", "Verde United", [
    sample({ matchId: "v1", date: today, isHome: false, goalsFor: 0, goalsAgainst: 2, result: "L", totalCorners: null }),
    sample({ matchId: "v2", date: today, isHome: false, goalsFor: 1, goalsAgainst: 3, result: "L", totalCorners: null }),
    sample({ matchId: "v3", date: today, isHome: true, goalsFor: 0, goalsAgainst: 1, result: "L", totalCorners: null }),
  ]);
  // Sparse form → Insufficient Data for HAD
  const rhein = formFrom("demo-h4", "Rhein 04", [
    sample({ matchId: "r1", date: tomorrow, isHome: true, goalsFor: 1, goalsAgainst: 0, result: "W", totalCorners: null }),
  ]);
  const nord = formFrom("demo-a4", "Nordstern", [
    sample({ matchId: "n1", date: tomorrow, isHome: false, goalsFor: 0, goalsAgainst: 1, result: "L", totalCorners: null }),
    sample({ matchId: "n2", date: tomorrow, isHome: false, goalsFor: 1, goalsAgainst: 1, result: "D", totalCorners: null }),
  ]);
  const dam = formFrom("demo-h5", "Dam Oranje", [
    sample({ matchId: "d1", date: tomorrow, isHome: true, goalsFor: 2, goalsAgainst: 1, result: "W", totalCorners: 13 }),
    sample({ matchId: "d2", date: tomorrow, isHome: true, goalsFor: 3, goalsAgainst: 1, result: "W", totalCorners: 14 }),
    sample({ matchId: "d3", date: tomorrow, isHome: false, goalsFor: 1, goalsAgainst: 1, result: "D", totalCorners: 11 }),
    sample({ matchId: "d4", date: tomorrow, isHome: true, goalsFor: 2, goalsAgainst: 0, result: "W", totalCorners: 12 }),
  ]);
  const canal = formFrom("demo-a5", "Canal Blues", [
    sample({ matchId: "cb1", date: tomorrow, isHome: false, goalsFor: 1, goalsAgainst: 2, result: "L", totalCorners: 10 }),
    sample({ matchId: "cb2", date: tomorrow, isHome: false, goalsFor: 0, goalsAgainst: 1, result: "L", totalCorners: 9 }),
    sample({ matchId: "cb3", date: tomorrow, isHome: true, goalsFor: 1, goalsAgainst: 1, result: "D", totalCorners: 11 }),
  ]);

  const samples: Array<{
    id: string;
    frontEndId: string;
    kickOffTime: string;
    status: string;
    league: string;
    leagueCode: string;
    homeTeam: string;
    awayTeam: string;
    dayBucket: "today" | "tomorrow";
    live?: FootballMatch["live"];
    homeForm: TeamForm;
    awayForm: TeamForm;
  }> = [
    {
      id: "demo-1",
      frontEndId: "DEMO01",
      kickOffTime: mkKick(today, 9, 30),
      status: "SECONDHALF",
      league: "Demo Premier League",
      leagueCode: "DPL",
      homeTeam: "Harbour FC",
      awayTeam: "Peak Rovers",
      dayBucket: "today",
      live: {
        homeScore: 2,
        awayScore: 1,
        corner: 9,
        homeCorner: 6,
        awayCorner: 3,
      },
      homeForm: harbour,
      awayForm: peak,
    },
    {
      id: "demo-2",
      frontEndId: "DEMO02",
      kickOffTime: mkKick(today, 15, 0),
      status: "PREEVENT",
      league: "Demo La Liga",
      leagueCode: "DLL",
      homeTeam: "Costa Norte",
      awayTeam: "Sierra Sur",
      dayBucket: "today",
      homeForm: costa,
      awayForm: sierra,
    },
    {
      id: "demo-3",
      frontEndId: "DEMO03",
      kickOffTime: mkKick(today, 20, 0),
      status: "PREEVENT",
      league: "Demo Serie A",
      leagueCode: "DSA",
      homeTeam: "Azzurro City",
      awayTeam: "Verde United",
      dayBucket: "today",
      homeForm: azzurro,
      awayForm: verde,
    },
    {
      id: "demo-4",
      frontEndId: "DEMO04",
      kickOffTime: mkKick(tomorrow, 3, 0),
      status: "PREEVENT",
      league: "Demo Bundesliga",
      leagueCode: "DBL",
      homeTeam: "Rhein 04",
      awayTeam: "Nordstern",
      dayBucket: "tomorrow",
      homeForm: rhein,
      awayForm: nord,
    },
    {
      id: "demo-5",
      frontEndId: "DEMO05",
      kickOffTime: mkKick(tomorrow, 19, 45),
      status: "PREEVENT",
      league: "Demo Eredivisie",
      leagueCode: "DER",
      homeTeam: "Dam Oranje",
      awayTeam: "Canal Blues",
      dayBucket: "tomorrow",
      homeForm: dam,
      awayForm: canal,
    },
  ];

  return samples.map((s) => {
    const isInPlay = isInPlayStatus(s.status);
    const minuteLabel = estimateMinuteLabel(s.kickOffTime, s.status, now);
    return {
      id: s.id,
      frontEndId: s.frontEndId,
      kickOffTime: s.kickOffTime,
      matchDate: s.dayBucket === "today" ? today : tomorrow,
      status: s.status,
      league: s.league,
      leagueCode: s.leagueCode,
      homeTeam: s.homeTeam,
      awayTeam: s.awayTeam,
      isInPlay,
      minuteLabel,
      live: s.live ?? null,
      predictions: buildPredictions({
        homeForm: s.homeForm,
        awayForm: s.awayForm,
        leagueAvgGoals: 1.35,
        isInPlay,
        minuteLabel,
        live: s.live ?? null,
        historicOk: true,
      }),
      dayBucket: s.dayBucket,
    };
  });
}
