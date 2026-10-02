/**
 * Paper strategy parameters fitted by the WeatherNext backtest (see PAPER.md "Backtest-fitted
 * parameters" and model-params.ts). Everything here is paper-only and configurable via env.
 *
 *  - YES floor: minimum executable YES price (ask) for a modal-bucket YES.
 *  - Taker fee: Polymarket weather markets charge takers fee = C × feeRate × p × (1 − p)
 *    (docs.polymarket.com/trading/fees, feeRate 0.05 for Weather; Gamma market feeSchedule
 *    {rate: 0.05, exponent: 1, takerOnly: true}). Edges are net of it, per share.
 *  - Blend: tradeable probability p = w·model + (1 − w)·market_mid. w for D-1 and later is one
 *    number; on the city's live local day w follows piecewise-linear knots by local hour.
 *  - Station bias: shrunk (empirical-Bayes) per-station correction of the WeatherNext daily max
 *    (°C, forecast − settled); members are shifted by −correction before pricing.
 */
import { MODEL_PARAMS } from "./model-params";
import { localDateIn, localHourIn } from "./math";
import type { TempKind } from "./types";

export type BlendParams = {
  /** w for events after the city's current local date (D-1, D-2, …). */
  ahead: number;
  /** Live local day: [local hour, w] knots, linearly interpolated, flat outside. */
  sameDay: [number, number][];
};

export type StrategyParams = {
  minPriceYes: number;
  takerFeeRate: number;
  blend: BlendParams | null;
  /** cityId → correction (°C) subtracted from daily-max members. */
  stationBiasC: Record<string, number>;
  /** Apply the (daily-max) correction to daily-min members too. Off: the bias was fitted on highs only. */
  biasLows: boolean;
};

const clampN = (raw: string | undefined, fb: number, lo: number, hi: number) => {
  const n = raw == null || raw === "" ? NaN : Number(raw);
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : fb;
};
const off = (raw: string | undefined) => /^(1|true|yes|off)$/i.test(raw ?? "");

/** ISOBAR_BLEND_AHEAD (w for later dates) and ISOBAR_BLEND_SAMEDAY ("hour:w,hour:w") override model-params. */
function blendFromEnv(env: Record<string, string | undefined>): BlendParams {
  const base = MODEL_PARAMS.blend;
  const ahead = clampN(env.ISOBAR_BLEND_AHEAD, base.ahead, 0, 1);
  const knots = (env.ISOBAR_BLEND_SAMEDAY ?? "")
    .split(",")
    .map((s) => s.split(":").map((x) => Number(x.trim())))
    .filter(
      (k) =>
        k.length === 2 &&
        k.every(Number.isFinite) &&
        k[0] >= 0 &&
        k[0] <= 24 &&
        k[1] >= 0 &&
        k[1] <= 1,
    )
    .map((k) => [k[0], k[1]] as [number, number])
    .sort((a, b) => a[0] - b[0]);
  return { ahead, sameDay: knots.length ? knots : base.sameDay };
}

export function strategyFromEnv(
  env: Record<string, string | undefined> = process.env,
): StrategyParams {
  return {
    minPriceYes: clampN(env.ISOBAR_PAPER_MIN_PRICE_YES, MODEL_PARAMS.minPriceYes, 0.01, 0.5),
    takerFeeRate: clampN(env.ISOBAR_TAKER_FEE_RATE, MODEL_PARAMS.takerFeeRate, 0, 0.25),
    blend: off(env.ISOBAR_BLEND_DISABLED) ? null : blendFromEnv(env),
    stationBiasC: off(env.ISOBAR_STATION_BIAS_DISABLED) ? {} : MODEL_PARAMS.stationBiasC,
    biasLows: false,
  };
}

type G = { __isobarStrategy?: StrategyParams | null };
const g = () => globalThis as G;

export function strategy(): StrategyParams {
  const glob = g();
  if (!glob.__isobarStrategy) glob.__isobarStrategy = strategyFromEnv();
  return glob.__isobarStrategy;
}

/** Test / backtest hook: override some params (null resets to env + model-params defaults). */
export function _setStrategyParams(patch: Partial<StrategyParams> | null) {
  g().__isobarStrategy = patch == null ? null : { ...strategyFromEnv(), ...patch };
}

/** Params that reproduce the pre-backtest behaviour (3¢ YES floor, raw model, no fee, no bias). */
export const LEGACY_STRATEGY: StrategyParams = {
  minPriceYes: 0.03,
  takerFeeRate: 0,
  blend: null,
  stationBiasC: {},
  biasLows: false,
};

/** Taker fee per share (USDC) at price p. */
export function takerFee(p: number, rate = strategy().takerFeeRate) {
  if (!Number.isFinite(p) || p <= 0 || p >= 1) return 0;
  return rate * p * (1 - p);
}

/** Model weight in the model/market blend for an event date at `now` in the city's tz. */
export function blendWeight(
  eventDate: string,
  tz: string | undefined,
  now = new Date(),
  params = strategy().blend,
): number {
  if (!params) return 1;
  const today = localDateIn(tz, now);
  if (eventDate > today) return params.ahead;
  const knots = params.sameDay;
  if (!knots.length) return params.ahead;
  const h = localHourIn(tz, now);
  if (h <= knots[0][0]) return knots[0][1];
  for (let i = 1; i < knots.length; i++) {
    const [h1, w1] = knots[i];
    const [h0, w0] = knots[i - 1];
    if (h <= h1) return w0 + ((w1 - w0) * (h - h0)) / (h1 - h0);
  }
  return knots[knots.length - 1][1];
}

/** Blended probability; falls back to the model when the market mid is unusable. */
export function blendProb(model: number, marketMid: number | null | undefined, w: number) {
  if (marketMid == null || !Number.isFinite(marketMid) || marketMid < 0 || marketMid > 1)
    return model;
  return w * model + (1 - w) * marketMid;
}

/** Market mid of a YES bucket: (bid + ask) / 2 when both are quoted, else the Gamma price. */
export function marketMid(m: {
  yesPrice: number;
  bestBid?: number | null;
  bestAsk?: number | null;
}) {
  const b = m.bestBid;
  const a = m.bestAsk;
  if (
    b != null &&
    a != null &&
    Number.isFinite(b) &&
    Number.isFinite(a) &&
    b > 0 &&
    a > 0 &&
    a >= b
  )
    return (a + b) / 2;
  return m.yesPrice;
}

/** Station correction (°C) for a city and kind (0 when unknown). */
export function stationBias(cityId: string, kind: TempKind = "high", p = strategy()) {
  if (kind === "low" && !p.biasLows) return 0;
  const c = p.stationBiasC[cityId];
  return Number.isFinite(c) ? c : 0;
}

/** Members shifted by −bias (forecast − settled): a cold-biased station (bias < 0) is warmed. */
export function debiasMembers(members: number[], cityId: string, kind: TempKind = "high") {
  const b = stationBias(cityId, kind);
  return b === 0 ? members : members.map((m) => Math.round((m - b) * 100) / 100);
}

/**
 * Empirical-Bayes (James–Stein toward 0) shrink of per-station mean errors.
 * Each station i has n_i errors with mean b_i and sd s_i; prior θ_i ~ N(0, τ²) with
 * τ² = max(0, mean(b_i²) − mean(s_i²/n_i)); posterior mean k_i·b_i, k_i = τ² / (τ² + s_i²/n_i).
 * Stations with fewer than minN errors get 0. Corrections are clamped to ±maxAbs.
 */
export function shrinkBiases(errors: Record<string, number[]>, minN = 5, maxAbs = 2) {
  const stats = Object.entries(errors)
    .filter(([, e]) => e.length >= minN)
    .map(([id, e]) => {
      const n = e.length;
      const m = e.reduce((a, b) => a + b, 0) / n;
      const s2 = e.reduce((a, b) => a + (b - m) ** 2, 0) / Math.max(1, n - 1);
      return { id, n, m, se2: s2 / n, sd: Math.sqrt(s2) };
    });
  if (!stats.length)
    return {
      tau2: 0,
      cities: {} as Record<
        string,
        { n: number; meanC: number; sdC: number; k: number; correctionC: number }
      >,
    };
  const tau2 = Math.max(
    0,
    stats.reduce((a, s) => a + s.m * s.m, 0) / stats.length -
      stats.reduce((a, s) => a + s.se2, 0) / stats.length,
  );
  const cities: Record<
    string,
    { n: number; meanC: number; sdC: number; k: number; correctionC: number }
  > = {};
  for (const s of stats) {
    const k = tau2 > 0 ? tau2 / (tau2 + s.se2) : 0;
    const c = Math.max(-maxAbs, Math.min(maxAbs, k * s.m));
    cities[s.id] = { n: s.n, meanC: s.m, sdC: s.sd, k, correctionC: Math.round(c * 100) / 100 };
  }
  return { tau2, cities };
}

/** Limit-price ladder walk: buy up to `targetCost` USDC from asks priced ≤ `limit`. */
export type BookLevel = { price: number; size: number };
export function walkAsks(asks: BookLevel[], targetCost: number, limit: number) {
  const levels = asks
    .filter(
      (l) =>
        Number.isFinite(l.price) &&
        Number.isFinite(l.size) &&
        l.size > 0 &&
        l.price > 0 &&
        l.price < 1,
    )
    .sort((a, b) => a.price - b.price);
  let need = targetCost;
  let shares = 0;
  let cost = 0;
  let used = 0;
  for (const l of levels) {
    if (need <= 1e-9 || l.price > limit + 1e-9) break;
    const take = Math.min(l.size, need / l.price);
    shares += take;
    cost += take * l.price;
    need -= take * l.price;
    used++;
  }
  return {
    shares,
    cost,
    vwap: shares > 0 ? cost / shares : null,
    levels: used,
    partial: need > 1e-6,
  };
}

/**
 * Highest price at which buying still clears the edge floor net of the taker fee:
 * the largest x ≤ maxPrice with p − x − fee(x) ≥ minEdge (fee is increasing below 0.5).
 */
export function limitPrice(
  p: number,
  minEdge: number,
  maxPrice: number,
  rate = strategy().takerFeeRate,
) {
  let lo = 0;
  let hi = Math.min(maxPrice, 0.999);
  if (p - hi - takerFee(hi, rate) >= minEdge) return hi;
  if (p - lo - takerFee(lo, rate) < minEdge) return 0;
  for (let i = 0; i < 40; i++) {
    const mid = (lo + hi) / 2;
    if (p - mid - takerFee(mid, rate) >= minEdge) lo = mid;
    else hi = mid;
  }
  return Math.floor(lo * 1000) / 1000;
}
