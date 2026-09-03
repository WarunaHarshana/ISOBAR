import type { Signal, TempUnit } from "./types";

/** Predictioner v1 — paper-only plausibility gate (fail closed upstream). */
export type PlausibilityCtx = {
  members?: number[];
  observedC?: number | null;
  now?: Date;
  /** Optional bucket bounds in signal.unit (inclusive lo, exclusive hi when finite). */
  lo?: number;
  hi?: number;
};

export type PlausibilityResult = { ok: true } | { ok: false; reason: string };

const MIN_MEMBERS = 8;
const MODEL_P_EPS = 1e-6;

function isHelsinki(signal: Signal): boolean {
  const id = (signal.cityId ?? "").toLowerCase();
  const name = (signal.cityName ?? "").toLowerCase();
  if (id.includes("helsinki") || name.includes("helsinki")) return true;
  // "hel" token / id — avoid matching unrelated names like "chelsea"
  if (id === "hel" || id.startsWith("hel-") || id.startsWith("hel_")) return true;
  if (/\bhel\b/.test(name)) return true;
  return false;
}

/** Parse a temperature magnitude from a market label like "40°C" / "95°F" / "40+". */
export function parseLabelTemp(label: string): { value: number; unit: TempUnit | null } | null {
  if (!label) return null;
  const m = label.match(/(-?\d+(?:\.\d+)?)\s*°?\s*([CF])?/i);
  if (!m) return null;
  const value = Number(m[1]);
  if (!Number.isFinite(value)) return null;
  const u = m[2]?.toUpperCase();
  const unit: TempUnit | null = u === "F" || u === "C" ? (u as TempUnit) : null;
  return { value, unit };
}

function monthOf(signal: Signal, now?: Date): number | null {
  // Prefer event date (YYYY-MM-DD); fall back to now.
  const d = signal.date?.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (d) return Number(d[2]);
  if (now) return now.getUTCMonth() + 1;
  return null;
}

function winterMonth(month: number | null): boolean {
  return month === 12 || month === 1 || month === 2;
}

function resolveBucket(
  signal: Signal,
  ctx: PlausibilityCtx,
): { lo: number; hi: number; unit: TempUnit } | null {
  const unit = signal.unit ?? "C";
  if (ctx.lo != null && Number.isFinite(ctx.lo) && ctx.hi != null && Number.isFinite(ctx.hi)) {
    return { lo: ctx.lo, hi: ctx.hi, unit };
  }
  if (ctx.lo != null && Number.isFinite(ctx.lo) && (ctx.hi == null || !Number.isFinite(ctx.hi))) {
    return { lo: ctx.lo, hi: Infinity, unit };
  }
  if (ctx.hi != null && Number.isFinite(ctx.hi) && (ctx.lo == null || !Number.isFinite(ctx.lo))) {
    return { lo: -Infinity, hi: ctx.hi, unit };
  }
  const parsed = parseLabelTemp(signal.label ?? "");
  if (!parsed) return null;
  const u = parsed.unit ?? unit;
  // Exact-degree bucket: [n, n+1)
  return { lo: parsed.value, hi: parsed.value + 1, unit: u };
}

function membersInBucket(members: number[], bucket: { lo: number; hi: number; unit: TempUnit }): number {
  // members are °C (WeatherNow.membersC)
  let n = 0;
  for (const m of members) {
    if (!Number.isFinite(m)) continue;
    const v = bucket.unit === "F" ? (m * 9) / 5 + 32 : m;
    if (v >= bucket.lo && v < bucket.hi) n += 1;
  }
  return n;
}

/**
 * Predictioner gate v1 — deterministic check order:
 * 1) thin ensemble (<8)
 * 2) impossible vs season/climatology
 * 3) obs already past bucket
 * 4) modelP≈0 with no members in bucket
 *
 * Never mutates signal.modelP.
 */
export function plausibilityVeto(signal: Signal, ctx: PlausibilityCtx = {}): PlausibilityResult {
  // 1) Thin ensemble — only when members provided
  if (ctx.members != null && ctx.members.length < MIN_MEMBERS) {
    return { ok: false, reason: "thin ensemble (<8)" };
  }

  // 2) Impossible vs season/climatology (Helsinki winter extreme YES)
  if (signal.side === "YES" && isHelsinki(signal) && winterMonth(monthOf(signal, ctx.now))) {
    const parsed = parseLabelTemp(signal.label ?? "");
    if (parsed) {
      const unit = (parsed.unit ?? signal.unit ?? "C") as TempUnit;
      const extreme =
        unit === "F" ? parsed.value >= 95 : unit === "C" ? parsed.value >= 35 : false;
      // Also treat bare numbers with signal.unit
      const extremeBare =
        !parsed.unit && signal.unit === "F"
          ? parsed.value >= 95
          : !parsed.unit && signal.unit === "C"
            ? parsed.value >= 35
            : extreme;
      if (extreme || extremeBare) {
        return { ok: false, reason: "impossible vs season/climatology" };
      }
    }
  }

  // 3) Obs already past bucket (YES on high markets)
  if (
    signal.side === "YES" &&
    signal.kind === "high" &&
    ctx.observedC != null &&
    Number.isFinite(ctx.observedC)
  ) {
    const bucket = resolveBucket(signal, ctx);
    if (bucket) {
      const obsInUnit =
        bucket.unit === "F" ? (ctx.observedC! * 9) / 5 + 32 : ctx.observedC!;
      // Observed already exceeds the bucket high → this YES bucket cannot win
      if (Number.isFinite(bucket.hi) && obsInUnit >= bucket.hi) {
        return { ok: false, reason: "obs already past bucket" };
      }
    }
  }

  // 4) modelP≈0 with no members in bucket — veto with reason; do NOT set modelP=0
  if (
    ctx.members != null &&
    ctx.members.length >= MIN_MEMBERS &&
    Number.isFinite(signal.modelP) &&
    Math.abs(signal.modelP) <= MODEL_P_EPS
  ) {
    const bucket = resolveBucket(signal, ctx);
    if (bucket && membersInBucket(ctx.members, bucket) === 0) {
      return { ok: false, reason: "modelP≈0 no members in bucket" };
    }
  }

  return { ok: true };
}
