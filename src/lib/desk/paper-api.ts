import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import {
  loadPaperBook,
  paperTrade,
  patchSettings,
  realizedPnl,
  resetBook,
  savePaperBook,
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

export const getPaperBookFn = createServerFn({ method: "GET" }).handler(async () => {
  startPaperWorker();
  const book = loadPaperBook();
  const pnl = realizedPnl(book.fills);
  return {
    book,
    worker: getWorkerStatus(),
    equity: book.settings.bankroll + pnl.closed,
    pnl,
  };
});

export const patchPaperSettingsFn = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) => settingsPatchSchema.parse(input))
  .handler(async ({ data }) => {
    startPaperWorker();
    const book = patchSettings(data);
    // If newly armed, tick immediately so fills do not wait a full interval.
    if (data.armed === true) {
      await tickPaperWorker();
    }
    const pnl = realizedPnl(book.fills);
    return {
      book: loadPaperBook(),
      worker: getWorkerStatus(),
      equity: book.settings.bankroll + pnl.closed,
      pnl,
    };
  });

export const resetPaperBookFn = createServerFn({ method: "POST" }).handler(async () => {
  startPaperWorker();
  const book = resetBook();
  const pnl = realizedPnl(book.fills);
  return {
    book,
    worker: getWorkerStatus(),
    equity: book.settings.bankroll + pnl.closed,
    pnl,
  };
});

export const manualPaperTradeFn = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) => signalSchema.parse(input))
  .handler(async ({ data }) => {
    startPaperWorker();
    const book = loadPaperBook();
    const pnl = realizedPnl(book.fills);
    const bankroll = book.settings.bankroll + pnl.closed;
    const fill = paperTrade(data as Signal, bankroll, book);
    if (fill) {
      savePaperBook({ ...book, fills: [fill, ...book.fills].slice(0, 80) });
    }
    const next = loadPaperBook();
    const nextPnl = realizedPnl(next.fills);
    return {
      fill,
      book: next,
      worker: getWorkerStatus(),
      equity: next.settings.bankroll + nextPnl.closed,
      pnl: nextPnl,
    };
  });
