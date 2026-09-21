export type MatchStatus =
  | "PREEVENT"
  | "FIRSTHALF"
  | "HALFTIME"
  | "SECONDHALF"
  | "FULLTIME"
  | "ENDED"
  | "POSTPONED"
  | "CANCELLED"
  | "UNKNOWN"
  | string;

/** Prediction provenance — fundamental only (never odds/market). */
export type PredictionSource = "form" | "xG" | "inplay" | "tempo";

export interface ModelSelection {
  code: string;
  label: string;
  /** Model probability 0–100 (fundamental, not market-implied). */
  modelPct: number;
}

export interface PredictionOutcome {
  available: boolean;
  label?: string;
  confidencePct?: number;
  detail?: string;
  /** Model outcome breakdown (HAD etc.) — never odds. */
  selections?: ModelSelection[];
  line?: number | null;
  expectedValue?: number | null;
  reason?: string;
  /** Fundamental model probability for the picked outcome (0–100). */
  modelProb?: number | null;
  sources?: PredictionSource[];
  factors?: string[];
}

export interface MatchPredictions {
  had: PredictionOutcome;
  totalCorners: PredictionOutcome;
  homeCorners: PredictionOutcome;
  awayCorners: PredictionOutcome;
  method: string;
}

export interface LiveResult {
  homeScore: number | null;
  awayScore: number | null;
  corner: number | null;
  homeCorner: number | null;
  awayCorner: number | null;
}

export interface FootballMatch {
  id: string;
  frontEndId: string;
  kickOffTime: string;
  matchDate: string;
  status: MatchStatus;
  league: string;
  leagueCode: string;
  homeTeam: string;
  awayTeam: string;
  homeTeamCh?: string;
  awayTeamCh?: string;
  homeTeamId?: string;
  awayTeamId?: string;
  isInPlay: boolean;
  minuteLabel: string | null;
  live: LiveResult | null;
  predictions: MatchPredictions;
  dayBucket: "today" | "tomorrow";
}

export interface MatchesApiResponse {
  ok: boolean;
  source: "live" | "demo";
  error?: string | null;
  timezone: string;
  today: string;
  tomorrow: string;
  fetchedAt: string;
  matchCount: number;
  matches: FootballMatch[];
  /** Present when historic form was partially/fully used. */
  historicNote?: string | null;
  /** Raw HKJC match count before today/tomorrow filter. */
  rawMatchCount?: number;
  /** Matches remaining after today/tomorrow HKT filter. */
  filteredCount?: number;
  /** Debug: how many scheduled teams have historic form samples. */
  formCoverage?: {
    teamsWithForm: number;
    total: number;
    teamsWithAtLeast2?: number;
    teamsFromKv?: number;
    teamsFetched?: number;
    timedOut?: boolean;
  } | null;
}
