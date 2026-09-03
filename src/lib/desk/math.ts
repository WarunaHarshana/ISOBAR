import { convertTemp } from "@/lib/utils";
import type { TempUnit } from "./types";

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

export function leadSigmaC(eventDate: string, now = new Date()) {
  const today = now.toISOString().slice(0, 10);
  if (eventDate <= today) return 0.55;
  const days = Math.max(0, (Date.parse(`${eventDate}T12:00:00Z`) - now.getTime()) / 86_400_000);
  return 0.7 + Math.min(days, 5) * 0.35;
}

export function adjustMembersForObserved(members: number[], observedC: number | null) {
  if (observedC == null) return members;
  return members.map((m) => Math.max(m, observedC));
}

export function bucketProbability(
  membersC: number[],
  lo: number,
  hi: number,
  unit: TempUnit,
  eventDate: string,
  observedC: number | null,
) {
  const adjusted = adjustMembersForObserved(membersC, observedC);
  if (!adjusted.length) return 0;
  const converted = adjusted.map((c) => convertTemp(c, unit));
  const bandwidth = Math.max(stdev(converted) * 0.45, unit === "F" ? 1.1 : 0.65, leadSigmaC(eventDate) * (unit === "F" ? 1.8 : 1));
  let mass = kdeMass(converted, lo, hi, bandwidth);
  if (observedC != null) {
    const obs = convertTemp(observedC, unit);
    if (Number.isFinite(hi) && hi <= obs + 1e-6) return 0;
    if (Number.isFinite(lo) && lo < obs) {
      const remaining = kdeMass(converted, obs, Infinity, bandwidth);
      const piece = kdeMass(converted, Math.max(lo, obs), hi, bandwidth);
      mass = remaining > 1e-9 ? piece / remaining : 0;
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
