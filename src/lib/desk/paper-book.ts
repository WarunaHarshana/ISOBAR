import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import type { BotSettings, PaperFill, Signal } from "./types";

export type PaperBook = {
  settings: BotSettings;
  fills: PaperFill[];
  lastTickAt: string | null;
  lastError: string | null;
  ticks: number;
  filledLastTick: number;
};

const defaults: BotSettings = {
  bankroll: 10_000,
  kellyFraction: 0.12,
  minEdge: 0.06,
  minPrice: 0.05,
  maxPrice: 0.85,
  maxPosPct: 0.08,
  armed: false,
};

function dataPath() {
  const dir = process.env.ISOBAR_DATA_DIR || "/tmp/isobar";
  return join(dir, "paper-book.json");
}

let book: PaperBook | null = null;

export function emptyBook(): PaperBook {
  return {
    settings: { ...defaults },
    fills: [],
    lastTickAt: null,
    lastError: null,
    ticks: 0,
    filledLastTick: 0,
  };
}

export function loadPaperBook(): PaperBook {
  if (book) return book;
  const path = dataPath();
  try {
    if (existsSync(path)) {
      const raw = JSON.parse(readFileSync(path, "utf8")) as Partial<PaperBook>;
      book = {
        ...emptyBook(),
        ...raw,
        settings: { ...defaults, ...(raw.settings ?? {}) },
        fills: Array.isArray(raw.fills) ? raw.fills : [],
      };
      return book;
    }
  } catch (err) {
    console.error("[isobar] failed to load paper book", err);
  }
  book = emptyBook();
  // Honor env arm for headless 24/7 without opening the UI.
  if (process.env.ISOBAR_PAPER_ARMED === "true") {
    book.settings.armed = true;
  }
  return book;
}

export function savePaperBook(next: PaperBook) {
  book = next;
  const path = dataPath();
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(next, null, 2));
  } catch (err) {
    console.error("[isobar] failed to save paper book", err);
  }
}

export function realizedPnl(fills: PaperFill[]) {
  let closed = 0;
  let openCost = 0;
  for (const f of fills) {
    if (f.status === "open") openCost += f.cost;
    else closed += f.payout - f.cost;
  }
  return { closed, openCost };
}

export function patchSettings(patch: Partial<BotSettings>) {
  const cur = loadPaperBook();
  const next: PaperBook = {
    ...cur,
    settings: { ...cur.settings, ...patch },
  };
  savePaperBook(next);
  return next;
}

export function resetBook() {
  const cur = loadPaperBook();
  const next: PaperBook = {
    ...cur,
    fills: [],
    filledLastTick: 0,
    lastError: null,
  };
  savePaperBook(next);
  return next;
}

export function paperTrade(signal: Signal, bankroll: number, current: PaperBook = loadPaperBook()): PaperFill | null {
  const { settings, fills } = current;
  if (fills.some((f) => f.marketId === signal.marketId && f.side === signal.side && f.status === "open")) {
    return null;
  }
  if (signal.edge < settings.minEdge) return null;
  if (signal.marketP < settings.minPrice || signal.marketP > settings.maxPrice) return null;
  const f = signal.kelly * settings.kellyFraction;
  const cap = settings.maxPosPct;
  const stake = Math.max(5, Math.min(bankroll * Math.min(f, cap), bankroll * cap));
  const shares = stake / signal.marketP;
  return {
    id: `${signal.marketId}-${signal.side}-${Date.now()}`,
    eventId: signal.eventId,
    marketId: signal.marketId,
    cityName: signal.cityName,
    question: signal.question,
    side: signal.side,
    price: signal.marketP,
    shares,
    cost: stake,
    modelP: signal.modelP,
    placedAt: new Date().toISOString(),
    status: "open",
    payout: 0,
  };
}

export function settleFills(fills: PaperFill[], marketId: string, yesWon: boolean): PaperFill[] {
  return fills.map((f) => {
    if (f.marketId !== marketId || f.status !== "open") return f;
    const won = f.side === "YES" ? yesWon : !yesWon;
    return {
      ...f,
      status: won ? "won" : "lost",
      payout: won ? f.shares : 0,
    };
  });
}
