import type { TeamForm } from "./historic";
import {
  CORNER_SIDE_MAX,
  CORNER_SIDE_MIN,
  CORNER_TOTAL_MAX,
  CORNER_TOTAL_MIN,
  cornerSideShare,
  cornersFromGoalTempo,
} from "./corner-model";
import type {
  LiveResult,
  MatchPredictions,
  ModelSelection,
  PredictionOutcome,
  PredictionSource,
} from "./types";

/**
 * Preferred minimum completed games per side for HAD / team scores.
 * Soft fallback MIN_HAD_SAMPLES_FALLBACK allows 1+1 with heavier shrink when
 * wider historic lookback still cannot reach 2+2 (internationals / sparse clubs).
 */
export const MIN_HAD_SAMPLES = 2;
/** Last-resort gate after stacked historic windows — documented as form↓ thin. */
export const MIN_HAD_SAMPLES_FALLBACK = 1;

function roundPct(n: number): number {
  return Math.round(n * 10) / 10;
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}


function withFormSources(
  sources: PredictionSource[],
  formSources?: PredictionSource[]
): PredictionSource[] {
  const out = new Set<PredictionSource>(sources);
  for (const s of formSources || []) {
    if (
      s === "hkjc" ||
      s === "football-data" ||
      s === "football-data-org" ||
      s === "api-football" ||
      s === "fotmob" ||
      s === "thesportsdb" ||
      s === "openligadb" ||
      s === "understat" ||
      s === "form"
    ) {
      out.add(s);
    }
  }
  return [...out];
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
  /** Honest provenance chips from HKJC ∪ external enrichers. */
  formSources?: PredictionSource[];
}

type LambdaEstimate = {
  lh: number;
  la: number;
  sampleHome: number;
  sampleAway: number;
  sample: number;
};

/**
 * Attack/defence rates from recent completed matches (home/away adjusted).
 * No market / HDC / odds inputs.
 */
function estimateLambdas(
  home: TeamForm | null | undefined,
  away: TeamForm | null | undefined,
  leagueAvg: number
): LambdaEstimate | null {
  if (!home || !away) return null;
  const sampleHome = home.samples.length;
  const sampleAway = away.samples.length;
  // Prefer ≥2 each side; allow 1+1 only as last-resort after wider historic fetch.
  if (
    sampleHome < MIN_HAD_SAMPLES_FALLBACK ||
    sampleAway < MIN_HAD_SAMPLES_FALLBACK
  ) {
    return null;
  }

  const avg = leagueAvg > 0.5 ? leagueAvg : 1.3;
  const homeScored = home.avgScoredHome;
  const homeConc = home.avgConcededHome;
  const awayScored = away.avgScoredAway;
  const awayConc = away.avgConcededAway;

  let lh = (homeScored / avg) * (awayConc / avg) * avg * 1.08; // slight home edge
  let la = (awayScored / avg) * (homeConc / avg) * avg;

  const sample = Math.min(sampleHome, sampleAway);
  // Shrink noisy rates toward league average when sample is thin (heavier at 1)
  const shrink =
    sample >= 8
      ? 0
      : sample >= 5
        ? 0.15
        : sample >= 3
          ? 0.35
          : sample >= 2
            ? 0.55
            : 0.78;
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
  // Thin samples → lower confidence (1+1 fallback capped harder)
  if (sample <= 1) conf -= 14;
  else if (sample <= 2) conf -= 8;
  else if (sample <= 3) conf -= 4;
  // Cap pick strength so we never invent high confidence
  conf = Math.min(conf, pickPct * 0.95);
  const confFloor = sample <= 1 ? 18 : sample <= 2 ? 22 : 28;
  const confCeil = sample <= 1 ? 48 : sample <= 2 ? 62 : 82;
  return roundPct(clamp(conf, confFloor, confCeil));
}

/** Sample-based confidence for expected goals (fundamental only — no odds). */
function goalsConfidence(sample: number, stability: number): number {
  let conf = 38 + Math.min(sample, 10) * 2.5;
  if (stability > 1.4) conf -= 6;
  else if (stability > 1.0) conf -= 3;
  else if (stability < 0.7) conf += 2;
  if (sample <= 1) conf -= 14;
  else if (sample <= 2) conf -= 8;
  else if (sample <= 3) conf -= 4;
  const confFloor = sample <= 1 ? 18 : sample <= 2 ? 22 : 28;
  const confCeil = sample <= 1 ? 46 : sample <= 2 ? 62 : 78;
  return roundPct(clamp(conf, confFloor, confCeil));
}

function insufficientLambdas(ctx: PredictionContext): PredictionOutcome {
  const hN = ctx.homeForm?.samples.length ?? 0;
  const aN = ctx.awayForm?.samples.length ?? 0;
  return insufficient(
    hN < MIN_HAD_SAMPLES_FALLBACK || aN < MIN_HAD_SAMPLES_FALLBACK
      ? `Need ≥${MIN_HAD_SAMPLES_FALLBACK} recent games each side (have ${hN}/${aN}; prefer ≥${MIN_HAD_SAMPLES})`
      : "No historic form for both sides"
  );
}

function hadPrediction(
  ctx: PredictionContext,
  lambdas: LambdaEstimate | null
): PredictionOutcome {
  if (!lambdas) return insufficientLambdas(ctx);

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
  else if (lambdas.sample <= 1) factors.push("form↓ thin (1+1)");
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

  let sources: PredictionSource[] = ["xG", "form"];
  if (factors.some((f) => f.startsWith("tempo"))) sources.push("tempo");
  sources = withFormSources(sources, ctx.formSources);

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

/**
 * Team expected goals from the same Poisson λ as HAD.
 * Locked once written — never re-projected from live score.
 */
function teamGoalsPrediction(
  side: "home" | "away",
  ctx: PredictionContext,
  lambdas: LambdaEstimate | null
): PredictionOutcome {
  if (!lambdas) return insufficientLambdas(ctx);

  const exp = round1(side === "home" ? lambdas.lh : lambdas.la);
  const other = round1(side === "home" ? lambdas.la : lambdas.lh);
  const scoreline = `~${round1(lambdas.lh)} – ${round1(lambdas.la)}`;

  const factors: string[] = ["xG model"];
  if (lambdas.sample >= 6) factors.push("form↑");
  else if (lambdas.sample <= 1) factors.push("form↓ thin (1+1)");
  else if (lambdas.sample <= 2) factors.push("form↓ thin");
  else factors.push("form");

  const homeRelevant = ctx.homeForm?.homeSamples ?? 0;
  const awayRelevant = ctx.awayForm?.awaySamples ?? 0;
  if (homeRelevant >= 3 && awayRelevant >= 3) factors.push("h/a splits");

  const stability =
    (rateStability(ctx.homeForm) + rateStability(ctx.awayForm)) / 2;
  const conf = goalsConfidence(lambdas.sample, stability);

  const sideLabel = side === "home" ? "Home" : "Away";

  return {
    available: true,
    label: `~${exp} goals`,
    confidencePct: conf,
    expectedValue: exp,
    line: null,
    modelProb: null,
    sources: withFormSources(["xG", "form"], ctx.formSources),
    factors,
    detail: [
      `${sideLabel} λ=${exp} · scoreline ${scoreline}`,
      `sample ${lambdas.sampleHome}+${lambdas.sampleAway}`,
      `vs ${other} · no odds / no inplay rate`,
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

function formTempoRate(
  home: TeamForm | null | undefined,
  away: TeamForm | null | undefined
): number | null {
  if (!home || !away) return null;
  return (
    (home.avgScored + home.avgConceded + away.avgScored + away.avgConceded) / 4
  );
}

function proxyCornerConfidence(sample: number, kind: string): number {
  // Proxy is deliberately lower-confidence than real historic corners
  let conf = 30 + Math.min(sample, 8) * 2.2;
  if (kind === "blend") conf += 6;
  if (sample <= 1) conf -= 8;
  else if (sample <= 2) conf -= 4;
  return roundPct(clamp(conf, 22, 58));
}

function historicCornerConfidence(n: number): number {
  const sampleBoost = Math.min(n, 8);
  return roundPct(clamp(40 + sampleBoost * 2.5, 36, 78));
}

function totalCornersPrediction(
  ctx: PredictionContext,
  lambdas: LambdaEstimate | null
): PredictionOutcome {
  // Fundamental only — never odds, never live minute projection.
  const factors: string[] = [];
  const sources: PredictionSource[] = [];
  let exp: number | null = null;
  let detailParts: string[] = [];
  let conf = 36;

  const hist = historicCornerAverage(ctx.homeForm, ctx.awayForm);
  const tempo = formTempoRate(ctx.homeForm, ctx.awayForm);
  let proxy: { expected: number; factors: string[] } | null = null;
  if (lambdas) {
    proxy = cornersFromGoalTempo(
      lambdas.lh,
      lambdas.la,
      ctx.leagueAvgGoals ?? 1.3,
      tempo
    );
  }

  if (hist && proxy) {
    // Prefer historic; lightly blend when sample is thin (3–4)
    const wHist = hist.n >= 6 ? 0.85 : hist.n >= 5 ? 0.75 : 0.6;
    exp = hist.expected * wHist + proxy.expected * (1 - wHist);
    factors.push("historic corners");
    factors.push(...proxy.factors);
    sources.push("form", "goals-proxy");
    if (proxy.factors.includes("tempo-proxy")) sources.push("tempo-proxy");
    conf = historicCornerConfidence(hist.n);
    // Blend slightly lowers confidence vs pure historic
    conf = roundPct(clamp(conf - 4, 34, 74));
    detailParts = [
      `Historic+proxy blend ~${round1(exp)}`,
      `${hist.n} corner samples`,
      `λ-tempo ${round1(lambdas!.lh + lambdas!.la)}`,
      "no odds",
    ];
  } else if (hist) {
    exp = hist.expected;
    factors.push("historic corners");
    sources.push("form");
    conf = historicCornerConfidence(hist.n);
    detailParts = [
      `Historic corner avg ~${round1(exp)} from ${hist.n} samples`,
      "no odds",
    ];
  } else if (proxy && lambdas) {
    exp = proxy.expected;
    factors.push(...proxy.factors);
    sources.push("goals-proxy");
    if (proxy.factors.includes("tempo-proxy")) sources.push("tempo-proxy");
    sources.push("xG");
    conf = proxyCornerConfidence(lambdas.sample, "goals-proxy");
    detailParts = [
      `Goals/tempo proxy ~${round1(exp)}`,
      `from xG ${round1(lambdas.lh)}-${round1(lambdas.la)}`,
      `sample ${lambdas.sampleHome}+${lambdas.sampleAway}`,
      "not historic corners · no odds",
    ];
  }

  if (exp == null) {
    return insufficient(
      lambdas
        ? "No corner history and goal-tempo proxy unavailable"
        : "No historic corner averages (HKJC ttlCornerResult often -1); need form for goals-proxy"
    );
  }

  exp = round1(clamp(exp, CORNER_TOTAL_MIN, CORNER_TOTAL_MAX));

  return {
    available: true,
    label: `~${exp} corners`,
    confidencePct: conf,
    expectedValue: exp,
    line: null,
    modelProb: null,
    sources: withFormSources([...new Set(sources)], ctx.formSources),
    factors,
    detail: detailParts.join(" · "),
  };
}

function teamCornersPrediction(
  side: "home" | "away",
  totalExpected: number | null,
  ctx: PredictionContext,
  lambdas: LambdaEstimate | null
): PredictionOutcome {
  // Fundamental only — never odds / CHH / CHA.
  const sideLabel = side === "home" ? "home" : "away";
  const factors: string[] = [];
  const sources: PredictionSource[] = [];
  let exp: number | null = null;

  const form = side === "home" ? ctx.homeForm : ctx.awayForm;
  const histCorners: number[] = [];
  if (form) {
    for (const s of form.samples) {
      if (s.totalCorners != null && s.totalCorners >= 0) {
        histCorners.push(s.totalCorners);
      }
    }
  }

  const homeAtt =
    ctx.homeForm?.avgScoredHome ?? ctx.homeForm?.avgScored ?? null;
  const awayAtt =
    ctx.awayForm?.avgScoredAway ?? ctx.awayForm?.avgScored ?? null;
  const { share, factor: shareFactor } = cornerSideShare(
    side,
    lambdas?.lh ?? null,
    lambdas?.la ?? null,
    homeAtt,
    awayAtt
  );

  if (totalExpected != null) {
    exp = totalExpected * share;
    factors.push(shareFactor);
    // Inherit provenance from total path via factors on total; label side path
    if (histCorners.length >= 3) {
      factors.push("historic corners");
      sources.push("form");
    } else if (lambdas) {
      factors.push("goals-proxy");
      sources.push("goals-proxy", "xG");
    } else {
      factors.push("historic corners");
      sources.push("form");
    }
  } else if (histCorners.length >= 3) {
    const avgTotal =
      histCorners.reduce((a, b) => a + b, 0) / histCorners.length;
    exp = avgTotal * share;
    factors.push(shareFactor, "historic corners");
    sources.push("form");
  } else if (lambdas) {
    const tempo = formTempoRate(ctx.homeForm, ctx.awayForm);
    const proxy = cornersFromGoalTempo(
      lambdas.lh,
      lambdas.la,
      ctx.leagueAvgGoals ?? 1.3,
      tempo
    );
    exp = proxy.expected * share;
    factors.push(shareFactor, ...proxy.factors);
    sources.push("goals-proxy", "xG");
    if (proxy.factors.includes("tempo-proxy")) sources.push("tempo-proxy");
  }

  if (exp == null) {
    return insufficient(
      `No ${sideLabel} corner history or goals-proxy (need form samples)`
    );
  }

  exp = round1(clamp(exp, CORNER_SIDE_MIN, CORNER_SIDE_MAX));
  const conf = roundPct(
    clamp(
      histCorners.length >= 3
        ? 38 + Math.min(histCorners.length, 6)
        : lambdas
          ? proxyCornerConfidence(lambdas.sample, "goals-proxy")
          : 36,
      22,
      74
    )
  );

  return {
    available: true,
    label: `~${exp} corners`,
    confidencePct: conf,
    expectedValue: exp,
    line: null,
    modelProb: null,
    sources: withFormSources([...new Set(sources)], ctx.formSources),
    factors,
    detail: `Fundamental ${sideLabel} corner projection · no CHH/CHA odds`,
  };
}

/** Build match predictions from fundamental signals only — never odds. */
export function buildPredictions(
  ctx: PredictionContext = {}
): MatchPredictions {
  // Shared Poisson λs feed both HAD and team-score outcomes (computed once).
  const lambdas = estimateLambdas(
    ctx.homeForm,
    ctx.awayForm,
    ctx.leagueAvgGoals ?? 1.3
  );

  const had = hadPrediction(ctx, lambdas);
  const homeGoals = teamGoalsPrediction("home", ctx, lambdas);
  const awayGoals = teamGoalsPrediction("away", ctx, lambdas);

  const totalCorners = totalCornersPrediction(ctx, lambdas);
  const totalExp = totalCorners.available
    ? totalCorners.expectedValue ?? null
    : null;

  return {
    had,
    totalCorners,
    homeCorners: teamCornersPrediction("home", totalExp, ctx, lambdas),
    awayCorners: teamCornersPrediction("away", totalExp, ctx, lambdas),
    homeGoals,
    awayGoals,
    method: "fundamental-only / no odds",
  };
}
