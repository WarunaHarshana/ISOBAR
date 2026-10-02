import { getWorkerStatus, startPaperWorker } from "../../src/lib/desk/paper-worker";
import { availableCash, cityLedger, fillTickets, loadPaperBook, realizedPnl } from "../../src/lib/desk/paper-book";
import { strategy } from "../../src/lib/desk/strategy";

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
    strategy: (() => {
      const s = strategy();
      return {
        minPriceYes: s.minPriceYes,
        takerFeeRate: s.takerFeeRate,
        blend: s.blend,
        stationBiasCities: Object.keys(s.stationBiasC).length,
        fills: "walk CLOB asks to the net-edge limit, Kelly target cap, VWAP",
      };
    })(),
    marks: "market (held side's best bid, else mid; settled = resolution)",
    markPnl: fillTickets(book.fills, book.marks).reduce((a, t) => a + (t.status === "open" ? t.pnl : 0), 0),
    cities: cityLedger(book.fills, book.marks),
    tickets: fillTickets(book.fills, book.marks),
  };
}
