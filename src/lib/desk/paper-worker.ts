import { fetchJson } from "./cache";
import { buildDeskSnapshot } from "./snapshot";
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
  type PaperBook,
} from "./paper-book";

const TICK_MS = 25_000;

let timer: ReturnType<typeof setInterval> | null = null;
let running = false;

type GammaMarket = {
  id?: string;
  closed?: boolean;
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
  const openIds = [...new Set(fills.filter((f) => f.status === "open").map((f) => f.marketId))];
  if (!openIds.length) return fills;
  let next = fills;
  for (const marketId of openIds) {
    try {
      const url = `https://gamma-api.polymarket.com/markets/${encodeURIComponent(marketId)}`;
      const market = await fetchJson<GammaMarket>(url, {
        headers: { "user-agent": "Mozilla/5.0 (compatible; IsobarDesk/1.0)" },
      });
      if (!market || market.closed !== true) continue;
      const outcomes = parseJsonArray(market.outcomes);
      const prices = parseJsonArray(market.outcomePrices).map(Number);
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
  return next;
}

export function getWorkerStatus() {
  const book = loadPaperBook();
  return {
    running: Boolean(timer),
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
  if (running) return loadPaperBook();
  running = true;
  let book = loadPaperBook();
  try {
    const lock = liveTradingLocked();
    if (lock && book.settings.armed) {
      book = { ...book, settings: { ...book.settings, armed: false }, lastError: lock };
      savePaperBook(book);
    }

    const snapshot = await buildDeskSnapshot();

    // Quant: never settle on 98¢ prints — Gamma closed+winner only.
    book = { ...book, fills: await settleOpenFillsFromGamma(book.fills) };

    let filled = 0;
    if (book.settings.armed && !liveTradingLocked()) {
      const nextFills = [...book.fills];
      for (const sig of snapshot.signals) {
        if (sig.edge < PAPER_MIN_EDGE) continue;
        const bucket = snapshot.events.flatMap((e) => e.buckets).find((b) => b.marketId === sig.marketId);
        const draft = { ...book, fills: nextFills };
        const fill = paperTrade(sig, draft, {
          bestBid: bucket?.bestBid ?? null,
          bestAsk: bucket?.bestAsk ?? null,
        });
        if (!fill) continue;
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
    running = false;
  }
}

export function startPaperWorker() {
  if (timer) return getWorkerStatus();
  void tickPaperWorker();
  timer = setInterval(() => {
    void tickPaperWorker();
  }, TICK_MS);
  if (typeof timer === "object" && timer && "unref" in timer && typeof timer.unref === "function") {
    timer.unref();
  }
  console.log("[isobar] paper worker started");
  return getWorkerStatus();
}

export function stopPaperWorker() {
  if (timer) {
    clearInterval(timer);
    timer = null;
    console.log("[isobar] paper worker stopped");
  }
  return getWorkerStatus();
}
