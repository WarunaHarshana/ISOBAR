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
