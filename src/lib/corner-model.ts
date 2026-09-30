/**
 * Corner expectation helpers — fundamental only (never odds).
 *
 * Priority:
 *  1) Historic totalCorners on TeamMatchSample (when HKJC ttlCornerResult ≥ 0)
 *  2) Labeled goals/tempo proxy from Poisson λ / attack rates
 *
 * Empirical anchors (top-flight open-play averages, published-ish):
 *  - ~10.0–10.5 total corners / match
 *  - ~2.6–2.8 goals / match
 *  - corners scale gently with combined attack tempo (goals λ as shots proxy)
 */

/** Typical total corners when goal tempo is near league average. */
export const LEAGUE_CORNER_BASE = 10.2;

/**
 * Extra corners per extra combined expected goal above league total.
 * e.g. λh+λa = league+1 → +~1.7 corners.
 */
export const CORNERS_PER_EXTRA_GOAL = 1.7;

/** Soft clamps for honesty (avoid absurd projections). */
export const CORNER_TOTAL_MIN = 5;
export const CORNER_TOTAL_MAX = 16;
export const CORNER_SIDE_MIN = 0.8;
export const CORNER_SIDE_MAX = 11;

export type CornerEstimateKind = "historic" | "goals-proxy" | "tempo-proxy" | "blend";

export type CornerTotalEstimate = {
  expected: number;
  nHistoric: number;
  kind: CornerEstimateKind;
  /** Human factors for UI chips */
  factors: string[];
};

/**
 * Map combined goal λ (and optional form tempo) → expected total corners.
 * Labeled as goals-proxy / tempo-proxy — never "historic corners".
 */
export function cornersFromGoalTempo(
  lambdaHome: number,
  lambdaAway: number,
  leagueAvgGoals: number,
  formTempo?: number | null
): { expected: number; factors: string[] } {
  const league = leagueAvgGoals > 0.5 ? leagueAvgGoals : 1.3;
  const leagueTotal = league * 2;
  const combined = Math.max(0.4, lambdaHome + lambdaAway);
  const goalDelta = combined - leagueTotal;

  let expected = LEAGUE_CORNER_BASE + CORNERS_PER_EXTRA_GOAL * goalDelta;
  const factors: string[] = ["goals-proxy"];

  // Form tempo (avg scored+conceded across both sides) nudges when available
  if (formTempo != null && formTempo > 0) {
    const tempoRatio = formTempo / league;
    // Mild blend: ±8% around the goals-proxy when tempo disagrees
    const tempoAdj = (tempoRatio - 1) * 0.8;
    expected = expected * (1 + Math.max(-0.12, Math.min(0.12, tempoAdj)));
    factors.push("tempo-proxy");
  }

  expected = Math.max(CORNER_TOTAL_MIN, Math.min(CORNER_TOTAL_MAX, expected));
  return { expected, factors };
}

/** Attack-share split for team corners (slight home bias when rates missing). */
export function cornerSideShare(
  side: "home" | "away",
  lambdaHome: number | null,
  lambdaAway: number | null,
  homeAtt: number | null,
  awayAtt: number | null
): { share: number; factor: string } {
  const h =
    lambdaHome != null && lambdaAway != null && lambdaHome + lambdaAway > 0
      ? lambdaHome / (lambdaHome + lambdaAway)
      : homeAtt != null && awayAtt != null && homeAtt + awayAtt > 0
        ? homeAtt / (homeAtt + awayAtt)
        : null;

  if (h != null) {
    const homeShare = 0.35 * 0.55 + 0.65 * h;
    return {
      share: side === "home" ? homeShare : 1 - homeShare,
      factor: "form-share",
    };
  }
  return {
    share: side === "home" ? 0.55 : 0.45,
    factor: "home-bias share",
  };
}
