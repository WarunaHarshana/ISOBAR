import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import type { BotSettings, PaperFill, Side, Signal } from "./types";
import { plausibilityVeto, type PlausibilityCtx } from "./plausibility";
import { kellyFraction } from "./math";

/** Latest YES-side quote of a market (Gamma), used to mark open tickets to market. */
export type MarketMark = {
  yesBid: number | null;
  yesAsk: number | null;
  yesMid: number | null;
  at: string;
};

export type PaperBook = {
  settings: BotSettings;
  fills: PaperFill[];
  lastTickAt: string | null;
  lastError: string | null;
  ticks: number;
  filledLastTick: number;
  /** marketId → latest quote, refreshed each tick for markets with open tickets. Fills are never edited for marks. */
  marks?: Record<string, MarketMark>;
};

export type PaperTradeOpts = {
  bestBid?: number | null;
  bestAsk?: number | null;
  fillPrice?: number | null;
  /** Predictioner ctx — optional ensemble / obs / clock. */
  members?: number[];
  observedC?: number | null;
  now?: Date;
  tz?: string;
  lo?: number;
  hi?: number;
};

/** Quant freeze — keep worker + UI floors identical. */
export const PAPER_MIN_EDGE = 0.06;
export const PAPER_MIN_PRICE = 0.05;
/** Member-supported (modal-bucket) YES may print cheaper than NO. */
export const PAPER_MIN_PRICE_YES = 0.03;
/** Skip NO when the crowd already has YES ≥ this (cheap shorts of 80%+ favorites). */
export const PAPER_NO_MAX_YES = 0.8;
/** YES only on the modal bucket and only when its modelP is at least this. */
export const PAPER_YES_MIN_MODELP = 0.2;
export const PAPER_MAX_PRICE = 0.85;
/**
 * Market-sanity guard: if the crowd prices one bucket of an event at ≥ this, the bot buys
 * no YES on any other bucket of that event unless its model gives the favorite
 * < PAPER_FAVORITE_GUARD_MODELP.
 */
export const PAPER_FAVORITE_GUARD = 0.85;
/**
 * Live-day deference: on the city's live local day, once the warming (cooling) window has
 * started, YES only on the market's favorite bucket. The crowd sees higher-frequency
 * observations than our 30–60 min METAR; the bot's live-day edge is sharpness on the same
 * favorite, not picking a different bucket.
 */
export const PAPER_LIVE_DAY_DEFER = true;
export const PAPER_FAVORITE_GUARD_MODELP = 0.5;
export const PAPER_KELLY = 0.12;
export const PAPER_MAX_POS = 0.08;
export const PAPER_MAX_FILLS_PER_TICK = 4;
export const PAPER_MAX_OPEN = 8;
export const PAPER_MAX_OPEN_PER_EVENT = 1;
/** One ticket per city-date (no YES+NO hedges or two YESes on one city). */
export const PAPER_MAX_OPEN_PER_CITY_DATE = 1;
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

const okPx = (x: number | null | undefined): x is number => x != null && Number.isFinite(x) && x > 0 && x < 1;

/**
 * Exit value per share of an open ticket at market: the best bid of the held side
 * (YES bid; NO bid = 1 − YES ask), else the mid. Null when the market has no quote.
 */
export function markPrice(side: Side, mark: MarketMark | null | undefined): number | null {
  if (!mark) return null;
  if (side === "YES") {
    if (okPx(mark.yesBid)) return mark.yesBid;
    return mark.yesMid != null && Number.isFinite(mark.yesMid) ? mark.yesMid : null;
  }
  if (okPx(mark.yesAsk)) return 1 - mark.yesAsk;
  return mark.yesMid != null && Number.isFinite(mark.yesMid) ? 1 - mark.yesMid : null;
}

/**
 * Mark-to-market PnL: open = shares × market exit price − cost (0 when there is no
 * quote yet: valued at cost, never at the model probability); settled = payout − cost.
 */
export function fillMarkPnl(fill: PaperFill, marks?: Record<string, MarketMark> | null): number {
  if (fill.status !== "open") return fill.payout - fill.cost;
  const px = markPrice(fill.side, marks?.[fill.marketId]);
  return px == null ? 0 : fill.shares * px - fill.cost;
}

export type CityLedgerRow = {
  cityId: string;
  cityName: string;
  open: number;
  won: number;
  lost: number;
  yes: number;
  no: number;
  cost: number;
  openCost: number;
  closedPnl: number;
  markPnl: number;
};

/** Per-city paper ledger, ranked by closed PnL first, then mark-to-market. */
export function cityLedger(fills: PaperFill[], marks?: Record<string, MarketMark> | null): CityLedgerRow[] {
  const byId = new Map<string, CityLedgerRow>();
  for (const f of fills) {
    const key = f.cityId || f.cityName || "unknown";
    let row = byId.get(key);
    if (!row) {
      row = {
        cityId: f.cityId || key,
        cityName: f.cityName || f.cityId || key,
        open: 0,
        won: 0,
        lost: 0,
        yes: 0,
        no: 0,
        cost: 0,
        openCost: 0,
        closedPnl: 0,
        markPnl: 0,
      };
      byId.set(key, row);
    }
    row.cost += f.cost;
    row.markPnl += fillMarkPnl(f, marks);
    if (f.side === "YES") row.yes += 1;
    else row.no += 1;
    if (f.status === "open") {
      row.open += 1;
      row.openCost += f.cost;
    } else {
      if (f.status === "won") row.won += 1;
      else row.lost += 1;
      row.closedPnl += f.payout - f.cost;
    }
  }
  return [...byId.values()].sort((a, b) => b.closedPnl - a.closedPnl || b.markPnl - a.markPnl);
}

export type FillTicket = {
  city: string;
  side: PaperFill["side"];
  date: string;
  question: string;
  status: PaperFill["status"];
  price: number;
  cost: number;
  /** Open: exit price per share at market (held side's bid, else mid); null = no quote. Settled: 1 / 0. */
  mark: number | null;
  markSource: "bid" | "mid" | "none" | "settled";
  pnl: number;
};

/** Compact per-fill tickets for /health (mark-to-market PnL). */
export function fillTickets(fills: PaperFill[], marks?: Record<string, MarketMark> | null): FillTicket[] {
  return fills.map((f) => {
    const m = marks?.[f.marketId];
    const settled = f.status !== "open";
    const mark = settled ? (f.status === "won" ? 1 : 0) : markPrice(f.side, m);
    const fromBid = !settled && m != null && (f.side === "YES" ? okPx(m.yesBid) : okPx(m.yesAsk));
    return {
      city: f.cityName,
      side: f.side,
      date: f.date,
      question: f.question,
      status: f.status,
      price: f.price,
      cost: f.cost,
      mark,
      markSource: settled ? "settled" : mark == null ? "none" : fromBid ? "bid" : "mid",
      pnl: fillMarkPnl(f, marks),
    };
  });
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
  // Edge must survive the actual fill price (a mid-priced signal can fill at a much worse ask).
  if (signal.modelP - price < PAPER_MIN_EDGE) return null;

  // Predictioner gate — after fill price, before Kelly. Fail closed.
  const plausCtx: PlausibilityCtx = {};
  if (typeof opts === "object" && opts != null) {
    if (opts.members != null) plausCtx.members = opts.members;
    if (opts.observedC !== undefined) plausCtx.observedC = opts.observedC;
    if (opts.now != null) plausCtx.now = opts.now;
    if (opts.tz != null) plausCtx.tz = opts.tz;
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
  // Kelly at the fill price (never larger than the signal's own Kelly).
  const kelly = price > signal.marketP + 1e-9 ? Math.min(signal.kelly, kellyFraction(signal.modelP, price)) : signal.kelly;
  const kellyFrac = kelly * PAPER_KELLY;
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
