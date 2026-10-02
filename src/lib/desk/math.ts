import { convertTemp } from "@/lib/utils";
import type { TempKind, TempUnit } from "./types";

/** Abramowitz & Stegun erf approximation. */
export function erf(x: number) {
  const sign = x < 0 ? -1 : 1;
  const ax = Math.abs(x);
  const t = 1 / (1 + 0.3275911 * ax);
  const y =
    1 -
    (((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) *
      t +
      0.254829592) *
      t *
      Math.exp(-ax * ax));
  return sign * y;
}

export function normCdf(z: number) {
  if (!Number.isFinite(z)) return z > 0 ? 1 : 0;
  return 0.5 * (1 + erf(z / Math.SQRT2));
}

export function mean(xs: number[]) {
  if (!xs.length) return 0;
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

export function stdev(xs: number[]) {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  const v = xs.reduce((a, x) => a + (x - m) ** 2, 0) / (xs.length - 1);
  return Math.sqrt(v);
}

/**
 * Ensemble KDE: each member contributes a Gaussian of width `bandwidth`.
 * Bounds are half-open [lo, hi). Infinite bounds allowed.
 */
export function kdeMass(members: number[], lo: number, hi: number, bandwidth: number) {
  if (!members.length) return 0;
  const h = Math.max(bandwidth, 1e-6);
  let acc = 0;
  for (const m of members) {
    const upper = hi === Infinity ? 1 : normCdf((hi - m) / h);
    const lower = lo === -Infinity ? 0 : normCdf((lo - m) / h);
    acc += Math.max(0, upper - lower);
  }
  return acc / members.length;
}

/** Calendar date (YYYY-MM-DD) in tz. */
export function localDateIn(tz: string | undefined, now = new Date()) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: tz || "UTC" }).format(now);
}

/**
 * Extra forecast-error width (°C) by lead time, measured in the CITY's local
 * calendar (events are local dates; the old UTC date was off by a day for
 * much of the day in Asia/Pacific and the Americas).
 */
export function leadSigmaC(eventDate: string, now = new Date(), tz?: string) {
  const today = localDateIn(tz, now);
  if (eventDate <= today) return 0.55;
  const days = Math.round((Date.parse(`${eventDate}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / 86_400_000);
  return 0.7 + Math.min(Math.max(days, 0), 5) * 0.35;
}

/** KDE bandwidth used by bucketProbability (same formula, no observed widening). */
export function kdeBandwidth(membersConverted: number[], unit: TempUnit, eventDate: string, tz?: string, now = new Date()) {
  return Math.max(
    stdev(membersConverted) * 0.45,
    unit === "F" ? 1.1 : 0.65,
    leadSigmaC(eventDate, now, tz) * (unit === "F" ? 1.8 : 1),
  );
}

/**
 * Near-certainty gate support test: true if any raw member (°C, converted to
 * the event unit) lies within one KDE bandwidth of [lo, hi). KDE tail mass is
 * not support. Empty members → no support.
 */
export function membersNearBucket(
  membersC: number[],
  lo: number,
  hi: number,
  unit: TempUnit,
  eventDate: string,
  tz?: string,
  now = new Date(),
) {
  if (!membersC.length) return false;
  const converted = membersC.map((c) => convertTemp(c, unit));
  const h = kdeBandwidth(converted, unit, eventDate, tz, now);
  const nearLo = Number.isFinite(lo) ? lo - h : -Infinity;
  const nearHi = Number.isFinite(hi) ? hi + h : Infinity;
  return converted.some((m) => m >= nearLo && m <= nearHi);
}

/** Representative temperature of a bucket (open ends: 0.5° inside the finite edge). */
export function bucketMid(lo: number, hi: number) {
  if (Number.isFinite(lo) && Number.isFinite(hi)) return (lo + hi) / 2;
  if (Number.isFinite(lo)) return lo + 0.5;
  if (Number.isFinite(hi)) return hi - 0.5;
  return 0;
}

/** NO needs the bucket this far (event unit) from the model mean and the observation. */
export function noGapMin(unit: TempUnit) {
  return unit === "F" ? 9 : 5;
}

/** Live day: YES bucket may sit at most this far past the observed extreme (event unit). */
export function yesLeadMax(unit: TempUnit) {
  return unit === "F" ? 4.5 : 2.5;
}

/** Half-open [lo, hi), same as the settlement-rounded bucket bounds. */
export function valueInBucket(v: number, lo: number, hi: number) {
  if (!Number.isFinite(v)) return false;
  const aboveLo = !Number.isFinite(lo) || v >= lo - 1e-6;
  const belowHi = !Number.isFinite(hi) || v < hi;
  return aboveLo && belowHi;
}

/**
 * Condition members on the observed extreme so far today: the final daily max
 * is ≥ the observed max (high), the final daily min is ≤ the observed min (low).
 */
export function adjustMembersForObserved(members: number[], observedC: number | null, kind: TempKind = "high") {
  if (observedC == null) return members;
  return kind === "low" ? members.map((m) => Math.min(m, observedC)) : members.map((m) => Math.max(m, observedC));
}

export function bucketProbability(
  membersC: number[],
  lo: number,
  hi: number,
  unit: TempUnit,
  eventDate: string,
  observedC: number | null,
  tz?: string,
  now = new Date(),
  kind: TempKind = "high",
) {
  const adjusted = adjustMembersForObserved(membersC, observedC, kind);
  if (!adjusted.length) return 0;
  const converted = adjusted.map((c) => convertTemp(c, unit));
  const bandwidth = kdeBandwidth(converted, unit, eventDate, tz, now);
  let mass = kdeMass(converted, lo, hi, bandwidth);
  if (observedC != null) {
    const obs = convertTemp(observedC, unit);
    if (kind === "low") {
      // Final min ≤ obs: buckets wholly above it are dead; renormalize on (-∞, obs].
      if (Number.isFinite(lo) && lo > obs + 1e-6) return 0;
      if (!Number.isFinite(hi) || hi > obs) {
        const remaining = kdeMass(converted, -Infinity, obs, bandwidth);
        const piece = kdeMass(converted, lo, Math.min(hi, obs), bandwidth);
        mass = remaining > 1e-9 ? piece / remaining : 0;
      }
    } else {
      if (Number.isFinite(hi) && hi <= obs + 1e-6) return 0;
      if (Number.isFinite(lo) && lo < obs) {
        const remaining = kdeMass(converted, obs, Infinity, bandwidth);
        const piece = kdeMass(converted, Math.max(lo, obs), hi, bandwidth);
        mass = remaining > 1e-9 ? piece / remaining : 0;
      }
    }
  }
  return clamp01(mass);
}

export function kellyFraction(p: number, price: number) {
  if (price <= 0.01 || price >= 0.99) return 0;
  const edge = p - price;
  if (edge <= 0) return 0;
  return clamp01(edge / (1 - price));
}

export function clamp01(n: number) {
  if (!Number.isFinite(n)) return 0;
  return Math.min(1, Math.max(0, n));
}

export function impliedTemp(buckets: { lo: number; hi: number; yesPrice: number }[]) {
  let num = 0;
  let den = 0;
  for (const b of buckets) {
    const mid =
      !Number.isFinite(b.lo) && Number.isFinite(b.hi)
        ? b.hi - 0.5
        : Number.isFinite(b.lo) && !Number.isFinite(b.hi)
          ? b.lo + 0.5
          : (b.lo + b.hi) / 2;
    const w = Math.max(0, b.yesPrice);
    num += w * mid;
    den += w;
  }
  if (den < 0.2) return null;
  return num / den;
}

// ---------------------------------------------------------------------------
// Live-day (intraday) conditioning
// ---------------------------------------------------------------------------

/** Local hour (fractional, 0–24) in tz. */
export function localHourIn(tz: string | undefined, now = new Date()) {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", { timeZone: tz || "UTC", hour: "2-digit", minute: "2-digit", hourCycle: "h23" })
      .formatToParts(now)
      .map((x) => [x.type, x.value]),
  );
  return (Number(p.hour) % 24) + Number(p.minute) / 60;
}

/**
 * Daily-high warming window: by HIGH_PEAK_END_H local the day's max is normally in
 * (mid-afternoon peak); the ensemble's full daily-max spread applies before
 * HIGH_WINDOW_START_H and shrinks linearly to the remaining-hours forecast at the end.
 * With today's hourly forecast the window ends two hours after its forecast peak
 * (clamped to 13–18 h; lows: one hour after the forecast trough before noon, 4–10 h).
 */
export const HIGH_WINDOW_START_H = 6;
export const HIGH_PEAK_END_H = 17;
/** Daily-low cooling window: the min is normally set by LOW_TROUGH_END_H local (pre-dawn/dawn). */
export const LOW_TROUGH_END_H = 8;
/** Floor on the remaining-hours error σ (°C): METAR rounding + residual forecast error. */
export const INTRADAY_MIN_SIGMA_C = 0.5;
/** Clamp on the bias between the latest METAR and the hourly forecast for that hour (°C). */
export const INTRADAY_MAX_BIAS_C = 4;

export type IntradayInput = {
  kind: TempKind;
  /** Observed extreme so far today at the settlement station (°C): max for high, min for low. */
  observedC: number;
  /** Latest METAR temperature (°C) and its time, for the forecast-bias correction. */
  latestObsC?: number | null;
  latestObsAt?: string | number | null;
  /** Hourly forecast, local wall-clock "YYYY-MM-DDTHH:MM" (Open-Meteo forecast or WeatherNext p50). */
  hourly?: { time: string; tempC: number }[];
  localDate: string;
  tz?: string;
  now?: Date;
};

export type IntradayModel = {
  kind: TempKind;
  observedC: number;
  /** Remaining-extreme samples (°C), one per member, before the max/min with observedC. */
  samplesC: number[];
  /** Gaussian σ (°C) around each sample. */
  sigmaC: number;
  /** Fraction of the warming (high) / cooling (low) window still ahead, 0–1. */
  remainingFrac: number;
  localHour: number;
  /** Bias-corrected max (high) / min (low) of the remaining hours of the hourly forecast; null if none. */
  remainingFcC: number | null;
  biasC: number;
  centerC: number;
};

function hourOfLocal(time: string) {
  const h = Number(time.slice(11, 13));
  return Number.isFinite(h) ? h : NaN;
}

/**
 * Condition the daily extreme on the time of day:
 *   final = max(observedMax, X)   (high)    final = min(observedMin, X)   (low)
 *   X_i ~ N(c + (m_i − mean)·√f, σ),  c = f·mean + (1 − f)·target,  σ = max(0.5 °C, bw·√f)
 * where f is the fraction of the warming/cooling window still ahead, m_i are the
 * ensemble daily extremes and target is the bias-corrected max/min of the remaining
 * hours of the hourly forecast (or the observed extreme when no hourly forecast).
 * Early in the day (f = 1) this is the ensemble as-is; after the peak (f = 0) the
 * distribution collapses on the observed extreme with only the upside that the rest
 * of the day's forecast supports.
 */
export function intradayModel(membersC: number[], input: IntradayInput, bandwidthC: number): IntradayModel {
  const now = input.now ?? new Date();
  const H = localHourIn(input.tz, now);
  const high = input.kind !== "low";
  const today = (input.hourly ?? []).filter((p) => p.time.slice(0, 10) === input.localDate && Number.isFinite(p.tempC));
  // End of the warming (cooling) window: two hours after the hourly forecast's own peak (one after the trough)
  // when today's hourly forecast is available, else the climatological default.
  let windowEnd = high ? HIGH_PEAK_END_H : LOW_TROUGH_END_H;
  if (today.length >= 12) {
    const pool = high ? today : today.filter((p) => hourOfLocal(p.time) <= 12);
    if (pool.length) {
      const ext = pool.reduce((a, b) => (high ? (b.tempC > a.tempC ? b : a) : b.tempC < a.tempC ? b : a));
      const h = hourOfLocal(ext.time) + (high ? 2 : 1);
      if (Number.isFinite(h)) windowEnd = high ? Math.min(18, Math.max(13, h)) : Math.min(10, Math.max(4, h));
    }
  }
  const f = high
    ? clamp01((windowEnd - H) / (windowEnd - HIGH_WINDOW_START_H))
    : clamp01((windowEnd - H) / windowEnd);
  // Forecast bias, from (a) the latest METAR vs the forecast for that local hour (report ≤ 3 h old)
  // and (b) the observed extreme so far vs the forecast extreme over the same elapsed hours.
  // The mean of the available estimates, clamped.
  const biases: number[] = [];
  if (input.latestObsC != null && Number.isFinite(input.latestObsC) && input.latestObsAt != null) {
    const at = typeof input.latestObsAt === "number" ? input.latestObsAt : Date.parse(input.latestObsAt);
    if (Number.isFinite(at) && now.getTime() - at <= 3 * 3600_000 && at <= now.getTime() + 60_000) {
      const obsDate = localDateIn(input.tz, new Date(at));
      const obsHour = Math.floor(localHourIn(input.tz, new Date(at)) + 0.5) % 24;
      const fc = today.find((p) => obsDate === input.localDate && hourOfLocal(p.time) === obsHour);
      if (fc) biases.push(input.latestObsC - fc.tempC);
    }
  }
  const elapsed = today.filter((p) => hourOfLocal(p.time) <= H).map((p) => p.tempC);
  if (elapsed.length) biases.push(input.observedC - (high ? Math.max(...elapsed) : Math.min(...elapsed)));
  const bias = biases.length
    ? Math.max(-INTRADAY_MAX_BIAS_C, Math.min(INTRADAY_MAX_BIAS_C, mean(biases)))
    : 0;
  // Hours still ahead (the current, partly elapsed hour is covered by the observation).
  const remaining = today.filter((p) => hourOfLocal(p.time) >= Math.ceil(H - 1e-9)).map((p) => p.tempC + bias);
  const remainingFcC = remaining.length ? (high ? Math.max(...remaining) : Math.min(...remaining)) : null;
  const mu = membersC.length ? mean(membersC) : input.observedC;
  const target = remainingFcC ?? input.observedC;
  const centerC = f * mu + (1 - f) * target;
  const shrink = Math.sqrt(f);
  const samplesC = membersC.map((m) => centerC + (m - mu) * shrink);
  const sigmaC = Math.max(INTRADAY_MIN_SIGMA_C, bandwidthC * shrink);
  return { kind: input.kind, observedC: input.observedC, samplesC, sigmaC, remainingFrac: f, localHour: H, remainingFcC, biasC: bias, centerC };
}

/**
 * P(final ∈ [lo, hi)) under an intraday model, in the event unit, as a mixture weighted by f
 * (the fraction of the warming/cooling window still ahead):
 *  - weight 1 − f, "remaining hours" view: final = max(obs, X) (min for lows). The chance that
 *    X stays on the settled side of the observation lands in the observation's bucket.
 *  - weight f, "conditioning" view: X | X ≥ obs (≤ for lows). Early in the day a member that is
 *    already below the observation was simply too cold, so it is renormalized away rather than
 *    piled onto the observed bucket.
 * At f = 1 this equals the pre-intraday floor/renormalization; at f = 0 it is the pure
 * remaining-hours model.
 */
export function intradayBucketProbability(model: IntradayModel, lo: number, hi: number, unit: TempUnit) {
  if (!model.samplesC.length) return 0;
  const k = unit === "F" ? 1.8 : 1;
  const obs = convertTemp(model.observedC, unit);
  const s = Math.max(model.sigmaC * k, 1e-6);
  const obsIn = valueInBucket(obs, lo, hi);
  const low = model.kind === "low";
  const cdf = (x: number, c: number) => (x === Infinity ? 1 : x === -Infinity ? 0 : normCdf((x - c) / s));
  let maxAcc = 0;
  let piece = 0;
  let open = 0;
  for (const sc of model.samplesC) {
    const c = convertTemp(sc, unit);
    if (low) {
      const top = Math.min(hi, obs);
      const inside = top > lo ? Math.max(0, cdf(top, c) - cdf(lo, c)) : 0;
      maxAcc += inside + (obsIn ? 1 - cdf(obs, c) : 0);
      piece += inside;
      open += cdf(obs, c);
    } else {
      const bottom = Math.max(lo, obs);
      const inside = hi > bottom ? Math.max(0, cdf(hi, c) - cdf(bottom, c)) : 0;
      maxAcc += inside + (obsIn ? cdf(obs, c) : 0);
      piece += inside;
      open += 1 - cdf(obs, c);
    }
  }
  const n = model.samplesC.length;
  const pMax = maxAcc / n;
  // All samples far on the settled side: conditioning has nothing left, so the observation stands.
  const pCond = open > 1e-9 ? piece / open : obsIn ? 1 : 0;
  const f = model.remainingFrac;
  return clamp01(f * pCond + (1 - f) * pMax);
}

/** Point estimates of the final extreme per member (°C): max/min(obs, sample). For the member-support test. */
export function intradayFinalMembers(model: IntradayModel) {
  return model.samplesC.map((x) => (model.kind === "low" ? Math.min(model.observedC, x) : Math.max(model.observedC, x)));
}

/** Median of a list (NaN when empty). */
export function median(xs: number[]) {
  if (!xs.length) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}
