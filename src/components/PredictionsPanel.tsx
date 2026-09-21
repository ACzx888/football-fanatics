import type { MatchPredictions, PredictionOutcome } from "@/lib/types";

function FactorChips({ factors }: { factors?: string[] }) {
  if (!factors?.length) return null;
  return (
    <div className="mt-2 flex flex-wrap gap-1">
      {factors.map((f) => (
        <span
          key={f}
          className="rounded-md border border-slate-700/80 bg-slate-950/60 px-1.5 py-0.5 text-[10px] font-medium text-slate-400"
        >
          {f}
        </span>
      ))}
    </div>
  );
}

function Cell({
  title,
  outcome,
}: {
  title: string;
  outcome: PredictionOutcome;
}) {
  if (!outcome.available) {
    return (
      <div className="rounded-xl border border-slate-700/80 bg-slate-900/60 p-3">
        <p className="text-[11px] uppercase tracking-wide text-slate-500">
          {title}
        </p>
        <p className="mt-2 text-sm font-semibold text-slate-400">
          Insufficient Data
        </p>
        {outcome.reason && (
          <p className="mt-1 text-[11px] text-slate-600">{outcome.reason}</p>
        )}
      </div>
    );
  }

  return (
    <div className="rounded-xl border border-accent/20 bg-gradient-to-b from-accent/5 to-transparent p-3">
      <p className="text-[11px] uppercase tracking-wide text-slate-400">
        {title}
      </p>
      <p className="mt-1 text-sm font-semibold text-white">{outcome.label}</p>
      <div className="mt-2 flex flex-wrap items-end gap-x-3 gap-y-1">
        <div className="flex items-end gap-2">
          <span className="text-2xl font-bold tabular-nums text-accent">
            {outcome.confidencePct?.toFixed(1)}%
          </span>
          <span className="pb-1 text-[10px] uppercase text-slate-500">
            conf.
          </span>
        </div>
        {outcome.expectedValue != null && (
          <div className="pb-0.5 text-[11px] text-slate-400">
            E[x]{" "}
            <span className="font-mono font-semibold text-slate-200">
              {outcome.expectedValue.toFixed(1)}
            </span>
          </div>
        )}
      </div>
      {outcome.modelProb != null && (
        <p className="mt-1 text-[10px] text-slate-500">
          model {outcome.modelProb.toFixed(0)}%
        </p>
      )}
      <FactorChips factors={outcome.factors} />
      {outcome.selections && outcome.selections.length > 0 && (
        <div className="mt-2 space-y-1">
          {outcome.selections.map((s) => (
            <div
              key={s.code}
              className="flex items-center justify-between text-[11px] text-slate-400"
            >
              <span>{s.label}</span>
              <span className="tabular-nums text-slate-300">
                {s.modelPct.toFixed(1)}%
              </span>
            </div>
          ))}
        </div>
      )}
      {outcome.detail && (
        <p className="mt-2 text-[10px] leading-snug text-slate-600">
          {outcome.detail}
        </p>
      )}
    </div>
  );
}

export function PredictionsPanel({
  predictions,
}: {
  predictions: MatchPredictions;
}) {
  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-xs font-semibold uppercase tracking-wider text-slate-400">
          Predictions
        </h3>
        <span className="rounded-md border border-accent/30 bg-accent/10 px-1.5 py-0.5 text-[10px] text-accent">
          fundamental-only / no odds
        </span>
      </div>
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        <Cell title="HAD (Home / Draw / Away)" outcome={predictions.had} />
        <Cell title="Total Corners" outcome={predictions.totalCorners} />
        <Cell title="Home Team Corners" outcome={predictions.homeCorners} />
        <Cell title="Away Team Corners" outcome={predictions.awayCorners} />
      </div>
    </div>
  );
}
