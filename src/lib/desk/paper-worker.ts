import { cached, fetchJson } from "./cache";
import { appendLog, marketRecord, snapshotDue } from "./forecast-log";
import type { BookLevel } from "./strategy";
import { buildDeskSnapshot, observedForSignal, pricingModel } from "./snapshot";
import { CITIES } from "./cities";
import type { PaperFill } from "./types";
import {
  PAPER_MAX_FILLS_PER_TICK,
  PAPER_MIN_EDGE,
  availableCash,
  liveTradingLocked,
  loadPaperBook,
  paperTrade,
  savePaperBook,
  settleFills,
  truncateFills,
  type MarketMark,
  type PaperBook,
} from "./paper-book";

const TICK_MS = 25_000;

type WorkerGlobals = {
  __isobarPaperTimer?: ReturnType<typeof setInterval> | null;
  __isobarPaperTickRunning?: boolean;
};

function g(): WorkerGlobals {
  return globalThis as WorkerGlobals;
}

function getTimer() {
  return g().__isobarPaperTimer ?? null;
}

function setTimer(next: ReturnType<typeof setInterval> | null) {
  g().__isobarPaperTimer = next;
}

function getRunning() {
  return Boolean(g().__isobarPaperTickRunning);
}

function setRunning(next: boolean) {
  g().__isobarPaperTickRunning = next;
}

type GammaMarket = {
  id?: string;
  closed?: boolean;
  bestBid?: number | string | null;
  bestAsk?: number | string | null;
  outcomePrices?: string | string[];
  outcomes?: string | string[];
};

function parseJsonArray(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(String);
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed) ? parsed.map(String) : [];
    } catch {
      return [];
    }
  }
  return [];
}

/**
 * Settle ONLY from Gamma closed + winner.
 * Never settle from 98¢ prints (Quant hard rule).
 */
export async function settleOpenFillsFromGamma(fills: PaperFill[]): Promise<PaperFill[]> {
  return (await refreshOpenFillsFromGamma(fills)).fills;
}

const num = (v: unknown) => {
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() ? Number(v) : NaN;
  return Number.isFinite(n) ? n : null;
};

/**
 * One Gamma read per open market: settle closed markets (winner only) and record the
 * live YES quote (best bid / ask / mid) used to mark open tickets to market.
 */
export async function refreshOpenFillsFromGamma(
  fills: PaperFill[],
): Promise<{ fills: PaperFill[]; marks: Record<string, MarketMark> }> {
  const openIds = [...new Set(fills.filter((f) => f.status === "open").map((f) => f.marketId))];
  const marks: Record<string, MarketMark> = {};
  if (!openIds.length) return { fills, marks };
  let next = fills;
  for (const marketId of openIds) {
    try {
      const url = `https://gamma-api.polymarket.com/markets/${encodeURIComponent(marketId)}`;
      const market = await fetchJson<GammaMarket>(url, {
        headers: { "user-agent": "Mozilla/5.0 (compatible; IsobarDesk/1.0)" },
      });
      if (!market) continue;
      const outcomes = parseJsonArray(market.outcomes);
      const prices = parseJsonArray(market.outcomePrices).map(Number);
      if (market.closed !== true) {
        const yesIdx0 = outcomes.findIndex((o) => o.toLowerCase() === "yes");
        const mid = yesIdx0 >= 0 ? prices[yesIdx0] : prices[0];
        marks[marketId] = {
          yesBid: num(market.bestBid),
          yesAsk: num(market.bestAsk),
          yesMid: Number.isFinite(mid) ? mid : null,
          at: new Date().toISOString(),
        };
        continue;
      }
      let yesWon: boolean | null = null;
      const yesIdx = outcomes.findIndex((o) => o.toLowerCase() === "yes");
      const noIdx = outcomes.findIndex((o) => o.toLowerCase() === "no");
      if (yesIdx >= 0 && Number.isFinite(prices[yesIdx]) && prices[yesIdx] >= 0.99) yesWon = true;
      else if (noIdx >= 0 && Number.isFinite(prices[noIdx]) && prices[noIdx] >= 0.99) yesWon = false;
      else if (yesIdx >= 0 && Number.isFinite(prices[yesIdx]) && prices[yesIdx] <= 0.01) yesWon = false;
      if (yesWon == null) continue;
      next = settleFills(next, marketId, yesWon);
    } catch (err) {
      console.warn("[isobar] gamma settle skipped for", marketId, err);
    }
  }
  return { fills: next, marks };
}

type ClobBook = { asks?: { price: string | number; size: string | number }[] };

/** Ask ladder of one CLOB token (best first); null when the book can't be read (→ no fill). */
export async function fetchAsks(tokenId: string | null | undefined): Promise<BookLevel[] | null> {
  if (!tokenId) return null;
  try {
    const book = await cached(`clob:book:${tokenId}`, 5_000, () =>
      fetchJson<ClobBook>(`https://clob.polymarket.com/book?token_id=${encodeURIComponent(tokenId)}`, {
        headers: { "user-agent": "Mozilla/5.0 (compatible; IsobarDesk/1.0)" },
      }),
    );
    const asks = (book?.asks ?? [])
      .map((l) => ({ price: Number(l.price), size: Number(l.size) }))
      .filter((l) => Number.isFinite(l.price) && Number.isFinite(l.size) && l.size > 0 && l.price > 0 && l.price < 1)
      .sort((a, b) => a.price - b.price);
    return asks.length ? asks : null;
  } catch (err) {
    console.warn("[isobar] CLOB book unavailable for", tokenId.slice(0, 12), err instanceof Error ? err.message : err);
    return null;
  }
}

export function getWorkerStatus() {
  const book = loadPaperBook({ refresh: true });
  return {
    running: Boolean(getTimer()),
    armed: book.settings.armed,
    liveLocked: liveTradingLocked(),
    lastTickAt: book.lastTickAt,
    lastError: book.lastError,
    ticks: book.ticks,
    filledLastTick: book.filledLastTick,
    openFills: book.fills.filter((f) => f.status === "open").length,
    cash: availableCash(book),
  };
}

export async function tickPaperWorker(): Promise<PaperBook> {
  if (getRunning()) return loadPaperBook({ refresh: true });
  setRunning(true);
  let book = loadPaperBook({ refresh: true });
  try {
    const lock = liveTradingLocked();
    if (lock && book.settings.armed) {
      book = { ...book, settings: { ...book.settings, armed: false }, lastError: lock };
      savePaperBook(book);
    } else if (!lock && !book.settings.armed && process.env.ISOBAR_PAPER_ARMED === "true") {
      // Headless paper arm: re-arm each tick (24/7) when explicitly enabled. Paper only;
      // liveTradingLocked() (ISOBAR_LIVE / keys present) always wins and disarms above.
      book = { ...book, settings: { ...book.settings, armed: true } };
      savePaperBook(book);
      console.log("[isobar] paper worker armed from ISOBAR_PAPER_ARMED");
    }

    const snapshot = await buildDeskSnapshot();
    // Research log: market snapshot at decision time (throttled, append-only JSONL).
    if (snapshotDue()) appendLog([marketRecord(snapshot)]);

    const refreshed = await refreshOpenFillsFromGamma(book.fills);
    // Keep the last known quote of a market whose Gamma read failed this tick.
    book = { ...book, fills: refreshed.fills, marks: { ...(book.marks ?? {}), ...refreshed.marks } };

    let filled = 0;
    // Quant: skip new fills when snapshot.warning is set (missing weather / poly).
    const canTrade = book.settings.armed && !liveTradingLocked() && !snapshot.warning;
    if (canTrade) {
      const nextFills = [...book.fills];
      for (const sig of snapshot.signals) {
        if (sig.edge < PAPER_MIN_EDGE) continue;
        const bucket = snapshot.events.flatMap((e) => e.buckets).find((b) => b.marketId === sig.marketId);
        const wx = snapshot.weather[sig.cityId];
        // Quant: dated members by kind (max for high, min for low). Never membersC (wrong-day).
        // On the live day the support test uses the time-of-day conditioned final extremes.
        const tz = CITIES.find((c) => c.id === sig.cityId)?.tz;
        const pm = pricingModel(wx, sig, tz);
        const draft = { ...book, fills: nextFills };
        // Size to the real book: walk the asks of the token being bought (fail closed without a book).
        const asks = await fetchAsks(sig.side === "YES" ? bucket?.clobYes : bucket?.clobNo);
        if (!asks) continue;
        const fill = paperTrade(sig, draft, {
          asks,
          bestBid: bucket?.bestBid ?? null,
          bestAsk: bucket?.bestAsk ?? null,
          members: pm.supportMembers,
          // Today's observed max (high) / min (low) only applies to today's (local) event.
          observedC: observedForSignal(wx, sig),
          tz,
          lo: bucket?.lo,
          hi: bucket?.hi,
        });
        if (!fill) continue;
        const intra = snapshot.events.find((e) => e.eventId === sig.eventId)?.intraday;
        console.log(
          `[isobar] paper fill ${sig.side} "${sig.question}" @${fill.price.toFixed(3)} (VWAP, ${fill.bookLevels ?? 1} lvl, limit ${fill.limitPrice?.toFixed(3) ?? "-"}) ` +
            `stake $${fill.cost.toFixed(0)}${fill.depthLimited ? ` of $${fill.requestedStake?.toFixed(0)} (depth-limited)` : ""} fee $${(fill.fee ?? 0).toFixed(2)} ` +
            `p ${sig.modelP.toFixed(3)} (model ${sig.rawModelP?.toFixed(3) ?? "-"}, mid ${sig.marketMid?.toFixed(3) ?? "-"}, w ${sig.blendW?.toFixed(2) ?? "-"}) ` +
            `net edge ${(sig.modelP - fill.price - (fill.fee ?? 0) / fill.shares).toFixed(3)} ` +
            (intra
              ? `live-day h${intra.localHour.toFixed(1)} obs ${intra.observedC} remFc ${intra.remainingFcC?.toFixed(1) ?? "-"} ` +
                `bias ${intra.biasC.toFixed(1)} f ${intra.remainingFrac.toFixed(2)} center ${intra.centerC.toFixed(1)}`
              : "ensemble (not live day)"),
        );
        appendLog([
          {
            t: "fill",
            fill,
            signal: sig,
            bucket: bucket ? { label: bucket.label, yes: bucket.yesPrice, bid: bucket.bestBid, ask: bucket.bestAsk, modelP: bucket.modelP, blendP: bucket.blendP, w: bucket.blendW } : null,
            asks: asks.slice(0, 10),
            intraday: intra ?? null,
            source: wx?.source ?? null,
          },
        ]);
        nextFills.unshift(fill);
        filled += 1;
        if (filled >= PAPER_MAX_FILLS_PER_TICK) break;
      }
      book = { ...book, fills: truncateFills(nextFills) };
    }

    book = {
      ...book,
      lastTickAt: new Date().toISOString(),
      lastError: snapshot.warning,
      ticks: book.ticks + 1,
      filledLastTick: filled,
    };
    savePaperBook(book);
    if (filled > 0) console.log(`[isobar] paper worker filled ${filled} order(s)`);
    if (snapshot.warning && book.settings.armed) {
      console.warn("[isobar] paper worker skip fills: snapshot warning", snapshot.warning);
    }
    return book;
  } catch (err) {
    const message = err instanceof Error ? err.message : "paper worker tick failed";
    book = {
      ...book,
      lastTickAt: new Date().toISOString(),
      lastError: message,
      ticks: book.ticks + 1,
      filledLastTick: 0,
    };
    savePaperBook(book);
    console.error("[isobar] paper worker tick failed", err);
    return book;
  } finally {
    setRunning(false);
  }
}

export function startPaperWorker() {
  if (getTimer()) return getWorkerStatus();
  void tickPaperWorker();
  const timer = setInterval(() => {
    void tickPaperWorker();
  }, TICK_MS);
  if (typeof timer === "object" && timer && "unref" in timer && typeof timer.unref === "function") {
    timer.unref();
  }
  setTimer(timer);
  console.log("[isobar] paper worker started");
  return getWorkerStatus();
}

export function stopPaperWorker() {
  const timer = getTimer();
  if (timer) {
    clearInterval(timer);
    setTimer(null);
    console.log("[isobar] paper worker stopped");
  }
  return getWorkerStatus();
}
