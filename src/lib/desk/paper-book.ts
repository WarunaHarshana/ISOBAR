import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import type { BotSettings, PaperFill, Side, Signal } from "./types";

export type PaperBook = {
  settings: BotSettings;
  fills: PaperFill[];
  lastTickAt: string | null;
  lastError: string | null;
  ticks: number;
  filledLastTick: number;
};

/** Quant freeze — keep worker + UI floors identical. */
export const PAPER_MIN_EDGE = 0.06;
export const PAPER_MIN_PRICE = 0.05;
export const PAPER_MAX_PRICE = 0.85;
export const PAPER_KELLY = 0.12;
export const PAPER_MAX_POS = 0.08;
export const PAPER_MAX_FILLS_PER_TICK = 4;
export const PAPER_MAX_OPEN = 8;
export const PAPER_MAX_OPEN_PER_EVENT = 1;
export const PAPER_MAX_OPEN_PER_CITY_DATE = 2;
export const PAPER_MIN_STAKE = 5;
export const PAPER_LOG_LIMIT = 80;

const defaults: BotSettings = {
  bankroll: 10_000,
  kellyFraction: PAPER_KELLY,
  minEdge: PAPER_MIN_EDGE,
  minPrice: PAPER_MIN_PRICE,
  maxPrice: PAPER_MAX_PRICE,
  maxPosPct: PAPER_MAX_POS,
  armed: false,
};

function dataPath() {
  // Railway volume mount; override locally with ISOBAR_DATA_DIR=/tmp/isobar
  const dir = process.env.ISOBAR_DATA_DIR || "/data";
  return join(dir, "paper-book.json");
}

let book: PaperBook | null = null;

/** Reset in-memory cache (tests). */
export function _resetPaperBookCache() {
  book = null;
}

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

/** Refuse to arm if anything looks like a live-trading unlock. */
export function liveTradingLocked(): string | null {
  if (process.env.ISOBAR_LIVE === "true" || process.env.ISOBAR_LIVE === "1") {
    return "ISOBAR_LIVE is set — refusing paper arm";
  }
  const keyLike = [
    "POLYMARKET_PRIVATE_KEY",
    "PK",
    "PRIVATE_KEY",
    "CLOB_API_KEY",
    "CLOB_SECRET",
    "CLOB_PASS_PHRASE",
    "WALLET_PRIVATE_KEY",
  ];
  for (const name of keyLike) {
    if (process.env[name] && String(process.env[name]).trim()) {
      return `${name} is set — refusing paper arm`;
    }
  }
  return null;
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
      book.settings.minEdge = PAPER_MIN_EDGE;
      book.settings.minPrice = PAPER_MIN_PRICE;
      book.settings.maxPrice = PAPER_MAX_PRICE;
      book.settings.kellyFraction = PAPER_KELLY;
      book.settings.maxPosPct = PAPER_MAX_POS;
      if (liveTradingLocked()) book.settings.armed = false;
      return book;
    }
  } catch (err) {
    console.error("[isobar] failed to load paper book", err);
  }
  book = emptyBook();
  if (process.env.ISOBAR_PAPER_ARMED === "true" && !liveTradingLocked()) {
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

/** Cash available for new risk: bankroll + closed PnL − open cost. */
export function availableCash(current: PaperBook = loadPaperBook()) {
  const { closed, openCost } = realizedPnl(current.fills);
  return current.settings.bankroll + closed - openCost;
}

export function patchSettings(patch: Partial<BotSettings>) {
  const cur = loadPaperBook();
  const lock = liveTradingLocked();
  if (patch.armed === true && lock) {
    const next: PaperBook = {
      ...cur,
      settings: { ...cur.settings, ...patch, armed: false },
      lastError: lock,
    };
    savePaperBook(next);
    return next;
  }
  const next: PaperBook = {
    ...cur,
    settings: {
      ...cur.settings,
      ...patch,
      minEdge: PAPER_MIN_EDGE,
      minPrice: PAPER_MIN_PRICE,
      maxPrice: PAPER_MAX_PRICE,
      kellyFraction: PAPER_KELLY,
      maxPosPct: PAPER_MAX_POS,
    },
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

/** Keep every open fill, then newest closed rows up to PAPER_LOG_LIMIT. */
export function truncateFills(fills: PaperFill[]): PaperFill[] {
  const open = fills.filter((f) => f.status === "open");
  const closed = fills.filter((f) => f.status !== "open");
  const room = Math.max(0, PAPER_LOG_LIMIT - open.length);
  return [...open, ...closed.slice(0, room)];
}

/**
 * Worse of mid vs ask for a buy.
 * YES ask = bestAsk; NO ask ≈ 1 − yesBestBid.
 */
export function conservativeFillPrice(
  side: Side,
  mid: number,
  bestBid: number | null | undefined,
  bestAsk: number | null | undefined,
): number {
  if (side === "YES") {
    if (bestAsk != null && Number.isFinite(bestAsk) && bestAsk > 0) {
      return Math.max(mid, bestAsk);
    }
    return mid;
  }
  if (bestBid != null && Number.isFinite(bestBid)) {
    const noAsk = 1 - bestBid;
    if (noAsk > 0 && noAsk < 1) return Math.max(mid, noAsk);
  }
  return mid;
}

function cityDateKey(cityId: string, date: string) {
  return `${cityId}|${date}`;
}

export function paperTrade(
  signal: Signal,
  current: PaperBook = loadPaperBook(),
  opts: { fillPrice?: number; bestBid?: number | null; bestAsk?: number | null } = {},
): PaperFill | null {
  const { fills } = current;
  if (liveTradingLocked()) return null;

  const open = fills.filter((f) => f.status === "open");
  if (open.length >= PAPER_MAX_OPEN) return null;
  // No second open on same market (either side), and no YES+NO pair.
  if (open.some((f) => f.marketId === signal.marketId)) return null;
  if (open.filter((f) => f.eventId === signal.eventId).length >= PAPER_MAX_OPEN_PER_EVENT) return null;
  const cd = cityDateKey(signal.cityId, signal.date);
  if (
    open.filter((f) => cityDateKey(f.cityId || "", f.date || "") === cd).length >=
    PAPER_MAX_OPEN_PER_CITY_DATE
  ) {
    return null;
  }

  if (signal.edge < PAPER_MIN_EDGE) return null;
  const price =
    opts.fillPrice ??
    conservativeFillPrice(signal.side, signal.marketP, opts.bestBid, opts.bestAsk);
  if (price < PAPER_MIN_PRICE || price > PAPER_MAX_PRICE) return null;

  const cash = availableCash(current);
  if (cash <= 0) return null;
  const kellyFrac = signal.kelly * PAPER_KELLY;
  const stake = cash * Math.min(kellyFrac, PAPER_MAX_POS);
  // Quant: if stake < $5, SKIP — do not round up.
  if (!(stake >= PAPER_MIN_STAKE)) return null;
  const shares = stake / price;
  return {
    id: `${signal.marketId}-${signal.side}-${Date.now()}`,
    eventId: signal.eventId,
    marketId: signal.marketId,
    cityId: signal.cityId,
    cityName: signal.cityName,
    date: signal.date,
    question: signal.question,
    side: signal.side,
    price,
    shares,
    cost: stake,
    modelP: signal.modelP,
    placedAt: new Date().toISOString(),
    status: "open",
    payout: 0,
  };
}

/**
 * Apply Gamma closed+winner settlement for one market.
 * Never call from 98¢ prints — only when Gamma reports closed + winner.
 */
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
