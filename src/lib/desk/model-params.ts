/**
 * Backtest-fitted strategy defaults (WeatherNext 3 vs Polymarket, 2026-09-18 … 2026-10-01).
 * Regenerate with scripts/backtest (see scripts/backtest/README.md); every value is overridable by
 * env (strategy.ts). Paper only.
 *
 * Backtest: 580 closed Polymarket temperature events (556 highs, 24 lows, 48 cities), WeatherNext
 * 0.05° inits 00Z/12Z pulled with the bot's own buildFetchSql (30 jobs, 126.3 GiB billed), METAR
 * history (IEM), 5-min CLOB price history; decisions at D-1 18:00 and D 09:00/13:00/16:00 local
 * with the latest init published ≥ 7 h before and METARs ≥ 10 min old.
 *
 *  - minPriceYes 0.12: inside the approved 10–15¢ band the floor did not change the final strategy's
 *    trades (inconclusive) → the 12¢ default. Every YES under 20¢ in the sims was a D-1 longshot
 *    (24 fills, 3 won).
 *  - blend: the Brier/log-loss-optimal w was 0 at every horizon (market better everywhere:
 *    D-1 0.745 vs 0.633, D 09 0.667 vs 0.575, D 13 0.598 vs 0.457, D 16 0.225 vs 0.108, Brier).
 *    D-1+ and morning trades lost in every variant → w = 0 there (no trades). Live-day afternoon
 *    YES on the crowd favorite with the obs-conditioned model above it was the only profitable
 *    niche (PnL-chosen, ~25 trades): w rises 0 → 0.5 (13:00) → 0.75 (16:00+). NOTE: the opposite
 *    of a decreasing intraday w; PAPER.md explains. ISOBAR_BLEND_SAMEDAY / _AHEAD override.
 *  - stationBiasC: WeatherNext D-0 (latest pre-day init) daily-max mean − settled bucket mid, °C,
 *    per station, James–Stein-shrunk toward 0 (strategy.ts shrinkBiases; τ² = 0.573),
 *    highs only. Members are shifted by −correction. Overall mean error −0.46 °C, sd 1.02 °C.
 */
import type { BlendParams } from "./strategy";

export const MODEL_PARAMS: {
  minPriceYes: number;
  takerFeeRate: number;
  blend: BlendParams;
  stationBiasC: Record<string, number>;
} = {
  minPriceYes: 0.12,
  takerFeeRate: 0.05,
  blend: {
    ahead: 0,
    sameDay: [
      [10, 0],
      [13, 0.5],
      [16, 0.75],
    ],
  },
  stationBiasC: {
    amsterdam: 0.24,
    ankara: -0.51,
    atlanta: -0.57,
    austin: -1.57,
    beijing: -0.48,
    "buenos-aires": -0.41,
    busan: -0.53,
    "cape-town": -0.22,
    chengdu: -0.26,
    chicago: -0.41,
    chongqing: 0.96,
    dallas: -1.21,
    denver: -1.26,
    guangzhou: -1.03,
    helsinki: 0.08,
    "hong-kong": -1.03,
    houston: -0.64,
    istanbul: -0.66,
    jeddah: -0.09,
    karachi: -1.17,
    "kuala-lumpur": 0.02,
    london: -0.29,
    "los-angeles": -0.59,
    lucknow: 0.35,
    madrid: -0.83,
    manila: 0.06,
    miami: -0.27,
    milan: -0.3,
    moscow: 0.52,
    munich: -0.6,
    nyc: -0.35,
    "panama-city": -0.25,
    paris: -0.87,
    "san-francisco": -0.35,
    "sao-paulo": -1.16,
    seattle: -0.37,
    seoul: -0.85,
    shanghai: -0.54,
    shenzhen: 0.71,
    singapore: -0.75,
    taipei: -1.8,
    "tel-aviv": -0.34,
    tokyo: 0.02,
    toronto: 0.17,
    warsaw: 0.08,
    wellington: -1.11,
    wuhan: 0.87,
  },
};

/** Per-station fit behind stationBiasC (n days, raw mean and sd of forecast − settled, shrink k). */
export const STATION_BIAS_STATS: Record<
  string,
  { n: number; meanC: number; sdC: number; k: number; correctionC: number }
> = {
  amsterdam: { n: 11, meanC: 0.257, sdC: 0.638, k: 0.939, correctionC: 0.24 },
  ankara: { n: 12, meanC: -0.597, sdC: 1.095, k: 0.852, correctionC: -0.51 },
  atlanta: { n: 10, meanC: -0.679, sdC: 1.04, k: 0.841, correctionC: -0.57 },
  austin: { n: 10, meanC: -1.86, sdC: 1.038, k: 0.842, correctionC: -1.57 },
  beijing: { n: 12, meanC: -0.514, sdC: 0.698, k: 0.934, correctionC: -0.48 },
  "buenos-aires": { n: 11, meanC: -0.48, sdC: 1.019, k: 0.859, correctionC: -0.41 },
  busan: { n: 11, meanC: -0.551, sdC: 0.507, k: 0.961, correctionC: -0.53 },
  "cape-town": { n: 11, meanC: -0.245, sdC: 0.918, k: 0.882, correctionC: -0.22 },
  chengdu: { n: 12, meanC: -0.33, sdC: 1.392, k: 0.78, correctionC: -0.26 },
  chicago: { n: 12, meanC: -0.495, sdC: 1.152, k: 0.838, correctionC: -0.41 },
  chongqing: { n: 11, meanC: 1.103, sdC: 0.958, k: 0.873, correctionC: 0.96 },
  dallas: { n: 11, meanC: -1.286, sdC: 0.628, k: 0.941, correctionC: -1.21 },
  denver: { n: 11, meanC: -1.403, sdC: 0.85, k: 0.897, correctionC: -1.26 },
  guangzhou: { n: 12, meanC: -1.095, sdC: 0.656, k: 0.941, correctionC: -1.03 },
  helsinki: { n: 12, meanC: 0.082, sdC: 0.614, k: 0.948, correctionC: 0.08 },
  "hong-kong": { n: 12, meanC: -1.104, sdC: 0.694, k: 0.935, correctionC: -1.03 },
  houston: { n: 10, meanC: -0.687, sdC: 0.667, k: 0.928, correctionC: -0.64 },
  istanbul: { n: 12, meanC: -0.745, sdC: 0.963, k: 0.881, correctionC: -0.66 },
  jeddah: { n: 11, meanC: -0.093, sdC: 0.496, k: 0.962, correctionC: -0.09 },
  karachi: { n: 12, meanC: -1.354, sdC: 1.025, k: 0.868, correctionC: -1.17 },
  "kuala-lumpur": { n: 12, meanC: 0.017, sdC: 0.795, k: 0.916, correctionC: 0.02 },
  london: { n: 12, meanC: -0.332, sdC: 0.994, k: 0.874, correctionC: -0.29 },
  "los-angeles": { n: 12, meanC: -0.653, sdC: 0.839, k: 0.907, correctionC: -0.59 },
  lucknow: { n: 12, meanC: 0.387, sdC: 0.791, k: 0.917, correctionC: 0.35 },
  madrid: { n: 12, meanC: -0.921, sdC: 0.892, k: 0.896, correctionC: -0.83 },
  manila: { n: 12, meanC: 0.065, sdC: 0.702, k: 0.933, correctionC: 0.06 },
  miami: { n: 11, meanC: -0.304, sdC: 0.901, k: 0.886, correctionC: -0.27 },
  milan: { n: 12, meanC: -0.309, sdC: 0.472, k: 0.969, correctionC: -0.3 },
  moscow: { n: 10, meanC: 0.571, sdC: 0.745, k: 0.912, correctionC: 0.52 },
  munich: { n: 12, meanC: -0.626, sdC: 0.499, k: 0.965, correctionC: -0.6 },
  nyc: { n: 10, meanC: -0.394, sdC: 0.811, k: 0.897, correctionC: -0.35 },
  "panama-city": { n: 12, meanC: -0.287, sdC: 1.01, k: 0.871, correctionC: -0.25 },
  paris: { n: 12, meanC: -0.952, sdC: 0.818, k: 0.911, correctionC: -0.87 },
  qingdao: { n: 11, meanC: -0.002, sdC: 0.526, k: 0.958, correctionC: -0.0 },
  "san-francisco": { n: 10, meanC: -0.398, sdC: 0.882, k: 0.881, correctionC: -0.35 },
  "sao-paulo": { n: 11, meanC: -1.524, sdC: 1.399, k: 0.763, correctionC: -1.16 },
  seattle: { n: 12, meanC: -0.406, sdC: 0.792, k: 0.916, correctionC: -0.37 },
  seoul: { n: 12, meanC: -0.883, sdC: 0.477, k: 0.968, correctionC: -0.85 },
  shanghai: { n: 12, meanC: -0.586, sdC: 0.722, k: 0.93, correctionC: -0.54 },
  shenzhen: { n: 12, meanC: 0.743, sdC: 0.518, k: 0.962, correctionC: 0.71 },
  singapore: { n: 12, meanC: -0.835, sdC: 0.859, k: 0.903, correctionC: -0.75 },
  taipei: { n: 12, meanC: -1.882, sdC: 0.561, k: 0.956, correctionC: -1.8 },
  "tel-aviv": { n: 10, meanC: -0.352, sdC: 0.388, k: 0.974, correctionC: -0.34 },
  tokyo: { n: 12, meanC: 0.024, sdC: 0.88, k: 0.899, correctionC: 0.02 },
  toronto: { n: 12, meanC: 0.182, sdC: 0.569, k: 0.955, correctionC: 0.17 },
  warsaw: { n: 12, meanC: 0.088, sdC: 0.743, k: 0.926, correctionC: 0.08 },
  wellington: { n: 12, meanC: -1.229, sdC: 0.87, k: 0.901, correctionC: -1.11 },
  wuhan: { n: 11, meanC: 0.946, sdC: 0.754, k: 0.917, correctionC: 0.87 },
};
