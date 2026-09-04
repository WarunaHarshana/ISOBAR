import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import {
  availableCash,
  cityLedger,
  loadPaperBook,
  paperTrade,
  patchSettings,
  realizedPnl,
  resetBook,
  savePaperBook,
  truncateFills,
} from "./paper-book";
import { getWorkerStatus, startPaperWorker, tickPaperWorker } from "./paper-worker";
import type { Signal } from "./types";

const settingsPatchSchema = z
  .object({
    bankroll: z.number().positive().max(1_000_000).optional(),
    kellyFraction: z.number().min(0).max(1).optional(),
    minEdge: z.number().min(0).max(1).optional(),
    minPrice: z.number().min(0).max(1).optional(),
    maxPrice: z.number().min(0).max(1).optional(),
    maxPosPct: z.number().min(0).max(1).optional(),
    armed: z.boolean().optional(),
  })
  .strict();

const signalSchema = z.object({
  id: z.string(),
  eventId: z.string(),
  marketId: z.string(),
  cityId: z.string(),
  cityName: z.string(),
  date: z.string(),
  kind: z.enum(["high", "low"]),
  unit: z.enum(["C", "F"]),
  question: z.string(),
  label: z.string(),
  side: z.enum(["YES", "NO"]),
  marketP: z.number(),
  modelP: z.number(),
  edge: z.number(),
  kelly: z.number(),
  volume24hr: z.number(),
});

function bookPayload() {
  const book = loadPaperBook();
  const pnl = realizedPnl(book.fills);
  return {
    book,
    worker: getWorkerStatus(),
    equity: book.settings.bankroll + pnl.closed,
    cash: availableCash(book),
    pnl,
    cities: cityLedger(book.fills),
  };
}

export const getPaperBookFn = createServerFn({ method: "GET" }).handler(async () => {
  startPaperWorker();
  return bookPayload();
});

export const patchPaperSettingsFn = createServerFn({ method: "POST" })
  .validator((input: unknown) => settingsPatchSchema.parse(input))
  .handler(async ({ data }) => {
    startPaperWorker();
    patchSettings(data);
    if (data.armed === true) {
      await tickPaperWorker();
    }
    return bookPayload();
  });

export const resetPaperBookFn = createServerFn({ method: "POST" }).handler(async () => {
  startPaperWorker();
  resetBook();
  return bookPayload();
});

export const manualPaperTradeFn = createServerFn({ method: "POST" })
  .validator((input: unknown) => signalSchema.parse(input))
  .handler(async ({ data }) => {
    startPaperWorker();
    const book = loadPaperBook();
    const fill = paperTrade(data as Signal, book);
    if (fill) {
      savePaperBook({ ...book, fills: truncateFills([fill, ...book.fills]) });
    }
    return { fill, ...bookPayload() };
  });
