"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { SignalPill } from "@/components/odds/SignalPill";
import { edgeClass, fmtEdge, fmtLine, fmtOdds } from "@/lib/odds/format";
import { isPrioritySignal, isRlmKind, isSteamKind } from "@/lib/odds/signal-kind";
import { linesAlign } from "@/lib/odds/signals";
import { formatHktTime, isInPlayStatus, isOnOddsCard } from "@/lib/odds/time";
import type { BoardMatch, BoardResponse, MarketSnapshot, TwoWayEdge } from "@/lib/odds/types";

function bestTwoWay(edge: TwoWayEdge | undefined): number | null {
  if (!edge) return null;
  const vals = Object.values(edge).filter((x): x is number => x != null);
  if (!vals.length) return null;
  return vals.reduce((a, b) => (Math.abs(b) > Math.abs(a) ? b : a), vals[0]);
}

type CollectResult = {
  ok?: boolean;
  error?: string | null;
  matchCount?: number;
  ms?: number;
};

const REFRESH_COOLDOWN_MS = 45_000;

function isCpuLimit(status: number, body: string): boolean {
  return status === 503 || /1102|Worker exceeded CPU/i.test(body);
}

function collectFailMessage(status: number, body: string, parsed: CollectResult | null): {
  message: string;
  soft: boolean;
} {
  if (isCpuLimit(status, body)) {
    return {
      soft: true,
      message:
        "Workers Free CPU limit briefly hit — keeping last good board. Retrying automatically in ~45s (cron still rotates the full card).",
    };
  }
  if (parsed?.error) return { soft: false, message: `Refresh failed: ${parsed.error}` };
  if (!parsed?.ok && status >= 400) return { soft: false, message: `Refresh failed (HTTP ${status}).` };
  if (status >= 400) return { soft: false, message: `Refresh failed (HTTP ${status}).` };
  return { soft: false, message: "Refresh failed." };
}

/** Pin no-vig % beats HKJC by ≥1.0 pp on the same outcome. */
const PIN_FAIR_LEAD_PP = 0.01;

function pinFairLeads(pinProb?: number | null, hkProb?: number | null, comparable = true): boolean {
  if (!comparable) return false;
  if (pinProb == null || hkProb == null) return false;
  if (!Number.isFinite(pinProb) || !Number.isFinite(hkProb)) return false;
  return pinProb - hkProb >= PIN_FAIR_LEAD_PP;
}

/** Odds + no-vig fair % — e.g. 1.95 (51%). Highlight Pin % when it leads JC by ≥1pp. */
function OddsFair({
  odds,
  prob,
  highlight,
}: {
  odds?: number | null;
  prob?: number | null;
  highlight?: boolean;
}) {
  const o = fmtOdds(odds);
  if (o === "—" || prob == null || !Number.isFinite(prob)) return <>{o}</>;
  const pct = Math.round(prob * 100);
  return (
    <>
      {o}
      {highlight ? (
        <span
          className="ml-0.5 inline-flex items-center px-1 rounded-md bg-emerald-500/20 text-[var(--ok)] font-bold border border-emerald-400/35"
          title="Pin no-vig % ≥ HKJC by 1.0pp+"
        >
          ({pct}%)
        </span>
      ) : (
        <span className="text-[var(--dim)]"> ({pct}%)</span>
      )}
    </>
  );
}

function MarketBlock({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="rounded-lg border border-[var(--border)]/80 bg-[var(--panel2)]/40 px-2.5 py-2 min-w-0">
      <div className="text-[10px] font-bold uppercase tracking-wider text-[var(--dim)] mb-1.5">
        {label}
      </div>
      {children}
    </div>
  );
}

/** Compact two-way: always show both books' full odds+fair%; never fake edge across unequal lines. */
/** Split Pin into JC-aligned snap vs Pin-main snap using crossLine. */
function pinBaselines(
  pin?: MarketSnapshot | null,
  hkLine?: number | null
): {
  atJc: MarketSnapshot | null;
  atPin: MarketSnapshot | null;
} {
  if (!pin) return { atJc: null, atPin: null };
  const cross = pin.crossLine ?? null;
  if (cross) {
    if (pin.lineFit === "main") return { atJc: cross, atPin: pin };
    return { atJc: pin, atPin: cross };
  }
  if (pin.lineFit === "main") return { atJc: null, atPin: pin };
  if (pin.lineFit === "exact" || pin.lineFit === "nearest" || pin.lineFit === "alt") {
    return { atJc: pin, atPin: null };
  }
  // Legacy snaps without lineFit/crossLine
  if (hkLine != null && pin.line != null && !linesAlign(hkLine, pin.line)) {
    return { atJc: null, atPin: pin };
  }
  if (hkLine != null && linesAlign(hkLine, pin.line)) {
    return { atJc: pin, atPin: null };
  }
  return { atJc: pin, atPin: null };
}

function sideOdds(
  labelA: string,
  labelB: string,
  keys: [string, string],
  snap: MarketSnapshot | null | undefined,
  peer: MarketSnapshot | null | undefined,
  allowHighlight: boolean,
  comparable: boolean
) {
  if (!snap?.odds) {
    return <span className="text-[var(--dim)]">—</span>;
  }
  return (
    <span className="flex flex-wrap gap-x-2 gap-y-0.5">
      <span>
        <span className="text-[10px] text-[var(--dim)]">{labelA} </span>
        <OddsFair
          odds={snap.odds?.[keys[0]]}
          prob={snap.fair?.probs?.[keys[0]]}
          highlight={
            allowHighlight &&
            pinFairLeads(snap.fair?.probs?.[keys[0]], peer?.fair?.probs?.[keys[0]], comparable)
          }
        />
      </span>
      <span>
        <span className="text-[10px] text-[var(--dim)]">{labelB} </span>
        <OddsFair
          odds={snap.odds?.[keys[1]]}
          prob={snap.fair?.probs?.[keys[1]]}
          highlight={
            allowHighlight &&
            pinFairLeads(snap.fair?.probs?.[keys[1]], peer?.fair?.probs?.[keys[1]], comparable)
          }
        />
      </span>
    </span>
  );
}

function TwoWayCell({
  labelA,
  labelB,
  hk,
  pin,
  edge,
  keys,
}: {
  labelA: string;
  labelB: string;
  hk?: MarketSnapshot | null;
  pin?: MarketSnapshot | null;
  edge?: TwoWayEdge;
  keys: [string, string];
}) {
  const { atJc: pinAtJc, atPin: pinMain } = pinBaselines(pin, hk?.line);
  const exact =
    (!!pinAtJc && (pinAtJc.lineFit === "exact" || linesAlign(hk?.line, pinAtJc.line))) ||
    (!!pin && !pin.crossLine && (pin.lineFit === "exact" || linesAlign(hk?.line, pin.line)));
  const nearest = !exact && (pinAtJc?.lineFit === "nearest" || pin?.lineFit === "nearest");
  const altOnly = !exact && !nearest && pinAtJc?.lineFit === "alt";
  const comparable = exact;
  const eA = edge?.[keys[0]] ?? null;
  const eB = edge?.[keys[1]] ?? null;
  const best = bestTwoWay(edge);

  if (!hk && !pin) {
    return <span className="text-[var(--dim)] text-xs">—</span>;
  }

  const pinLineForGap = pinMain?.line ?? pin?.line;
  const gapDelta =
    hk?.line != null &&
    pinLineForGap != null &&
    Number.isFinite(hk.line) &&
    Number.isFinite(pinLineForGap)
      ? Math.abs(hk.line - pinLineForGap)
      : pinAtJc?.lineDelta ?? pin?.lineDelta ?? null;

  const linesDiffer =
    !exact &&
    hk?.line != null &&
    pinLineForGap != null &&
    !linesAlign(hk.line, pinLineForGap);

  // Dual paired rows when baselines differ (or nearest/alt pairing exists with a distinct Pin main)
  const showPaired =
    linesDiffer ||
    nearest ||
    altOnly ||
    (!!pinAtJc && !!pinMain && !linesAlign(pinAtJc.line, pinMain.line));

  if (!showPaired) {
    // Same line — classic JC / Pin stack with edge
    const pinShow = pinAtJc || pin;
    return (
      <div className="tabular-nums leading-snug text-[12px] space-y-1">
        <div>
          <div className="flex items-baseline gap-1 flex-wrap">
            <span className="text-[10px] uppercase tracking-wide text-[var(--dim)] w-6 shrink-0">JC</span>
            <span className="text-[10px] text-[var(--dim)]">@</span>
            <b>{fmtLine(hk?.line)}</b>
          </div>
          <div className="pl-7">
            {sideOdds(labelA, labelB, keys, hk, pinShow, false, comparable)}
          </div>
        </div>
        <div className="text-[var(--muted)]">
          <div className="flex items-baseline gap-1 flex-wrap">
            <span className="text-[10px] uppercase tracking-wide text-[var(--dim)] w-6 shrink-0">Pin</span>
            <span className="text-[10px] text-[var(--dim)]">@</span>
            <b>{fmtLine(pinShow?.line)}</b>
          </div>
          <div className="pl-7">
            {sideOdds(labelA, labelB, keys, pinShow, hk, true, comparable)}
          </div>
        </div>
        <div className="flex flex-wrap gap-1 items-center pt-0.5">
          {exact ? (
            <>
              <span className={edgeClass(eA)}>
                {labelA} {fmtEdge(eA)}
              </span>
              <span className={edgeClass(eB)}>
                {labelB} {fmtEdge(eB)}
              </span>
              {best != null && Math.abs(best) >= 2 && (
                <span className="text-[10px] text-[var(--ok)] font-semibold">★</span>
              )}
            </>
          ) : (
            <span className="text-[10px] text-[var(--dim)]">no edge</span>
          )}
        </div>
      </div>
    );
  }

  // --- LINE GAP / nearest: one paired compare per baseline ---
  const jcOnPinMain =
    hk && pinMain && linesAlign(hk.line, pinMain.line) ? hk : null;
  const pinFitNote =
    pinAtJc?.lineFit === "exact"
      ? "exact"
      : pinAtJc?.lineFit === "nearest"
        ? "≈ nearest"
        : pinAtJc?.lineFit === "alt"
          ? "≈ alt"
          : null;

  return (
    <div className="tabular-nums leading-snug text-[12px] space-y-1.5">
      {/* Baseline A = JC line */}
      <div className="rounded-md border border-[var(--border)]/80 bg-black/15 px-1.5 py-1 space-y-0.5">
        <div className="text-[10px] font-semibold uppercase tracking-wide text-[var(--dim)]">
          @ JC {fmtLine(hk?.line)}
          {pinFitNote ? (
            <span className="ml-1 font-medium normal-case text-amber-200/90">· Pin {pinFitNote}</span>
          ) : null}
        </div>
        <div className="flex items-start gap-1">
          <span className="text-[10px] uppercase tracking-wide text-[var(--dim)] w-6 shrink-0 pt-0.5">JC</span>
          <div className="min-w-0">{sideOdds(labelA, labelB, keys, hk, pinAtJc, false, exact && linesAlign(hk?.line, pinAtJc?.line))}</div>
        </div>
        <div className="flex items-start gap-1 text-[var(--muted)]">
          <span className="text-[10px] uppercase tracking-wide text-[var(--dim)] w-6 shrink-0 pt-0.5">Pin</span>
          <div className="min-w-0">
            {pinAtJc?.odds ? (
              <>
                <span className="text-[10px] text-[var(--dim)] mr-1">@{fmtLine(pinAtJc.line)}</span>
                {sideOdds(
                  labelA,
                  labelB,
                  keys,
                  pinAtJc,
                  hk,
                  true,
                  exact && linesAlign(hk?.line, pinAtJc.line)
                )}
              </>
            ) : (
              <span className="text-[var(--dim)]">—</span>
            )}
          </div>
        </div>
      </div>

      {/* Baseline B = Pin main */}
      {pinMain?.odds ? (
        <div className="rounded-md border border-[var(--border)]/80 bg-black/15 px-1.5 py-1 space-y-0.5">
          <div className="text-[10px] font-semibold uppercase tracking-wide text-[var(--dim)]">
            @ Pin {fmtLine(pinMain.line)}
            <span className="ml-1 font-medium normal-case text-[var(--muted)]">· main</span>
          </div>
          <div className="flex items-start gap-1 text-[var(--muted)]">
            <span className="text-[10px] uppercase tracking-wide text-[var(--dim)] w-6 shrink-0 pt-0.5">Pin</span>
            <div className="min-w-0">{sideOdds(labelA, labelB, keys, pinMain, jcOnPinMain, false, false)}</div>
          </div>
          <div className="flex items-start gap-1">
            <span className="text-[10px] uppercase tracking-wide text-[var(--dim)] w-6 shrink-0 pt-0.5">JC</span>
            <div className="min-w-0">
              {jcOnPinMain?.odds ? (
                sideOdds(labelA, labelB, keys, jcOnPinMain, pinMain, false, false)
              ) : (
                <span className="text-[var(--dim)]">—</span>
              )}
            </div>
          </div>
        </div>
      ) : null}

      <div className="flex flex-wrap gap-1 items-center">
        {exact ? (
          <>
            <span className={edgeClass(eA)}>
              {labelA} {fmtEdge(eA)}
            </span>
            <span className={edgeClass(eB)}>
              {labelB} {fmtEdge(eB)}
            </span>
            {best != null && Math.abs(best) >= 2 && (
              <span className="text-[10px] text-[var(--ok)] font-semibold">★</span>
            )}
            <span className="text-[10px] text-[var(--dim)]">edge @ JC line only</span>
          </>
        ) : nearest ? (
          <span
            className="text-[10px] px-1 py-0.5 rounded bg-amber-500/15 text-amber-200 border border-amber-400/30"
            title="Paired by baseline — Pin nearest alt under JC line; no edge across unequal lines"
          >
            ≈ nearest · paired by line · no edge
            {gapDelta != null ? ` · Δ${Number(gapDelta).toFixed(2)}` : ""}
          </span>
        ) : (
          <span
            className="text-[10px] px-1 py-0.5 rounded bg-amber-500/15 text-[var(--warn)] border border-amber-400/35 font-semibold"
            title="Paired same-line compares — no edge across unequal baselines"
          >
            LINE GAP · paired by line · no edge
            {gapDelta != null ? ` · Δ${Number(gapDelta).toFixed(2)}` : ""}
          </span>
        )}
      </div>
    </div>
  );
}

function HadCell({ m }: { m: BoardMatch }) {
  const hk = m.books.hkjc?.had;
  const pin = m.books.pinnacle?.had;
  if (!hk && !pin) return <span className="text-[var(--dim)] text-xs">—</span>;
  return (
    <div className="tabular-nums leading-snug text-[12px]">
      <div>
        <span className="text-[10px] text-[var(--dim)] mr-1">JC</span>
        <OddsFair odds={hk?.odds?.home} prob={hk?.fair?.probs?.home} />
        {" · "}
        <OddsFair odds={hk?.odds?.draw} prob={hk?.fair?.probs?.draw} />
        {" · "}
        <OddsFair odds={hk?.odds?.away} prob={hk?.fair?.probs?.away} />
      </div>
      <div className="text-[var(--muted)]">
        <span className="text-[10px] text-[var(--dim)] mr-1">Pin</span>
        <OddsFair
          odds={pin?.odds?.home}
          prob={pin?.fair?.probs?.home}
          highlight={pinFairLeads(pin?.fair?.probs?.home, hk?.fair?.probs?.home)}
        />
        {" · "}
        <OddsFair
          odds={pin?.odds?.draw}
          prob={pin?.fair?.probs?.draw}
          highlight={pinFairLeads(pin?.fair?.probs?.draw, hk?.fair?.probs?.draw)}
        />
        {" · "}
        <OddsFair
          odds={pin?.odds?.away}
          prob={pin?.fair?.probs?.away}
          highlight={pinFairLeads(pin?.fair?.probs?.away, hk?.fair?.probs?.away)}
        />
      </div>
      <div className="mt-0.5 flex gap-2 flex-wrap">
        <span className={edgeClass(m.edgeHad.home)}>H {fmtEdge(m.edgeHad.home)}</span>
        <span className={edgeClass(m.edgeHad.draw)}>D {fmtEdge(m.edgeHad.draw)}</span>
        <span className={edgeClass(m.edgeHad.away)}>A {fmtEdge(m.edgeHad.away)}</span>
      </div>
    </div>
  );
}

function HhaCell({ m }: { m: BoardMatch }) {
  const hha = m.books.hkjc?.hha;
  const pinHad = m.books.pinnacle?.had;
  if (!hha) return <span className="text-[var(--dim)] text-xs">—</span>;
  const comparable =
    hha.line != null && Number.isFinite(hha.line) && Math.abs(hha.line) < 0.01;
  const usable =
    m.edgeHha && (m.edgeHha.home != null || m.edgeHha.draw != null || m.edgeHha.away != null);
  return (
    <div className="tabular-nums leading-snug text-[12px]">
      <div>
        <span className="text-[10px] text-[var(--dim)] mr-1">JC</span>
        <b>{fmtLine(hha.line)}</b>{" "}
        <OddsFair odds={hha.odds?.home} prob={hha.fair?.probs?.home} />
        {" · "}
        <OddsFair odds={hha.odds?.draw} prob={hha.fair?.probs?.draw} />
        {" · "}
        <OddsFair odds={hha.odds?.away} prob={hha.fair?.probs?.away} />
      </div>
      {pinHad && (
        <div className="text-[var(--muted)]">
          <span className="text-[10px] text-[var(--dim)] mr-1">Pin</span>
          <span className="text-[10px] text-[var(--dim)] mr-1">HAD</span>
          <OddsFair
            odds={pinHad.odds?.home}
            prob={pinHad.fair?.probs?.home}
            highlight={pinFairLeads(pinHad.fair?.probs?.home, hha.fair?.probs?.home, comparable)}
          />
          {" · "}
          <OddsFair
            odds={pinHad.odds?.draw}
            prob={pinHad.fair?.probs?.draw}
            highlight={pinFairLeads(pinHad.fair?.probs?.draw, hha.fair?.probs?.draw, comparable)}
          />
          {" · "}
          <OddsFair
            odds={pinHad.odds?.away}
            prob={pinHad.fair?.probs?.away}
            highlight={pinFairLeads(pinHad.fair?.probs?.away, hha.fair?.probs?.away, comparable)}
          />
          {!comparable && <span className="text-[10px] text-[var(--dim)]"> · vs HAD if line≈0</span>}
        </div>
      )}
      <div className="mt-0.5 flex gap-2 flex-wrap">
        {usable ? (
          <>
            <span className={edgeClass(m.edgeHha.home)}>H {fmtEdge(m.edgeHha.home)}</span>
            <span className={edgeClass(m.edgeHha.draw)}>D {fmtEdge(m.edgeHha.draw)}</span>
            <span className={edgeClass(m.edgeHha.away)}>A {fmtEdge(m.edgeHha.away)}</span>
          </>
        ) : (
          <span className="text-[10px] text-[var(--dim)]">edge only if line ≈ 0</span>
        )}
      </div>
    </div>
  );
}

function pinStaleLabel(m: BoardMatch, lastCollectAt: string | null): string | null {
  if (!m.books.pinnacle) return "no Pin";
  if (!m.pinUpdatedAt || !lastCollectAt) return null;
  const age = Math.max(
    0,
    Math.round((new Date(lastCollectAt).getTime() - new Date(m.pinUpdatedAt).getTime()) / 60_000)
  );
  if (age >= 30) return `Pin ${age}m`;
  return null;
}

function MatchCard({
  m,
  lastCollectAt,
}: {
  m: BoardMatch;
  lastCollectAt: string | null;
}) {
  const priority = m.signals.filter((s) => isPrioritySignal(s.kind));
  const primary = priority[0] || m.signals.find((s) => s.kind !== "agree");
  const showSignals = (priority.length ? priority : primary ? [primary] : []).slice(0, 3);
  const hasSteam = priority.some((s) => isSteamKind(s.kind));
  const hasRlm = priority.some((s) => isRlmKind(s.kind));
  const stale = pinStaleLabel(m, lastCollectAt);
  const accent = hasSteam
    ? "border-l-blue-400 bg-blue-500/[0.04]"
    : hasRlm
      ? "border-l-fuchsia-400 bg-fuchsia-500/[0.04]"
      : "border-l-[var(--border)]";

  return (
    <article
      className={`card border-l-[3px] ${accent} overflow-hidden`}
      data-match-id={m.id}
    >
      {/* Sticky-feel match header */}
      <header className="sticky top-0 z-[2] flex flex-wrap items-start gap-x-3 gap-y-2 px-3 py-2.5 bg-[var(--panel)]/95 backdrop-blur-sm border-b border-[var(--border)]">
        <div className="shrink-0 w-[3.25rem]">
          <div className="font-semibold tabular-nums text-[13px]">{formatHktTime(m.kickOffTime)}</div>
          {isInPlayStatus(m.status) ? (
            <div className="mt-0.5 inline-flex items-center gap-1 text-[10px] font-bold uppercase tracking-wide text-rose-300">
              <span className="inline-block w-1.5 h-1.5 rounded-full bg-rose-400 animate-pulse" />
              Live
            </div>
          ) : null}
        </div>
        <div className="min-w-0 flex-1">
          <Link
            href={`/odds/match/${m.id}`}
            className="font-semibold text-[13px] leading-snug hover:text-[var(--accent)]"
          >
            {m.homeTeam} <span className="text-[var(--dim)] font-normal">v</span> {m.awayTeam}
          </Link>
          <div className="text-[10px] text-[var(--muted)] mt-0.5 flex flex-wrap gap-x-1.5 gap-y-0.5 items-center">
            <span>{m.league}</span>
            {m.pinPhase === "live" && (
              <span className="text-[10px] px-1 rounded bg-emerald-500/15 text-[var(--ok)] border border-emerald-400/30">
                Pin live
              </span>
            )}
            {isInPlayStatus(m.status) && !m.books.pinnacle && (
              <span
                className="text-[10px] px-1 rounded bg-amber-500/15 text-amber-200 border border-amber-400/30"
                title="In-play: prematch Pin hidden until live Pin enrich"
              >
                Pin prematch hidden
              </span>
            )}
            {stale && m.books.pinnacle && (
              <span className="text-amber-300/90" title="Pin odds carried from earlier tick">
                · {stale}
              </span>
            )}
          </div>
        </div>
        <div className="flex flex-wrap gap-1 justify-end max-w-full sm:max-w-[14rem]">
          {showSignals.length ? (
            showSignals.map((s, i) => (
              <SignalPill
                key={`${s.kind}-${i}`}
                kind={s.kind}
                label={s.label}
                strength={s.strength}
                signal={s}
                matchTitle={`${m.homeTeam} v ${m.awayTeam}`}
              />
            ))
          ) : (
            <span className="text-[var(--dim)] text-xs self-center">—</span>
          )}
        </div>
      </header>

      {/* All markets — one view */}
      <div className="p-2.5 grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4 gap-2">
        <MarketBlock label="AH">
          <TwoWayCell
            labelA="H"
            labelB="A"
            hk={m.books.hkjc?.hdc}
            pin={m.books.pinnacle?.hdc}
            edge={m.edgeHdc}
            keys={["home", "away"]}
          />
        </MarketBlock>
        <MarketBlock label="O/U">
          <TwoWayCell
            labelA="O"
            labelB="U"
            hk={m.books.hkjc?.hil}
            pin={m.books.pinnacle?.hil}
            edge={m.edgeHil}
            keys={["over", "under"]}
          />
        </MarketBlock>
        <MarketBlock label="HAD">
          <HadCell m={m} />
        </MarketBlock>
        <MarketBlock label="HHA">
          <HhaCell m={m} />
        </MarketBlock>
        <MarketBlock label="1H AH">
          <TwoWayCell
            labelA="H"
            labelB="A"
            hk={m.books.hkjc?.hdc1h}
            pin={m.books.pinnacle?.hdc1h}
            edge={m.edgeHdc1h}
            keys={["home", "away"]}
          />
        </MarketBlock>
        <MarketBlock label="1H O/U">
          <TwoWayCell
            labelA="O"
            labelB="U"
            hk={m.books.hkjc?.hil1h}
            pin={m.books.pinnacle?.hil1h}
            edge={m.edgeHil1h}
            keys={["over", "under"]}
          />
        </MarketBlock>
        <MarketBlock label="Corners">
          <TwoWayCell
            labelA="O"
            labelB="U"
            hk={m.books.hkjc?.chl}
            pin={m.books.pinnacle?.chl}
            edge={m.edgeChl}
            keys={["over", "under"]}
          />
        </MarketBlock>
      </div>
    </article>
  );
}

export function BoardClient() {
  const [board, setBoard] = useState<BoardResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshError, setRefreshError] = useState<string | null>(null);
  const [refreshSoft, setRefreshSoft] = useState(false);
  const [refreshRetryIn, setRefreshRetryIn] = useState<number | null>(null);
  const [league, setLeague] = useState("");
  const [minEdge, setMinEdge] = useState(0);
  const [refreshing, setRefreshing] = useState(false);
  const refreshLock = useRef(false);
  const autoRefreshDone = useRef(false);
  const autoRetryTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const countdownTimer = useRef<ReturnType<typeof setInterval> | null>(null);
  const refreshRef = useRef<() => Promise<void>>(async () => {});
  const searchParams = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/odds/board", { cache: "no-store" });
      if (!res.ok) throw new Error(`board HTTP ${res.status}`);
      setBoard((await res.json()) as BoardResponse);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load board");
    }
  }, []);

  const clearAutoRetry = useCallback(() => {
    if (autoRetryTimer.current) {
      clearTimeout(autoRetryTimer.current);
      autoRetryTimer.current = null;
    }
    if (countdownTimer.current) {
      clearInterval(countdownTimer.current);
      countdownTimer.current = null;
    }
    setRefreshRetryIn(null);
  }, []);

  const scheduleAutoRetry = useCallback(() => {
    clearAutoRetry();
    const deadline = Date.now() + REFRESH_COOLDOWN_MS;
    setRefreshRetryIn(Math.ceil(REFRESH_COOLDOWN_MS / 1000));
    countdownTimer.current = setInterval(() => {
      const left = Math.max(0, Math.ceil((deadline - Date.now()) / 1000));
      setRefreshRetryIn(left);
      if (left <= 0 && countdownTimer.current) {
        clearInterval(countdownTimer.current);
        countdownTimer.current = null;
      }
    }, 500);
    autoRetryTimer.current = setTimeout(() => {
      autoRetryTimer.current = null;
      setRefreshRetryIn(null);
      void refreshRef.current();
    }, REFRESH_COOLDOWN_MS);
  }, [clearAutoRetry]);

  const refresh = useCallback(async () => {
    if (refreshLock.current) return;
    refreshLock.current = true;
    clearAutoRetry();
    setRefreshing(true);
    setRefreshError(null);
    setRefreshSoft(false);
    try {
      // Lean: small priority batch only — cron keeps rotating the full card.
      const res = await fetch("/api/odds/collect?mode=lean", { cache: "no-store" });
      const raw = await res.text();
      let parsed: CollectResult | null = null;
      try {
        parsed = JSON.parse(raw) as CollectResult;
      } catch {
        parsed = null;
      }
      if (!res.ok || parsed?.ok === false) {
        const fail = collectFailMessage(res.status, raw, parsed);
        setRefreshError(fail.message);
        setRefreshSoft(fail.soft);
        // Keep last good board; soft CPU limit → auto-retry after cooldown.
        if (fail.soft) scheduleAutoRetry();
        return;
      }
      setRefreshError(null);
      setRefreshSoft(false);
      await load();
    } catch (e) {
      setRefreshError(e instanceof Error ? e.message : "Refresh failed");
      setRefreshSoft(false);
    } finally {
      setRefreshing(false);
      refreshLock.current = false;
    }
  }, [load, clearAutoRetry, scheduleAutoRetry]);

  useEffect(() => {
    refreshRef.current = refresh;
  }, [refresh]);

  useEffect(() => {
    return () => clearAutoRetry();
  }, [clearAutoRetry]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (autoRefreshDone.current) return;
    if (searchParams.get("refresh") !== "1") return;
    autoRefreshDone.current = true;
    void (async () => {
      await refresh();
      const next = new URLSearchParams(searchParams.toString());
      next.delete("refresh");
      const q = next.toString();
      router.replace(q ? `${pathname}?${q}` : pathname, { scroll: false });
    })();
  }, [searchParams, refresh, router, pathname]);

  const matches = useMemo(() => {
    if (!board) return [] as BoardMatch[];
    const today = board.today;
    const tomorrow = board.tomorrow;
    let list = (board.matches || []).filter((m) =>
      isOnOddsCard(m.kickOffTime, m.status, today, tomorrow)
    );
    if (league) list = list.filter((m) => m.league === league || m.leagueCode === league);
    if (minEdge > 0) {
      list = list.filter((m) => {
        const edges = [
          bestTwoWay(m.edgeHdc),
          bestTwoWay(m.edgeHil),
          bestTwoWay(m.edgeHdc1h),
          bestTwoWay(m.edgeHil1h),
          bestTwoWay(m.edgeChl),
          m.edgeHad.home,
          m.edgeHad.draw,
          m.edgeHad.away,
          m.edgeHha?.home,
          m.edgeHha?.draw,
          m.edgeHha?.away,
        ].filter((x): x is number => x != null);
        return edges.some((e) => e >= minEdge);
      });
    }
    list.sort((a, b) => {
      const ai = isInPlayStatus(a.status) ? 0 : 1;
      const bi = isInPlayStatus(b.status) ? 0 : 1;
      if (ai !== bi) return ai - bi;
      const ap = a.signals.some((s) => isPrioritySignal(s.kind)) ? 0 : 1;
      const bp = b.signals.some((s) => isPrioritySignal(s.kind)) ? 0 : 1;
      if (ap !== bp) return ap - bp;
      return new Date(a.kickOffTime).getTime() - new Date(b.kickOffTime).getTime();
    });
    return list;
  }, [board, league, minEdge]);

  const leagues = useMemo(
    () => Array.from(new Set(matches.map((m) => m.league).filter(Boolean))),
    [matches]
  );
  const steamCount = matches.filter((m) => m.signals.some((s) => isSteamKind(s.kind))).length;
  const rlmCount = matches.filter((m) => m.signals.some((s) => isRlmKind(s.kind))).length;
  const pinFresh = matches.filter(
    (m) => m.pinUpdatedAt && board?.lastCollectAt && m.pinUpdatedAt === board.lastCollectAt
  ).length;

  if (!board && !error) {
    return <p className="text-[var(--muted)] text-sm">Loading board…</p>;
  }
  if (error && !board) {
    return (
      <div className="text-rose-300 text-sm">
        {error}.{" "}
        <button type="button" className="underline" onClick={() => void load()}>
          Retry
        </button>
      </div>
    );
  }
  if (!board) return null;

  return (
    <>
      {(board.error || !board.sources.hkjc) && (
        <div className="mb-3 px-3 py-2 rounded-lg border border-amber-500/40 bg-amber-500/10 text-amber-200 text-sm">
          {board.error ? `Data note: ${board.error}` : "HKJC odds unavailable."} HKJC:
          {board.sources.hkjc ? "✓" : "✗"} Pin:{board.sources.pinnacle ? "✓" : "✗"}
        </div>
      )}

      <div className="flex flex-wrap items-center gap-2 mb-3 sticky top-0 z-[3] py-2 -mx-1 px-1 bg-[var(--bg)]/90 backdrop-blur-sm">
        <select
          value={league}
          onChange={(e) => setLeague(e.target.value)}
          className="bg-[var(--panel)] border border-[var(--border)] rounded-lg px-2 py-1.5 text-xs min-w-[7rem] max-w-[11rem]"
          aria-label="League"
        >
          <option value="">All leagues</option>
          {leagues.map((l) => (
            <option key={l} value={l}>
              {l}
            </option>
          ))}
        </select>

        <label className="flex items-center gap-1 text-[11px] text-[var(--muted)]">
          Edge ≥
          <input
            type="number"
            step="0.5"
            value={minEdge}
            onChange={(e) => setMinEdge(parseFloat(e.target.value) || 0)}
            className="bg-[var(--panel)] border border-[var(--border)] rounded-lg px-2 py-1.5 text-xs w-[4.25rem]"
          />
        </label>

        <div className="hidden sm:flex flex-wrap gap-x-3 gap-y-0.5 text-[11px] text-[var(--muted)] ml-1">
          <span>
            <b className="text-[var(--text)] tabular-nums">{matches.length}</b> fixtures
          </span>
          <span>
            Pin <b className="text-[var(--text)] tabular-nums">{board.matchedCount}</b>
            <span className="text-[var(--dim)]"> · </span>
            fresh <b className="text-[var(--text)] tabular-nums">{pinFresh}</b>
          </span>
          <span>
            <span className="text-[var(--accent2)] font-semibold">Steam</span>{" "}
            <b className="tabular-nums text-[var(--text)]">{steamCount}</b>
            <span className="text-[var(--dim)]"> · </span>
            <span className="text-fuchsia-300 font-semibold">RLM</span>{" "}
            <b className="tabular-nums text-[var(--text)]">{rlmCount}</b>
          </span>
          <span className="text-[var(--dim)]">
            {board.lastCollectAt ? `${formatHktTime(board.lastCollectAt)} HKT` : "—"}
          </span>
        </div>

        <div className="flex-1" />

        <button
          type="button"
          onClick={() => void refresh()}
          disabled={refreshing}
          aria-busy={refreshing}
          className="px-3.5 py-1.5 rounded-lg bg-[var(--accent)] text-[var(--bg)] text-sm font-semibold disabled:opacity-60 disabled:cursor-not-allowed shrink-0"
          title="Lean refresh: priority batch only (cron rotates the full card)"
        >
          {refreshing ? "Refreshing…" : "Refresh"}
        </button>
      </div>

      {refreshError && (
        <div
          className={`mb-3 px-3 py-2 rounded-lg text-sm flex flex-wrap items-center gap-2 ${
            refreshSoft
              ? "border border-amber-500/40 bg-amber-500/10 text-amber-100"
              : "border border-rose-500/40 bg-rose-500/10 text-rose-200"
          }`}
        >
          <span>
            {refreshError}
            {refreshSoft && refreshRetryIn != null && refreshRetryIn > 0
              ? ` (${refreshRetryIn}s)`
              : ""}
          </span>
          <button
            type="button"
            className="underline font-semibold disabled:opacity-60"
            disabled={refreshing}
            onClick={() => {
              clearAutoRetry();
              void refresh();
            }}
          >
            Retry now
          </button>
        </div>
      )}

      <div className="sm:hidden mb-2 flex flex-wrap gap-x-3 gap-y-0.5 text-[11px] text-[var(--muted)] px-0.5">
        <span>
          <b className="text-[var(--text)] tabular-nums">{matches.length}</b> fixtures
        </span>
        <span>
          Pin <b className="tabular-nums text-[var(--text)]">{board.matchedCount}</b> · fresh{" "}
          <b className="tabular-nums text-[var(--text)]">{pinFresh}</b>
        </span>
        <span className="text-[var(--dim)]">
          {board.lastCollectAt ? `${formatHktTime(board.lastCollectAt)} HKT` : "—"}
        </span>
      </div>

      {matches.length === 0 ? (
        <div className="card px-3 py-10 text-center text-[var(--muted)]">
          No matches yet. Click <strong>Refresh</strong>.
        </div>
      ) : (
        <div className="flex flex-col gap-2.5">
          {matches.map((m) => (
            <MatchCard key={m.id} m={m} lastCollectAt={board.lastCollectAt} />
          ))}
        </div>
      )}

      <p className="mt-3 text-[10px] sm:text-[11px] text-[var(--dim)] leading-relaxed max-w-3xl">
        All markets on one card: AH · O/U · HAD · HHA · 1H · Corners. LINE GAP = paired same-line compares (@ JC line: JC+Pin alt; @ Pin main: Pin+JC if any); no edge across unequal lines. Nearest = Pin alt within ~¼ of JC. In-play never mixes prematch Pin with live JC.{" "}
        <span className="text-[var(--accent2)] font-semibold">Steam</span> = Pin moves fast.{" "}
        <span className="text-fuchsia-300 font-semibold">RLM</span> = HKJC drifts vs Pin. Hover/click pills for detail. No-vig %
        next to odds; Pin % green when ≥1.0pp above JC (same side; AH/O/U need matching lines).{" "}
        <strong className="text-[var(--muted)]">Refresh</strong> = lean priority batch (cron rotates the full card).
      </p>
    </>
  );
}
