import type { TeamForm } from "./historic";
import type {
  LiveResult,
  MatchPredictions,
  ModelSelection,
  PredictionOutcome,
  PredictionSource,
} from "./types";

/** Minimum relevant completed games per side before HAD is offered. */
export const MIN_HAD_SAMPLES = 2;

function roundPct(n: number): number {
  return Math.round(n * 10) / 10;
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}

function insufficient(reason: string): PredictionOutcome {
  return {
    available: false,
    label: "Insufficient Data",
    reason,
  };
}

function factorial(n: number): number {
  let r = 1;
  for (let i = 2; i <= n; i++) r *= i;
  return r;
}

function poissonPmf(k: number, lambda: number): number {
  if (lambda <= 0) return k === 0 ? 1 : 0;
  return (Math.exp(-lambda) * Math.pow(lambda, k)) / factorial(k);
}

/** Independent Poisson match outcome probs (home/draw/away), goals 0..maxGoals. */
export function poissonHadProbs(
  lambdaHome: number,
  lambdaAway: number,
  maxGoals = 8
): { H: number; D: number; A: number } {
  let H = 0;
  let D = 0;
  let A = 0;
  for (let i = 0; i <= maxGoals; i++) {
    for (let j = 0; j <= maxGoals; j++) {
      const p = poissonPmf(i, lambdaHome) * poissonPmf(j, lambdaAway);
      if (i > j) H += p;
      else if (i === j) D += p;
      else A += p;
    }
  }
  const s = H + D + A;
  if (s <= 0) return { H: 1 / 3, D: 1 / 3, A: 1 / 3 };
  return { H: H / s, D: D / s, A: A / s };
}

export interface PredictionContext {
  homeForm?: TeamForm | null;
  awayForm?: TeamForm | null;
  leagueAvgGoals?: number;
  /** Unused for forecast math — kept for call-site compatibility. */
  isInPlay?: boolean;
  /** Unused for forecast math — kept for call-site compatibility. */
  minuteLabel?: string | null;
  /** Unused for forecast math — Actual live stats stay on the match, not the model. */
  live?: LiveResult | null;
  historicOk?: boolean;
}

/**
 * Attack/defence rates from recent completed matches (home/away adjusted).
 * No market / HDC / odds inputs.
 */
function estimateLambdas(
  home: TeamForm | null | undefined,
  away: TeamForm | null | undefined,
  leagueAvg: number
): {
  lh: number;
  la: number;
  sampleHome: number;
  sampleAway: number;
  sample: number;
} | null {
  if (!home || !away) return null;
  const sampleHome = home.samples.length;
  const sampleAway = away.samples.length;
  if (sampleHome < MIN_HAD_SAMPLES || sampleAway < MIN_HAD_SAMPLES) return null;

  const avg = leagueAvg > 0.5 ? leagueAvg : 1.3;
  const homeScored = home.avgScoredHome;
  const homeConc = home.avgConcededHome;
  const awayScored = away.avgScoredAway;
  const awayConc = away.avgConcededAway;

  let lh = (homeScored / avg) * (awayConc / avg) * avg * 1.08; // slight home edge
  let la = (awayScored / avg) * (homeConc / avg) * avg;

  const sample = Math.min(sampleHome, sampleAway);
  // Shrink noisy rates toward league average when sample is thin
  const shrink = sample >= 8 ? 0 : sample >= 5 ? 0.15 : sample >= 3 ? 0.35 : sample >= 2 ? 0.55 : 0.65;
  lh = lh * (1 - shrink) + avg * 1.08 * shrink;
  la = la * (1 - shrink) + avg * shrink;

  lh = clamp(lh, 0.35, 3.5);
  la = clamp(la, 0.3, 3.2);
  return { lh, la, sampleHome, sampleAway, sample };
}

/** Stdev of goals-for as a crude rate-stability proxy (lower → more stable). */
function rateStability(form: TeamForm | null | undefined): number {
  if (!form || form.samples.length < 2) return 1.2;
  const vals = form.samples.map((s) => s.goalsFor);
  const mean = vals.reduce((a, b) => a + b, 0) / vals.length;
  const varSum = vals.reduce((a, v) => a + (v - mean) ** 2, 0) / vals.length;
  return Math.sqrt(varSum);
}

/**
 * Confidence from sample size, rate stability, and separation between top
 * outcomes — never from market odds.
 */
function fundamentalConfidence(
  pickPct: number,
  secondPct: number,
  sample: number,
  stability: number
): number {
  const separation = pickPct - secondPct;
  let conf = 32 + separation * 0.55 + Math.min(sample, 10) * 2.2;
  // Unstable scoring rates → lower confidence
  if (stability > 1.4) conf -= 6;
  else if (stability > 1.0) conf -= 3;
  else if (stability < 0.7) conf += 2;
  // Thin samples → lower confidence (still allow HAD at ≥2)
  if (sample <= 2) conf -= 8;
  else if (sample <= 3) conf -= 4;
  // Cap pick strength so we never invent high confidence
  conf = Math.min(conf, pickPct * 0.95);
  const confFloor = sample <= 2 ? 22 : 28;
  const confCeil = sample <= 2 ? 62 : 82;
  return roundPct(clamp(conf, confFloor, confCeil));
}

function hadPrediction(ctx: PredictionContext): PredictionOutcome {
  const lambdas = estimateLambdas(
    ctx.homeForm,
    ctx.awayForm,
    ctx.leagueAvgGoals ?? 1.3
  );
  if (!lambdas) {
    const hN = ctx.homeForm?.samples.length ?? 0;
    const aN = ctx.awayForm?.samples.length ?? 0;
    return insufficient(
      hN < MIN_HAD_SAMPLES || aN < MIN_HAD_SAMPLES
        ? `Need ≥${MIN_HAD_SAMPLES} recent games each side (have ${hN}/${aN})`
        : "No historic form for both sides"
    );
  }

  const model = poissonHadProbs(lambdas.lh, lambdas.la);

  // Tempo from combined goal rates — high tempo slightly reduces draw share
  const tempo =
    ((ctx.homeForm?.avgScored ?? 0) +
      (ctx.homeForm?.avgConceded ?? 0) +
      (ctx.awayForm?.avgScored ?? 0) +
      (ctx.awayForm?.avgConceded ?? 0)) /
    4;
  const league = ctx.leagueAvgGoals ?? 1.3;
  let H = model.H;
  let D = model.D;
  let A = model.A;
  if (tempo > league * 1.15) {
    D *= 0.92;
    const s = H + D + A;
    H /= s;
    D /= s;
    A /= s;
  }

  const entries: { code: string; label: string; pct: number }[] = [
    { code: "H", label: "Home", pct: H * 100 },
    { code: "D", label: "Draw", pct: D * 100 },
    { code: "A", label: "Away", pct: A * 100 },
  ];
  entries.sort((a, b) => b.pct - a.pct);
  const top = entries[0];
  const second = entries[1];

  const factors: string[] = ["xG model"];
  if (lambdas.sample >= 6) factors.push("form↑");
  else if (lambdas.sample <= 2) factors.push("form↓ thin");
  else factors.push("form");
  if (tempo > league * 1.15) factors.push("tempo↑");
  else if (tempo < league * 0.85) factors.push("tempo↓");

  const hf = ctx.homeForm?.formScore ?? 0;
  const af = ctx.awayForm?.formScore ?? 0;
  if (hf - af > 0.35) factors.push("home-form↑");
  else if (af - hf > 0.35) factors.push("away-form↑");

  const homeRelevant = ctx.homeForm?.homeSamples ?? 0;
  const awayRelevant = ctx.awayForm?.awaySamples ?? 0;
  if (homeRelevant >= 3 && awayRelevant >= 3) factors.push("h/a splits");

  const stability =
    (rateStability(ctx.homeForm) + rateStability(ctx.awayForm)) / 2;
  const conf = fundamentalConfidence(
    top.pct,
    second.pct,
    lambdas.sample,
    stability
  );

  const selections: ModelSelection[] = entries.map((e) => ({
    code: e.code,
    label: e.label,
    modelPct: roundPct(e.pct),
  }));

  const sources: PredictionSource[] = ["xG", "form"];
  if (factors.some((f) => f.startsWith("tempo"))) sources.push("tempo");

  return {
    available: true,
    label: top.label,
    confidencePct: conf,
    selections,
    modelProb: roundPct(top.pct),
    sources,
    factors,
    detail: [
      `Fundamental Poisson · sample ${lambdas.sampleHome}+${lambdas.sampleAway} matches`,
      `xG≈${round1(lambdas.lh)}-${round1(lambdas.la)}`,
      `sep ${round1(top.pct - second.pct)}pp · no odds`,
    ].join(" · "),
  };
}

function historicCornerAverage(
  home: TeamForm | null | undefined,
  away: TeamForm | null | undefined
): { expected: number; n: number } | null {
  const vals: number[] = [];
  for (const f of [home, away]) {
    if (!f) continue;
    for (const s of f.samples) {
      if (s.totalCorners != null && s.totalCorners >= 0) {
        vals.push(s.totalCorners);
      }
    }
  }
  if (vals.length < 3) return null;
  const expected = vals.reduce((a, b) => a + b, 0) / vals.length;
  return { expected, n: vals.length };
}

function totalCornersPrediction(ctx: PredictionContext): PredictionOutcome {
  // Fundamental / historic form only — never project from live minute or live corners.
  const factors: string[] = [];
  const sources: PredictionSource[] = [];
  let exp: number | null = null;

  const hist = historicCornerAverage(ctx.homeForm, ctx.awayForm);
  if (hist) {
    exp = hist.expected;
    factors.push("historic corners");
    sources.push("form");
  }

  if (exp == null || !hist) {
    return insufficient(
      "No historic corner averages (HKJC ttlCornerResult often -1)"
    );
  }

  exp = round1(clamp(exp, 3, 18));
  const sampleBoost = Math.min(hist.n, 8);
  const conf = roundPct(clamp(40 + sampleBoost * 2.5, 36, 78));

  return {
    available: true,
    label: `~${exp} corners`,
    confidencePct: conf,
    expectedValue: exp,
    line: null,
    modelProb: null,
    sources,
    factors,
    detail: `Historic corner avg ~${exp} from ${hist.n} samples · no odds`,
  };
}

function teamCornersPrediction(
  side: "home" | "away",
  totalExpected: number | null,
  ctx: PredictionContext
): PredictionOutcome {
  // Fundamental / historic form only — never project from live minute or live corners.
  const sideLabel = side === "home" ? "home" : "away";
  const factors: string[] = [];
  const sources: PredictionSource[] = [];
  let exp: number | null = null;

  // Historic: share of match totals when corner counts exist
  const form = side === "home" ? ctx.homeForm : ctx.awayForm;
  const histCorners: number[] = [];
  if (form) {
    for (const s of form.samples) {
      if (s.totalCorners != null && s.totalCorners >= 0) {
        // No side-split in HKJC historic — use half of total as weak prior only
        // Prefer Insufficient Data unless we have enough + attack share
        histCorners.push(s.totalCorners);
      }
    }
  }

  if (totalExpected != null && histCorners.length >= 3) {
    const homeAtt =
      ctx.homeForm?.avgScoredHome ?? ctx.homeForm?.avgScored ?? null;
    const awayAtt =
      ctx.awayForm?.avgScoredAway ?? ctx.awayForm?.avgScored ?? null;
    let share = side === "home" ? 0.55 : 0.45;
    if (homeAtt != null && awayAtt != null && homeAtt + awayAtt > 0) {
      const homeShare = homeAtt / (homeAtt + awayAtt);
      share =
        side === "home"
          ? 0.35 * 0.55 + 0.65 * homeShare
          : 1 - (0.35 * 0.55 + 0.65 * homeShare);
      factors.push("form-share");
    } else {
      factors.push("home-bias share");
    }
    exp = totalExpected * share;
    factors.push("historic corners");
    sources.push("form");
  } else if (histCorners.length >= 3 && totalExpected == null) {
    // Side estimate as ~half of team-match corner totals (weak)
    const avgTotal =
      histCorners.reduce((a, b) => a + b, 0) / histCorners.length;
    exp = avgTotal * (side === "home" ? 0.55 : 0.45);
    factors.push("historic corners");
    sources.push("form");
  }

  if (exp == null) {
    return insufficient(`No ${sideLabel} corner history for fundamental forecast`);
  }

  exp = round1(clamp(exp, 0.5, 12));
  const conf = roundPct(
    clamp(38 + (histCorners.length >= 3 ? 8 : 0), 36, 74)
  );

  return {
    available: true,
    label: `~${exp} corners`,
    confidencePct: conf,
    expectedValue: exp,
    line: null,
    modelProb: null,
    sources,
    factors,
    detail: `Fundamental ${sideLabel} corner projection · no CHH/CHA odds`,
  };
}

/** Build match predictions from fundamental signals only — never odds. */
export function buildPredictions(
  ctx: PredictionContext = {}
): MatchPredictions {
  const had = hadPrediction(ctx);
  const totalCorners = totalCornersPrediction(ctx);
  const totalExp = totalCorners.available
    ? totalCorners.expectedValue ?? null
    : null;

  return {
    had,
    totalCorners,
    homeCorners: teamCornersPrediction("home", totalExp, ctx),
    awayCorners: teamCornersPrediction("away", totalExp, ctx),
    method: "fundamental-only / no odds",
  };
}
