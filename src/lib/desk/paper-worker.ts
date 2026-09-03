import { buildDeskSnapshot } from "./snapshot";
import {
  loadPaperBook,
  paperTrade,
  realizedPnl,
  savePaperBook,
  settleFills,
  type PaperBook,
} from "./paper-book";

const TICK_MS = 25_000;
const MAX_FILLS_PER_TICK = 4;

let timer: ReturnType<typeof setInterval> | null = null;
let running = false;

export function getWorkerStatus() {
  const book = loadPaperBook();
  return {
    running: Boolean(timer),
    armed: book.settings.armed,
    lastTickAt: book.lastTickAt,
    lastError: book.lastError,
    ticks: book.ticks,
    filledLastTick: book.filledLastTick,
    openFills: book.fills.filter((f) => f.status === "open").length,
  };
}

export async function tickPaperWorker(): Promise<PaperBook> {
  if (running) return loadPaperBook();
  running = true;
  let book = loadPaperBook();
  try {
    const snapshot = await buildDeskSnapshot();

    // Settle resolved buckets first.
    let fills = book.fills;
    for (const ev of snapshot.events) {
      for (const b of ev.buckets) {
        if (b.yesPrice >= 0.98) fills = settleFills(fills, b.marketId, true);
        else if (b.yesPrice <= 0.02 && b.noPrice >= 0.98) fills = settleFills(fills, b.marketId, false);
      }
    }

    book = { ...book, fills };
    let filled = 0;

    if (book.settings.armed) {
      const { closed } = realizedPnl(book.fills);
      const bankroll = book.settings.bankroll + closed;
      const nextFills = [...book.fills];
      for (const sig of snapshot.signals) {
        if (sig.edge < book.settings.minEdge) continue;
        const draft = { ...book, fills: nextFills };
        const fill = paperTrade(sig, bankroll, draft);
        if (!fill) continue;
        nextFills.unshift(fill);
        filled += 1;
        if (filled >= MAX_FILLS_PER_TICK) break;
      }
      book = { ...book, fills: nextFills.slice(0, 80) };
    }

    book = {
      ...book,
      lastTickAt: new Date().toISOString(),
      lastError: snapshot.warning,
      ticks: book.ticks + 1,
      filledLastTick: filled,
    };
    savePaperBook(book);
    if (filled > 0) {
      console.log(`[isobar] paper worker filled ${filled} order(s)`);
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
    running = false;
  }
}

export function startPaperWorker() {
  if (timer) return getWorkerStatus();
  // Kick once on boot, then every 25s — mirrors the desk refresh cadence.
  void tickPaperWorker();
  timer = setInterval(() => {
    void tickPaperWorker();
  }, TICK_MS);
  // Unref so the timer alone does not keep a process zombie on some runtimes.
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
