import { NextRequest, NextResponse } from "next/server";
import {
  fetchHkjcEventsForIds,
  fetchHkjcSchedule,
  type HkjcEvent,
} from "@/lib/odds/collectors/hkjc";
import { BOARD_CACHE_KEY } from "@/lib/board-cache";
import {
  attachPinnacleCorners,
  fetchPinnacleMarketsForMatchup,
} from "@/lib/odds/collectors/pinnacle";
import { linkBook, orientLine, worstConfidence, type ExtCandidate } from "@/lib/odds/match";
import { flipQuote } from "@/lib/odds/quote-orient";
import { isRlmKind, isSteamKind } from "@/lib/odds/signal-kind";
import {
  computeEdgeHad,
  computeEdgeTwoWay,
  detectSignals,
  latestSpark,
  maxPositiveEdge,
} from "@/lib/odds/signals";
import {
  getKv,
  loadAlerts,
  loadBoard,
  loadPinIndex,
  loadPinRotate,
  saveAlerts,
  saveBoard,
  saveMeta,
  savePinRotate,
} from "@/lib/odds/store";
import {
  addDaysHkt,
  dedupeSnapshotsByMinute,
  formatHktDate,
  hasKickedOff,
  hktMinuteKey,
  hktDateFromIso,
  isInPlayStatus,
  isMatchActiveOnBoard,
  isOnOddsCard,
} from "@/lib/odds/time";
import type { AlertItem, BoardMatch, BoardResponse, SnapshotPoint } from "@/lib/odds/types";

export const dynamic = "force-dynamic";

/** Free CPU: deep HKJC odds + Pin for this many matches per cron/full tick. */
const ENRICH_BATCH = 3;
/** Manual Refresh lean mode — tiny priority batch only (stay under Free CPU). */
const LEAN_ENRICH_BATCH = 2;
/** Pin Corners attach (extra HTTP) within the enrich set. */
const PIN_CORNERS_MAX = 2;
const LEAN_PIN_CORNERS_MAX = 1;
const SOON_MS = 3 * 3600_000;

function hktDay(iso: string): string {
  return hktDateFromIso(iso);
}

function toScheduleEvents(
  rows: Array<{
    id: string;
    frontEndId: string;
    kickOffTime: string;
    matchDate?: string;
    status?: string;
    league?: string;
    leagueCode?: string;
    homeTeam?: string;
    awayTeam?: string;
    homeTeamCh?: string;
    awayTeamCh?: string;
    quote?: HkjcEvent["quote"];
    books?: { hkjc?: HkjcEvent["quote"] };
  }>
): HkjcEvent[] {
  return rows.map((m) => ({
    id: m.id,
    frontEndId: m.frontEndId,
    kickOffTime: m.kickOffTime,
    matchDate: m.matchDate || "",
    status: m.status || "PREEVENT",
    league: m.league || "",
    leagueCode: m.leagueCode || "",
    homeTeam: m.homeTeam || "Home",
    awayTeam: m.awayTeam || "Away",
    homeTeamCh: m.homeTeamCh || "",
    awayTeamCh: m.awayTeamCh || "",
    quote: m.quote || m.books?.hkjc || { book: "hkjc" as const },
  }));
}

function filterScheduleCard(
  events: HkjcEvent[],
  today: string,
  tomorrow: string
): HkjcEvent[] {
  return events
    .filter((e) => isOnOddsCard(e.kickOffTime, e.status, today, tomorrow))
    .sort((a, b) => new Date(a.kickOffTime).getTime() - new Date(b.kickOffTime).getTime());
}

function slimSnapMarket(
  m: { market: string; line?: number | null; odds?: Record<string, number> } | null | undefined
) {
  if (!m?.odds) return null;
  return {
    market: m.market as "hdc" | "hil" | "hdc1h" | "hil1h" | "hha" | "had" | "chl",
    line: m.line ?? null,
    odds: m.odds,
  };
}

function slimHistory(history: SnapshotPoint[]): SnapshotPoint[] {
  return history.slice(-4).map((h) => ({
    at: h.at,
    books: {
      pinnacle: h.books.pinnacle
        ? {
            book: "pinnacle" as const,
            hdc: slimSnapMarket(h.books.pinnacle.hdc),
            hil: slimSnapMarket(h.books.pinnacle.hil),
            hdc1h: slimSnapMarket(h.books.pinnacle.hdc1h),
            hil1h: slimSnapMarket(h.books.pinnacle.hil1h),
            chl: slimSnapMarket(h.books.pinnacle.chl),
          }
        : undefined,
      hkjc: h.books.hkjc
        ? {
            book: "hkjc" as const,
            hdc: slimSnapMarket(h.books.hkjc.hdc),
            hil: slimSnapMarket(h.books.hkjc.hil),
            hdc1h: slimSnapMarket(h.books.hkjc.hdc1h),
            hil1h: slimSnapMarket(h.books.hkjc.hil1h),
            hha: slimSnapMarket(h.books.hkjc.hha),
            chl: slimSnapMarket(h.books.hkjc.chl),
          }
        : undefined,
    },
  }));
}

function appendHistory(prev: SnapshotPoint[], snap: SnapshotPoint): SnapshotPoint[] {
  const key = hktMinuteKey(snap.at);
  const out = prev.filter((h) => hktMinuteKey(h.at) !== key);
  out.push(snap);
  return out.slice(-4);
}

function emptyEdge() {
  return { home: null, draw: null, away: null };
}

function matchIsLive(status: string, kickOff: string): boolean {
  return isInPlayStatus(status) || hasKickedOff(kickOff);
}

/** Live HKJC must not be compared to prematch Pin carry. */
function pinIsLiveEnough(pinUpdatedAt: string | null | undefined, kickOff: string): boolean {
  if (!pinUpdatedAt) return false;
  const pinT = new Date(pinUpdatedAt).getTime();
  const kick = new Date(kickOff).getTime();
  if (!Number.isFinite(pinT) || !Number.isFinite(kick)) return false;
  // Allow enrich from ~2m before KO (lines open into live)
  return pinT >= kick - 2 * 60_000;
}

function stripPrematchPin(row: BoardMatch): BoardMatch {
  if (!matchIsLive(row.status, row.kickOffTime)) {
    return { ...row, pinPhase: row.books.pinnacle ? "prematch" : row.pinPhase ?? null };
  }
  if (!row.books.pinnacle) {
    return { ...row, pinPhase: null };
  }
  if (pinIsLiveEnough(row.pinUpdatedAt, row.kickOffTime)) {
    return { ...row, pinPhase: "live" };
  }
  const { pinnacle: _drop, ...restBooks } = row.books;
  return {
    ...row,
    books: restBooks,
    pinUpdatedAt: null,
    pinPhase: null,
    edgeHdc: {},
    edgeHil: {},
    edgeHdc1h: {},
    edgeHil1h: {},
    edgeChl: {},
    edgeHad: emptyEdge(),
    edgeHha: emptyEdge(),
    pinFairProbs: null,
    pinFairProbsHdc: null,
    pinFairProbsHil: null,
    pinFairProbsHdc1h: null,
    pinFairProbsHil1h: null,
    pinFairProbsChl: null,
  };
}


/**
 * Priority: in-play → kickoff soonest → rotate remaining PREEVENT (KV cursor).
 */
function selectEnrichIds(
  events: HkjcEvent[],
  cursor: number,
  budget: number,
  nowMs: number
): { enrichIds: string[]; nextCursor: number } {
  const inPlay: HkjcEvent[] = [];
  const soon: HkjcEvent[] = [];
  const rest: HkjcEvent[] = [];

  for (const e of events) {
    const kick = new Date(e.kickOffTime).getTime();
    if (isInPlayStatus(e.status) || hasKickedOff(e.kickOffTime, new Date(nowMs))) {
      inPlay.push(e);
    } else if (Number.isFinite(kick) && kick - nowMs <= SOON_MS) {
      soon.push(e);
    } else {
      rest.push(e);
    }
  }

  const byKick = (a: HkjcEvent, b: HkjcEvent) =>
    new Date(a.kickOffTime).getTime() - new Date(b.kickOffTime).getTime();
  inPlay.sort(byKick);
  soon.sort(byKick);
  rest.sort(byKick);

  // Reserve slots so in-play/soon never starve PREEVENT fair-share rotation.
  const rotateReserve = rest.length ? Math.min(2, Math.max(1, budget - 3)) : 0;
  const inPlayCap = Math.min(inPlay.length, Math.max(1, budget - rotateReserve - 1));
  const soonCap = Math.min(soon.length, Math.max(0, budget - rotateReserve - inPlayCap));

  const picked: string[] = [];
  const take = (list: HkjcEvent[], cap: number) => {
    for (const e of list) {
      if (picked.length >= cap) break;
      if (!picked.includes(e.id)) picked.push(e.id);
    }
  };

  take(inPlay, inPlayCap);
  take(soon, picked.length + soonCap);

  let nextCursor = cursor;
  if (rest.length && picked.length < budget) {
    const need = budget - picked.length;
    const start = ((cursor % rest.length) + rest.length) % rest.length;
    let added = 0;
    for (let i = 0; i < rest.length && picked.length < budget; i++) {
      const e = rest[(start + i) % rest.length];
      if (!picked.includes(e.id)) {
        picked.push(e.id);
        added += 1;
      }
    }
    nextCursor = (start + Math.max(added, need)) % rest.length;
  }

  return { enrichIds: picked.slice(0, budget), nextCursor };
}

function buildRow(opts: {
  e: HkjcEvent;
  link: ReturnType<typeof linkBook>;
  books: BoardMatch["books"];
  prevRow: BoardMatch | null;
  prevBoardAt: string | null;
  at: string;
  lastUpdated: string;
  pinUpdatedAt: string | null;
  runSignals: boolean;
}): BoardMatch {
  const { e, link, books, prevRow, prevBoardAt, at, lastUpdated, pinUpdatedAt, runSignals } = opts;
  const links = link
    ? [link]
    : prevRow?.links?.filter((l) => l.book === "pinnacle") || [];

  const pinFairOdds = books.pinnacle?.had?.fair?.odds || null;
  const edgeHad = computeEdgeHad(books.hkjc?.had?.odds || null, pinFairOdds);
  const hhaLine = books.hkjc?.hha?.line;
  const hhaComparable =
    hhaLine != null && Number.isFinite(hhaLine) && Math.abs(hhaLine) < 0.01;
  const edgeHha = hhaComparable
    ? computeEdgeHad(books.hkjc?.hha?.odds || null, pinFairOdds)
    : emptyEdge();
  const edgeHdc = computeEdgeTwoWay(books.hkjc?.hdc, books.pinnacle?.hdc, ["home", "away"]);
  const edgeHil = computeEdgeTwoWay(books.hkjc?.hil, books.pinnacle?.hil, ["over", "under"]);
  const edgeHdc1h = computeEdgeTwoWay(books.hkjc?.hdc1h, books.pinnacle?.hdc1h, ["home", "away"]);
  const edgeHil1h = computeEdgeTwoWay(books.hkjc?.hil1h, books.pinnacle?.hil1h, ["over", "under"]);
  const edgeChl = computeEdgeTwoWay(books.hkjc?.chl, books.pinnacle?.chl, ["over", "under"]);

  const openPinHad = prevRow?.openPinHad || books.pinnacle?.had?.odds || null;

  let signals = prevRow?.signals || [];
  let sparkHome = prevRow?.sparkHome;
  let sparkAhHome = prevRow?.sparkAhHome;
  let sparkAh1hHome = prevRow?.sparkAh1hHome;
  let sparkChlOver = prevRow?.sparkChlOver;

  if (runSignals) {
    const boardHistory =
      prevRow && prevBoardAt
        ? slimHistory([{ at: prevBoardAt, books: prevRow.books }])
        : [];
    signals = detectSignals({
      at,
      links,
      history: boardHistory,
      books,
      edgeHad,
      edgeHha,
      edgeHdc,
      edgeHil,
      edgeHdc1h,
      edgeHil1h,
      edgeChl,
      openPinHad,
      prevPinHad: prevRow?.books.pinnacle?.had?.odds || null,
      prevHkjcHad: prevRow?.books.hkjc?.had?.odds || null,
      prevHkjcHdc: prevRow?.books.hkjc?.hdc,
      prevPinHdc: prevRow?.books.pinnacle?.hdc,
      prevHkjcHil: prevRow?.books.hkjc?.hil,
      prevPinHil: prevRow?.books.pinnacle?.hil,
      prevHkjcHdc1h: prevRow?.books.hkjc?.hdc1h,
      prevPinHdc1h: prevRow?.books.pinnacle?.hdc1h,
      prevHkjcHil1h: prevRow?.books.hkjc?.hil1h,
      prevPinHil1h: prevRow?.books.pinnacle?.hil1h,
      prevHkjcChl: prevRow?.books.hkjc?.chl,
      prevPinChl: prevRow?.books.pinnacle?.chl,
    });
    const snap: SnapshotPoint = {
      at,
      books,
      edgeHad,
      edgeHha,
      edgeHdc,
      edgeHil,
      edgeHdc1h,
      edgeHil1h,
      edgeChl,
      signals,
    };
    const history = dedupeSnapshotsByMinute(appendHistory(boardHistory, snap));
    sparkHome = latestSpark(history, "had", "home");
    sparkAhHome = latestSpark(history, "hdc", "home");
    sparkAh1hHome = latestSpark(history, "hdc1h", "home");
    sparkChlOver = latestSpark(history, "chl", "over");
  }

  return {
    id: e.id,
    frontEndId: e.frontEndId,
    kickOffTime: e.kickOffTime,
    matchDate: e.matchDate,
    status: e.status,
    league: e.league,
    leagueCode: e.leagueCode,
    homeTeam: e.homeTeam,
    awayTeam: e.awayTeam,
    homeTeamCh: e.homeTeamCh,
    awayTeamCh: e.awayTeamCh,
    links,
    books,
    edgeHad,
    edgeHha,
    edgeHdc,
    edgeHil,
    edgeHdc1h,
    edgeHil1h,
    edgeChl,
    pinFairProbs: books.pinnacle?.had?.fair?.probs || null,
    hkjcFairProbs: books.hkjc?.had?.fair?.probs || null,
    pinFairProbsHdc: books.pinnacle?.hdc?.fair?.probs || null,
    hkjcFairProbsHdc: books.hkjc?.hdc?.fair?.probs || null,
    pinFairProbsHil: books.pinnacle?.hil?.fair?.probs || null,
    hkjcFairProbsHil: books.hkjc?.hil?.fair?.probs || null,
    hkjcFairProbsHha: books.hkjc?.hha?.fair?.probs || null,
    pinFairProbsHdc1h: books.pinnacle?.hdc1h?.fair?.probs || null,
    hkjcFairProbsHdc1h: books.hkjc?.hdc1h?.fair?.probs || null,
    pinFairProbsHil1h: books.pinnacle?.hil1h?.fair?.probs || null,
    hkjcFairProbsHil1h: books.hkjc?.hil1h?.fair?.probs || null,
    pinFairProbsChl: books.pinnacle?.chl?.fair?.probs || null,
    hkjcFairProbsChl: books.hkjc?.chl?.fair?.probs || null,
    signals,
    openPinHad,
    openPinLine: prevRow?.openPinLine ?? books.pinnacle?.hdc?.line ?? null,
    openPinHilLine: prevRow?.openPinHilLine ?? books.pinnacle?.hil?.line ?? null,
    openPinHdc1hLine: prevRow?.openPinHdc1hLine ?? books.pinnacle?.hdc1h?.line ?? null,
    openPinHil1hLine: prevRow?.openPinHil1hLine ?? books.pinnacle?.hil1h?.line ?? null,
    openPinChlLine: prevRow?.openPinChlLine ?? books.pinnacle?.chl?.line ?? null,
    sparkHome,
    sparkAhHome,
    sparkAh1hHome,
    sparkChlOver,
    matchConfidence: links.length ? worstConfidence(links) : "unmatched",
    lastUpdated,
    pinUpdatedAt,
  };
}

/**
 * Free-plan collect (priority queue):
 * 1) Cheap full-card HKJC schedule (no foPools)
 * 2) Deep HKJC odds + Pin for ≤ENRICH_BATCH by priority (in-play → soon → rotate)
 * 3) Board shows ALL active fixtures; stale odds OK for non-enriched
 *
 * mode=full → both (default; cron)
 * mode=lean → same path, tiny priority batch only (manual Refresh)
 * mode=hkjc → schedule + HKJC deep only
 * mode=pin → Pin enrich on prior board (no schedule/HKJC deep)
 */

async function loadScheduleFromFanaticsKv(
  today: string,
  tomorrow: string
): Promise<HkjcEvent[]> {
  try {
    const { getCloudflareContext } = await import("@opennextjs/cloudflare");
    const ctx = await getCloudflareContext({ async: true });
    const env = ctx?.env as { HISTORIC_CACHE?: { get(key: string): Promise<string | null> } } | undefined;
    const raw = await env?.HISTORIC_CACHE?.get(BOARD_CACHE_KEY);
    if (!raw) return [];
    const data = JSON.parse(raw) as {
      today?: string;
      tomorrow?: string;
      matches?: Array<{
        id: string;
        frontEndId: string;
        kickOffTime: string;
        matchDate?: string;
        status?: string;
        league?: string;
        leagueCode?: string;
        homeTeam?: string;
        awayTeam?: string;
        homeTeamCh?: string;
        awayTeamCh?: string;
      }>;
    };
    // Reject rolled calendar — same rule as main Fanatics readBoardCache
    if (data.today && data.tomorrow && (data.today !== today || data.tomorrow !== tomorrow)) {
      return [];
    }
    return toScheduleEvents(data.matches || []);
  } catch {
    return [];
  }
}

export async function GET(req: NextRequest) {
  const secret = req.nextUrl.searchParams.get("secret");
  const expected = process.env.COLLECT_SECRET;
  if (expected && secret !== expected) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }

  const modeParam = (req.nextUrl.searchParams.get("mode") || "full").toLowerCase();
  const mode: "full" | "lean" | "hkjc" | "pin" =
    modeParam === "hkjc" || modeParam === "pin" || modeParam === "lean"
      ? modeParam
      : "full";
  const lean = mode === "lean";
  const defaultBatch = lean ? LEAN_ENRICH_BATCH : ENRICH_BATCH;
  const maxBatch = lean ? LEAN_ENRICH_BATCH : 10;
  const enrichLimit = Math.min(
    maxBatch,
    Math.max(1, Number(req.nextUrl.searchParams.get("pinLimit")) || defaultBatch)
  );
  const cornersMax = lean ? LEAN_PIN_CORNERS_MAX : PIN_CORNERS_MAX;

  const started = Date.now();
  const at = new Date().toISOString();
  const today = formatHktDate();
  const tomorrow = addDaysHkt(today, 1);
  const sources = { hkjc: false, pinnacle: false, smarkets: false, matchbook: false };
  let lastError: string | null = null;

  try {
    const kv = await getKv();
    const prevBoard = await loadBoard(kv);
    const prevById = new Map((prevBoard?.matches || []).map((m) => [m.id, m]));
    const prevBoardAt = prevBoard?.lastCollectAt || prevBoard?.fetchedAt || null;

    let schedule: HkjcEvent[] = [];

    const mergeScheduleCards = (primary: HkjcEvent[], secondary: HkjcEvent[]): HkjcEvent[] => {
      const byId = new Map<string, HkjcEvent>();
      for (const e of secondary) byId.set(e.id, e);
      for (const e of primary) {
        const prev = byId.get(e.id);
        byId.set(e.id, prev ? { ...prev, ...e, status: e.status || prev.status } : e);
      }
      return filterScheduleCard([...byId.values()], today, tomorrow);
    };

    // Live HKJC (HAD seed) + calendar-valid Fanatics KV — same today/tomorrow window as main card
    // Lean Refresh skips Fanatics board-KV parse (CPU) — prior odds board fills gaps below.
    const sched = await fetchHkjcSchedule();
    if (sched.error) lastError = `${lastError || ""} | ${sched.error}`;
    const liveCard = filterScheduleCard(sched.events, today, tomorrow);
    if (lean) {
      // Skip Fanatics HISTORIC_CACHE parse; merge live + prior odds board (already in memory).
      const fromPrev = prevBoard?.matches?.length
        ? filterScheduleCard(toScheduleEvents(prevBoard.matches), today, tomorrow)
        : [];
      schedule = mergeScheduleCards(liveCard, fromPrev);
      if (liveCard.length) sources.hkjc = true;
    } else {
      const fromKv = await loadScheduleFromFanaticsKv(today, tomorrow);
      const kvCard = filterScheduleCard(fromKv, today, tomorrow);
      schedule = mergeScheduleCards(liveCard, kvCard);
      if (liveCard.length) sources.hkjc = true;
      if (!liveCard.length && kvCard.length) {
        lastError = `${lastError || ""} | schedule from Fanatics KV only`.trim();
      }
    }

    if (!schedule.length && prevBoard?.matches?.length) {
      schedule = filterScheduleCard(toScheduleEvents(prevBoard.matches), today, tomorrow);
      lastError = `${lastError || ""} | using prior odds board (day-filtered)`;
    }

    if (mode === "pin" && !schedule.length) {
      lastError = lastError || "pin mode: empty schedule";
    }

    const rotate = await loadPinRotate(kv);
    const { enrichIds, nextCursor } = selectEnrichIds(
      schedule,
      rotate.cursor,
      enrichLimit,
      Date.now()
    );
    const enrichSet = new Set(enrichIds);

    // Deep HKJC odds only for priority batch
    const deepById = new Map<string, HkjcEvent>();
    if (mode !== "pin" && enrichIds.length) {
      const deep = await fetchHkjcEventsForIds(enrichIds);
      if (deep.error) lastError = `${lastError || ""} | deep: ${deep.error}`;
      for (const e of deep.events) deepById.set(e.id, e);
      sources.hkjc = deep.events.some(
        (e) =>
          !!(
            e.quote.had ||
            e.quote.hha ||
            e.quote.hdc ||
            e.quote.hil ||
            e.quote.hdc1h ||
            e.quote.hil1h ||
            e.quote.chl
          )
      );
    } else {
      sources.hkjc = !!prevBoard?.sources?.hkjc;
    }
    if (!sources.hkjc && prevBoard?.sources?.hkjc) sources.hkjc = true;

    // Pin index + link only enrich batch (+ keep prev links for rest)
    const pinQuotes = new Map<
      number,
      Awaited<ReturnType<typeof fetchPinnacleMarketsForMatchup>>
    >();
    const pinLinks = new Map<string, NonNullable<ReturnType<typeof linkBook>>>();
    const pinEnriched = new Set<string>();

    if (mode !== "hkjc" && enrichIds.length) {
      try {
        const pinList = await loadPinIndex(kv);
        const pinCands: ExtCandidate[] = pinList.slice(0, lean ? 80 : 160).map((e) => ({
          book: "pinnacle",
          id: e.id,
          home: e.home,
          away: e.away,
          kickOff: e.startTime,
        }));
        for (const id of enrichIds) {
          const e = deepById.get(id) || schedule.find((x) => x.id === id);
          if (!e) continue;
          const link = linkBook(e.homeTeam, e.awayTeam, e.kickOffTime, pinCands, "pinnacle");
          if (link) pinLinks.set(id, link);
        }

        let cornersLeft = cornersMax;
        for (const [mid, link] of pinLinks) {
          const pid = Number(link.externalId);
          if (!Number.isFinite(pid)) continue;
          try {
            // pin mode has no deep HKJC fetch — fall back to schedule quote (board HKJC lines)
            const ev = deepById.get(mid) || schedule.find((x) => x.id === mid);
            const hk = ev?.quote;
            const flip = link.flipped;
            // Targets in Pin frame (before flipQuote)
            const tgt = (line: number | null | undefined) =>
              line == null || !Number.isFinite(line) ? null : orientLine(line, flip);
            let q = await fetchPinnacleMarketsForMatchup(pid, {
              hdc: tgt(hk?.hdc?.line),
              hil: tgt(hk?.hil?.line),
              hdc1h: tgt(hk?.hdc1h?.line),
              hil1h: tgt(hk?.hil1h?.line),
            });
            if (!(q && (q.had || q.hdc || q.hil || q.hdc1h || q.hil1h))) continue;
            if (cornersLeft > 0 && hk?.chl) {
              try {
                q = await attachPinnacleCorners(pid, q, tgt(hk.chl.line));
                cornersLeft -= 1;
              } catch {
                /* optional */
              }
            }
            pinQuotes.set(pid, q);
            pinEnriched.add(mid);
          } catch {
            /* skip */
          }
        }
        sources.pinnacle = pinQuotes.size > 0 || !!prevBoard?.sources?.pinnacle;
      } catch (pinErr) {
        lastError = `${lastError || ""} | pin: ${pinErr instanceof Error ? pinErr.message : "pin failed"}`;
        sources.pinnacle = !!prevBoard?.sources?.pinnacle;
      }
    } else {
      sources.pinnacle = !!prevBoard?.sources?.pinnacle;
    }

    await savePinRotate(kv, { cursor: nextCursor, at, lastIds: enrichIds });

    const prevAlerts = (await loadAlerts(kv)).slice(0, 30);
    const newAlerts: AlertItem[] = [];
    const boardMatches: BoardMatch[] = [];

    for (const e0 of schedule) {
      const prevRow = prevById.get(e0.id) || null;
      const enriched = enrichSet.has(e0.id);
      const deep = deepById.get(e0.id);

      // Non-enriched: keep prior row (stale OK), or cheap skeleton for new card rows
      if (!enriched) {
        if (prevRow) {
          boardMatches.push(
            stripPrematchPin({
              ...prevRow,
              status: e0.status || prevRow.status,
              kickOffTime: e0.kickOffTime || prevRow.kickOffTime,
              matchDate: e0.matchDate || prevRow.matchDate,
              league: e0.league || prevRow.league,
              leagueCode: e0.leagueCode || prevRow.leagueCode,
            })
          );
        } else {
          boardMatches.push({
            id: e0.id,
            frontEndId: e0.frontEndId,
            kickOffTime: e0.kickOffTime,
            matchDate: e0.matchDate,
            status: e0.status,
            league: e0.league,
            leagueCode: e0.leagueCode,
            homeTeam: e0.homeTeam,
            awayTeam: e0.awayTeam,
            homeTeamCh: e0.homeTeamCh,
            awayTeamCh: e0.awayTeamCh,
            links: [],
            books: {},
            edgeHad: emptyEdge(),
            edgeHha: emptyEdge(),
            edgeHdc: {},
            edgeHil: {},
            edgeHdc1h: {},
            edgeHil1h: {},
            edgeChl: {},
            pinFairProbs: null,
            hkjcFairProbs: null,
            signals: [],
            matchConfidence: "unmatched",
            lastUpdated: null,
            pinUpdatedAt: null,
          });
        }
        continue;
      }

      const e = deep || e0;
      const books: BoardMatch["books"] = {};
      if (deep?.quote && (deep.quote.had || deep.quote.hdc || deep.quote.hil || deep.quote.hha)) {
        books.hkjc = deep.quote;
      } else if (prevRow?.books.hkjc) {
        books.hkjc = prevRow.books.hkjc;
      } else if (e.quote && (e.quote.had || e.quote.hdc)) {
        books.hkjc = e.quote;
      }

      let pinUpdatedAt: string | null = prevRow?.pinUpdatedAt || null;
      const link = pinLinks.get(e0.id) || null;
      const live = matchIsLive(e.status || e0.status, e.kickOffTime || e0.kickOffTime);
      let pinFresh = false;
      if (link) {
        const q = pinQuotes.get(Number(link.externalId));
        if (q) {
          books.pinnacle = flipQuote(q, link.flipped);
          pinUpdatedAt = at;
          pinFresh = true;
        } else if (prevRow?.books.pinnacle && !live) {
          books.pinnacle = prevRow.books.pinnacle;
        }
        // live + no fresh Pin: do not carry prematch Pin
      } else if (prevRow?.books.pinnacle && !live) {
        books.pinnacle = prevRow.books.pinnacle;
      }

      const hkjcUpdated = deep ? at : prevRow?.lastUpdated || prevBoardAt || at;

      const row = buildRow({
        e: {
          ...e0,
          status: e.status || e0.status,
          kickOffTime: e.kickOffTime || e0.kickOffTime,
          quote: books.hkjc || e0.quote,
        },
        link:
          link ||
          (prevRow?.links?.find((l) => l.book === "pinnacle") as ReturnType<typeof linkBook>) ||
          null,
        books,
        prevRow,
        prevBoardAt,
        at,
        lastUpdated: hkjcUpdated || at,
        pinUpdatedAt,
        runSignals: enriched && (pinEnriched.has(e0.id) || !!deep),
      });
      const withPhase: BoardMatch = {
        ...row,
        pinPhase: books.pinnacle
          ? live && (pinFresh || pinIsLiveEnough(pinUpdatedAt, e0.kickOffTime))
            ? "live"
            : "prematch"
          : null,
      };
      boardMatches.push(stripPrematchPin(withPhase));

      if (pinEnriched.has(e0.id)) {
        for (const s of row.signals) {
          if (s.kind === "agree") continue;
          const dup = prevAlerts.some(
            (a) =>
              a.matchId === e0.id &&
              a.kind === s.kind &&
              Math.abs(new Date(a.at).getTime() - new Date(s.at).getTime()) < 20 * 60_000
          );
          if (dup) continue;
          if (prevRow?.signals.some((ps) => ps.kind === s.kind && ps.note === s.note)) continue;
          newAlerts.push({
            id: `${e0.id}-${s.kind}-${at}`,
            at: s.at,
            kind: s.kind,
            title: `${s.label} · ${e0.homeTeam} v ${e0.awayTeam}`,
            meta: s.note,
            matchId: e0.id,
            frontEndId: e0.frontEndId,
            sizeLabel: (() => {
              const win = s.windowMins != null ? ` · ${s.windowMins}m` : "";
              const str = s.strength ? ` · ${s.strength}` : "";
              if (s.magnitude == null) return `${s.kind}${win}`;
              if (s.kind === "value")
                return `Edge ${s.magnitude >= 0 ? "+" : ""}${s.magnitude.toFixed(1)}%`;
              if (s.kind === "line_lag" || s.kind === "lag") {
                return s.market === "hdc" || s.market === "hil"
                  ? `Line Δ ${s.magnitude.toFixed(2)}${win}`
                  : `Move ${s.magnitude.toFixed(1)}%${win}`;
              }
              if (isSteamKind(s.kind) || isRlmKind(s.kind)) {
                const unit =
                  s.magnitude < 2
                    ? `Line Δ ${s.magnitude.toFixed(2)}`
                    : `${s.magnitude.toFixed(1)}%`;
                return `${unit}${win}${str}`;
              }
              return `Move ${Number(s.magnitude).toFixed(1)}%${win}`;
            })(),
          });
        }
      }
    }

    const alerts = [...newAlerts, ...prevAlerts].slice(0, 200);
    await saveAlerts(kv, alerts.slice(0, 40));

    const pinFreshCount = boardMatches.filter((m) => m.pinUpdatedAt === at).length;
    const hkjcFreshCount = boardMatches.filter((m) => m.lastUpdated === at).length;

    const cardMatches = boardMatches.filter((m) =>
      isOnOddsCard(m.kickOffTime, m.status, today, tomorrow)
    );
    // Prefer live status from schedule when present
    const schedById = new Map(schedule.map((e) => [e.id, e]));
    for (let i = 0; i < cardMatches.length; i++) {
      const live = schedById.get(cardMatches[i].id);
      if (live?.status) {
        cardMatches[i] = { ...cardMatches[i], status: live.status };
      }
    }
    const matchedCountLive = cardMatches.filter((m) =>
      m.links.some((l) => l.book === "pinnacle")
    ).length;
    const valueCountLive = cardMatches.filter(
      (m) => maxPositiveEdge(m.edgeHdc, m.edgeHil, m.edgeHad) >= 2
    ).length;
    const signalCountLive = cardMatches.reduce(
      (n, m) => n + m.signals.filter((s) => s.kind !== "agree").length,
      0
    );

    const board: BoardResponse = {
      ok: true,
      timezone: "Asia/Hong_Kong",
      today,
      tomorrow,
      fetchedAt: at,
      lastCollectAt: at,
      matchCount: cardMatches.length,
      matchedCount: matchedCountLive,
      valueCount: valueCountLive,
      signalCount: signalCountLive,
      matches: cardMatches,
      error: lastError,
      sources,
    };
    await saveBoard(kv, board);
    await saveMeta(kv, { lastCollectAt: at, sources, lastError });

    return NextResponse.json({
      ok: true,
      mode,
      matchCount: board.matchCount,
      matchedCount: board.matchedCount,
      hkjcFreshCount,
      pinFreshCount,
      enrichLimit,
      enrichIds,
      pinCursor: nextCursor,
      alertsAdded: newAlerts.length,
      valueCount: board.valueCount,
      today: board.today,
      tomorrow: board.tomorrow,
      sources,
      error: lastError,
      at,
      ms: Date.now() - started,
    });
  } catch (e) {
    return NextResponse.json(
      {
        ok: false,
        error: e instanceof Error ? e.message : "collect failed",
        ms: Date.now() - started,
      },
      { status: 500 }
    );
  }
}

export async function POST(req: NextRequest) {
  return GET(req);
}
