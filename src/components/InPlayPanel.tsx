import type { FootballMatch } from "@/lib/types";

function deltaClass(actual: number | null, expected: number | null): string {
  if (actual == null || expected == null) return "text-slate-400";
  const d = actual - expected;
  if (Math.abs(d) < 0.25) return "text-slate-300";
  if (d > 0) return "text-emerald-400";
  return "text-rose-400";
}

function formatDelta(actual: number | null, expected: number | null): string {
  if (actual == null || expected == null) return "—";
  const d = actual - expected;
  const sign = d > 0 ? "+" : "";
  return `${sign}${d.toFixed(1)}`;
}

export function InPlayPanel({ match }: { match: FootballMatch }) {
  if (!match.isInPlay) return null;

  const live = match.live;
  const expTotal = match.predictions.totalCorners.expectedValue ?? null;
  const expHome = match.predictions.homeCorners.expectedValue ?? null;
  const expAway = match.predictions.awayCorners.expectedValue ?? null;

  return (
    <div className="rounded-xl border border-rose-500/30 bg-rose-500/5 p-3">
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <span className="inline-flex items-center gap-1.5 rounded-md bg-rose-600 px-2 py-0.5 text-[11px] font-bold uppercase tracking-wide text-white shadow-[0_0_12px_rgba(225,29,72,0.45)]">
          <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-white" />
          INPLAY
        </span>
        {match.minuteLabel && (
          <span className="rounded-md border border-rose-400/40 bg-black/30 px-2 py-0.5 font-mono text-sm font-semibold text-rose-100">
            {match.minuteLabel}
          </span>
        )}
        {live && live.homeScore != null && live.awayScore != null && (
          <span className="ml-auto font-mono text-lg font-bold text-white">
            {live.homeScore} – {live.awayScore}
          </span>
        )}
      </div>

      <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
        <DeltaCard
          title="Total Corners"
          expected={expTotal}
          actual={live?.corner ?? null}
        />
        <DeltaCard
          title="Home Corners"
          expected={expHome}
          actual={live?.homeCorner ?? null}
        />
        <DeltaCard
          title="Away Corners"
          expected={expAway}
          actual={live?.awayCorner ?? null}
        />
      </div>

      {match.predictions.had.available && live?.homeScore != null && (
        <p className="mt-2 text-[11px] text-slate-500">
          Locked HAD forecast: <span className="text-slate-300">{match.predictions.had.label}</span>
          {" · "}
          Actual score{" "}
          <span className="text-slate-300">
            {live.homeScore}-{live.awayScore}
          </span>
        </p>
      )}
    </div>
  );
}

function DeltaCard({
  title,
  expected,
  actual,
}: {
  title: string;
  expected: number | null;
  actual: number | null;
}) {
  return (
    <div className="rounded-lg border border-white/5 bg-black/25 p-2.5">
      <p className="text-[10px] uppercase tracking-wide text-slate-500">
        {title}
      </p>
      <div className="mt-1 grid grid-cols-2 gap-2 text-xs">
        <div>
          <p className="text-slate-500">Expected</p>
          <p className="font-mono text-sm text-slate-200">
            {expected != null ? expected.toFixed(1) : "—"}
          </p>
        </div>
        <div>
          <p className="text-slate-500">Actual</p>
          <p className="font-mono text-sm text-white">
            {actual != null ? actual : "—"}
          </p>
        </div>
      </div>
      <p className={`mt-1 text-[11px] font-medium ${deltaClass(actual, expected)}`}>
        Δ {formatDelta(actual, expected)}
      </p>
    </div>
  );
}
