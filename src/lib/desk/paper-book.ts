import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import type { BotSettings, PaperFill, Side, Signal } from "./types";
import { plausibilityVeto, type PlausibilityCtx } from "./plausibility.ts";

export type PaperBook = {
  settings: BotSettings;
  fills: PaperFill[];
  lastTickAt: string | null;
  lastError: string | null;
  ticks: number;
  filledLastTick: number;
};

export type PaperTradeOpts = {
  bestBid?: number | null;
  bestAsk?: number | null;
  fillPrice?: number | null;
  /** Predictioner ctx — optional ensemble / obs / clock. */
  members?: number[];
  observedC?: number | null;
  now?: Date;
  lo?: number;
  hi?: number;
};

/** Quant freeze — keep worker + UI floors identical. */
export const PAPER_MIN_EDGE = 0.06;
export const PAPER_MIN_PRICE = 0.05;
/** Member-supported YES (winning bucket) may print cheaper than NO. */
export const PAPER_MIN_PRICE_YES = 0.03;
export const PAPER_MAX_PRICE = 0.85;
export const PAPER_KELLY = 0.12;
export const PAPER_MAX_POS = 0.08;
export const PAPER_MAX_FILLS_PER_TICK = 4;
export const PAPER_MAX_OPEN = 12;
export const PAPER_MAX_OPEN_PER_EVENT = 2;
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

type PaperGlobals = {
  __isobarPaperBook?: PaperBook | null;
};

function g(): PaperGlobals {
  return globalThis as PaperGlobals;
}

function dataPath() {
  const dir = process.env.ISOBAR_DATA_DIR || "/data";
  return join(dir, "paper-book.json");
}

/**
 * Nitro can evaluate this module twice (plugin chunk vs serverFn chunk).
 * Always share one book via globalThis so Arm / worker /health stay in sync.
 */
function getCachedBook(): PaperBook | null {
  return g().__isobarPaperBook ?? null;
}

function setCachedBook(next: PaperBook | null) {
  g().__isobarPaperBook = next;
}

/** Test helper — clear the in-memory cache between cases. */
export function _resetPaperBookCache() {
  setCachedBook(null);
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
  ];
  for (const name of keyLike) {
    if (process.env[name] && String(process.env[name]).trim()) {
      return `${name} is set — refusing paper arm`;
    }
  }
  return null;
}

function readBookFromDisk(): PaperBook | null {
  const path = dataPath();
  try {
    if (!existsSync(path)) return null;
    const raw = JSON.parse(readFileSync(path, "utf8")) as Partial<PaperBook>;
    const book: PaperBook = {
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
  } catch (err) {
    console.error("[isobar] failed to load paper book", err);
    return null;
  }
}

export function loadPaperBook(opts?: { refresh?: boolean }): PaperBook {
  if (!opts?.refresh) {
    const cached = getCachedBook();
    if (cached) return cached;
  }

  const fromDisk = readBookFromDisk();
  if (fromDisk) {
    setCachedBook(fromDisk);
    return fromDisk;
  }

  const book = emptyBook();
  if (process.env.ISOBAR_PAPER_ARMED === "true" && !liveTradingLocked()) {
    book.settings.armed = true;
  }
  setCachedBook(book);
  return book;
}

export function savePaperBook(next: PaperBook) {
  const path = dataPath();
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(next, null, 2));
  } catch (err) {
    console.error("[isobar] failed to save paper book", err);
  }
  setCachedBook(next);
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

/** Mark-to-model PnL: closed uses payout; open uses shares × modelP − cost. */
export function fillMarkPnl(fill: PaperFill): number {
  if (fill.status === "open") return fill.shares * fill.modelP - fill.cost;
  return fill.payout - fill.cost;
}

export type CityLedgerRow = {
  cityId: string;
  cityName: string;
  open: number;
  won: number;
  lost: number;
  cost: number;
  openCost: number;
  closedPnl: number;
  markPnl: number;
};

/** Rank cities by mark-to-model PnL (closed + open expectation). */
export function cityLedger(fills: PaperFill[]): CityLedgerRow[] {
  const byId = new Map<string, CityLedgerRow>();
  for (const f of fills) {
    const key = f.cityId || f.cityName || "unknown";
    let row = byId.get(key);
    if (!row) {
      row = {
        cityId: f.cityId,
        cityName: f.cityName || f.cityId,
        open: 0,
        won: 0,
        lost: 0,
        cost: 0,
        openCost: 0,
        closedPnl: 0,
        markPnl: 0,
      };
      byId.set(key, row);
    }
    row.cost += f.cost;
    row.markPnl += fillMarkPnl(f);
    if (f.status === "open") {
      row.open += 1;
      row.openCost += f.cost;
    } else if (f.status === "won") {
      row.won += 1;
      row.closedPnl += f.payout - f.cost;
    } else {
      row.lost += 1;
      row.closedPnl += f.payout - f.cost;
    }
  }
  return [...byId.values()].sort((a, b) => b.markPnl - a.markPnl || b.closedPnl - a.closedPnl);
}

/** Cash available for new risk: bankroll + closed PnL − open cost. */
export function availableCash(current: PaperBook = loadPaperBook()) {
  const { closed, openCost } = realizedPnl(current.fills);
  return current.settings.bankroll + closed - openCost;
}

export function patchSettings(patch: Partial<BotSettings>) {
  const cur = loadPaperBook({ refresh: true });
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
  const cur = loadPaperBook({ refresh: true });
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
 * Worse (higher) fill price for paper buys.
 * YES uses ask; NO uses max(mid, 1 - yesBid) as the implied NO ask.
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
  // NO: implied NO ask is 1 - yesBid (bestBid is the YES bid).
  if (bestBid != null && Number.isFinite(bestBid) && bestBid > 0) {
    return Math.max(mid, 1 - bestBid);
  }
  return mid;
}

export function paperTrade(
  signal: Signal,
  current: PaperBook = loadPaperBook(),
  opts?: PaperTradeOpts | number | null,
): PaperFill | null {
  const { fills } = current;
  if (liveTradingLocked()) return null;

  const open = fills.filter((f) => f.status === "open");
  if (open.length >= PAPER_MAX_OPEN) return null;
  if (open.some((f) => f.marketId === signal.marketId && f.side === signal.side)) return null;
  if (open.filter((f) => f.eventId === signal.eventId).length >= PAPER_MAX_OPEN_PER_EVENT) return null;
  if (
    open.filter((f) => f.cityId === signal.cityId && f.date === signal.date).length >=
    PAPER_MAX_OPEN_PER_CITY_DATE
  ) {
    return null;
  }

  if (signal.edge < PAPER_MIN_EDGE) return null;

  let price: number;
  if (typeof opts === "number" || opts == null) {
    // Legacy: third arg was YES ask.
    price = conservativeFillPrice(signal.side, signal.marketP, null, opts ?? null);
  } else if (opts.fillPrice != null && Number.isFinite(opts.fillPrice) && opts.fillPrice > 0) {
    price = opts.fillPrice;
  } else {
    price = conservativeFillPrice(signal.side, signal.marketP, opts.bestBid, opts.bestAsk);
  }

  const minPx = signal.side === "YES" ? PAPER_MIN_PRICE_YES : PAPER_MIN_PRICE;
  if (price < minPx || price > PAPER_MAX_PRICE) return null;

  // Predictioner gate — after fill price, before Kelly. Fail closed.
  const plausCtx: PlausibilityCtx = {};
  if (typeof opts === "object" && opts != null) {
    if (opts.members != null) plausCtx.members = opts.members;
    if (opts.observedC !== undefined) plausCtx.observedC = opts.observedC;
    if (opts.now != null) plausCtx.now = opts.now;
    if (opts.lo != null) plausCtx.lo = opts.lo;
    if (opts.hi != null) plausCtx.hi = opts.hi;
  }
  try {
    const veto = plausibilityVeto(signal, plausCtx);
    if (!veto.ok) return null;
  } catch {
    return null;
  }

  const cash = availableCash(current);
  if (cash <= 0) return null;
  const kellyFrac = signal.kelly * PAPER_KELLY;
  const stake = Math.min(cash * Math.min(kellyFrac, PAPER_MAX_POS), cash * PAPER_MAX_POS);
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
