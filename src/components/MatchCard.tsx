import { formatKickoffHkt } from "@/lib/time";
import type { FootballMatch } from "@/lib/types";
import { InPlayPanel } from "./InPlayPanel";
import { PredictionsPanel } from "./PredictionsPanel";

function statusBadge(match: FootballMatch) {
  if (match.isInPlay) {
    return (
      <span className="inline-flex items-center gap-1 rounded-md bg-rose-600/90 px-2 py-0.5 text-[10px] font-bold uppercase text-white">
        INPLAY{match.minuteLabel ? ` · ${match.minuteLabel}` : ""}
      </span>
    );
  }
  const s = match.status.toUpperCase();
  if (s === "PREEVENT") {
    return (
      <span className="rounded-md border border-slate-600 bg-slate-800/80 px-2 py-0.5 text-[10px] font-semibold uppercase text-slate-300">
        Scheduled
      </span>
    );
  }
  if (s === "FULLTIME" || s === "ENDED") {
    return (
      <span className="rounded-md border border-slate-600 px-2 py-0.5 text-[10px] font-semibold uppercase text-slate-400">
        FT
      </span>
    );
  }
  return (
    <span className="rounded-md border border-slate-700 px-2 py-0.5 text-[10px] uppercase text-slate-400">
      {match.status}
    </span>
  );
}

export function MatchCard({ match }: { match: FootballMatch }) {
  return (
    <article
      className={`rounded-2xl border bg-pitch-900/60 p-4 shadow-lg shadow-black/20 backdrop-blur transition hover:border-accent/30 ${
        match.isInPlay
          ? "border-rose-500/40 ring-1 ring-rose-500/20"
          : "border-slate-800"
      }`}
    >
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <div className="flex flex-wrap items-center gap-2">
            {statusBadge(match)}
            <span className="text-[11px] font-medium uppercase tracking-wide text-accent/80">
              {match.league}
            </span>
            <span className="font-mono text-[10px] text-slate-600">
              {match.frontEndId}
            </span>
          </div>
          <h2 className="mt-2 text-lg font-semibold text-white">
            {match.homeTeam}{" "}
            <span className="text-slate-500">vs</span> {match.awayTeam}
          </h2>
          <p className="mt-1 text-sm text-slate-400">
            Kickoff {formatKickoffHkt(match.kickOffTime)} HKT
          </p>
        </div>
        {match.live &&
          match.live.homeScore != null &&
          match.live.awayScore != null && (
            <div className="rounded-xl border border-white/10 bg-black/40 px-4 py-2 text-center">
              <p className="text-[10px] uppercase text-slate-500">Score</p>
              <p className="font-mono text-2xl font-bold text-white">
                {match.live.homeScore}:{match.live.awayScore}
              </p>
              {match.live.corner != null && (
                <p className="text-[11px] text-slate-400">
                  Corners {match.live.homeCorner ?? "?"}–
                  {match.live.awayCorner ?? "?"} ({match.live.corner})
                </p>
              )}
            </div>
          )}
      </div>

      <div className="mt-4 space-y-3">
        {match.isInPlay && <InPlayPanel match={match} />}
        <PredictionsPanel predictions={match.predictions} />
      </div>
    </article>
  );
}
