import { getWorkerStatus, startPaperWorker } from "../../src/lib/desk/paper-worker";
import { availableCash, cityLedger, fillTickets, loadPaperBook, realizedPnl } from "../../src/lib/desk/paper-book";

/**
 * Railway healthcheck. Plain default export — Nitro v3 in this stack does not
 * inject defineEventHandler as a global (that caused /health → 500).
 */
export default function healthHandler() {
  startPaperWorker();
  const worker = getWorkerStatus();
  const book = loadPaperBook();
  return {
    ok: true,
    worker: {
      running: worker.running,
      armed: worker.armed,
      lastTickAt: worker.lastTickAt,
      openFills: worker.openFills,
      liveLocked: worker.liveLocked,
      ticks: worker.ticks,
      lastError: worker.lastError,
      filledLastTick: worker.filledLastTick,
      cash: worker.cash,
    },
    openFills: book.fills.filter((f) => f.status === "open").length,
    fills: book.fills.length,
    cash: availableCash(book),
    pnl: realizedPnl(book.fills),
    cities: cityLedger(book.fills),
    tickets: fillTickets(book.fills),
  };
}
