/**
 * Per-endpoint 429 cooldown (Open-Meteo ensemble / forecast).
 *
 * On HTTP 429 (or 403, which Open-Meteo has used for blocks) the endpoint is
 * put on cooldown: no requests go out until it expires and callers keep
 * serving their last good data. The delay is:
 *   - Retry-After when the server sends one (seconds or HTTP date), plus up to
 *     10 % jitter, clamped to [1 s, 6 h];
 *   - otherwise exponential backoff with jitter: 60 s × 2^(strike-1), capped at
 *     1 h, scaled by a random factor in [0.75, 1.25). Open-Meteo's reason text
 *     raises the floor: "Minutely" ≥ 60 s, "Hourly" ≥ until the next UTC hour,
 *     "Daily" ≥ 30 min with a 6 h cap.
 * Exactly one log line is written when a cooldown starts and one when the
 * endpoint recovers; nothing is logged per skipped call.
 */
import { HttpError } from "./cache";

export const COOLDOWN_BASE_MS = 60_000;
export const COOLDOWN_MAX_MS = 60 * 60_000;
export const COOLDOWN_DAILY_FLOOR_MS = 30 * 60_000;
export const COOLDOWN_DAILY_MAX_MS = 6 * 3600_000;
export const RETRY_AFTER_MAX_MS = 6 * 3600_000;

type CooldownState = { until: number; strikes: number; since: number };
type CooldownGlobals = { __isobarCooldowns?: Map<string, CooldownState> };

function states() {
  const glob = globalThis as CooldownGlobals;
  return (glob.__isobarCooldowns ??= new Map());
}

/** Test helper. */
export function _resetCooldowns() {
  (globalThis as CooldownGlobals).__isobarCooldowns = new Map();
}

/** Retry-After (delta-seconds or HTTP date) → ms from now, or null when absent/invalid. */
export function parseRetryAfter(raw: string | null | undefined, now = Date.now()): number | null {
  if (!raw) return null;
  const v = raw.trim();
  if (/^\d+(\.\d+)?$/.test(v)) return Number(v) * 1000;
  const at = Date.parse(v);
  return Number.isFinite(at) ? Math.max(0, at - now) : null;
}

export function isRateLimitError(err: unknown) {
  return err instanceof HttpError && (err.status === 429 || err.status === 403);
}

export type CooldownPlan = { ms: number; why: string };

export function planCooldown(opts: {
  strike: number;
  retryAfter?: string | null;
  reason?: string | null;
  now?: number;
  random?: () => number;
}): CooldownPlan {
  const now = opts.now ?? Date.now();
  const rand = opts.random ?? Math.random;
  const ra = parseRetryAfter(opts.retryAfter, now);
  if (ra != null) {
    const ms = Math.min(RETRY_AFTER_MAX_MS, Math.max(1_000, ra * (1 + 0.1 * rand())));
    return { ms: Math.round(ms), why: `retry-after ${opts.retryAfter}` };
  }
  const reason = opts.reason ?? "";
  const daily = /daily/i.test(reason);
  const cap = daily ? COOLDOWN_DAILY_MAX_MS : COOLDOWN_MAX_MS;
  const exp = Math.min(cap, COOLDOWN_BASE_MS * 2 ** Math.max(0, opts.strike - 1));
  let ms = exp * (0.75 + 0.5 * rand());
  if (/minutely/i.test(reason)) ms = Math.max(ms, 60_000 + 10_000 * rand());
  if (/hourly/i.test(reason)) {
    const nextHour = Math.ceil((now + 1) / 3600_000) * 3600_000;
    ms = Math.max(ms, nextHour - now + 60_000 * rand());
  }
  if (daily) ms = Math.max(ms, COOLDOWN_DAILY_FLOOR_MS * (1 + 0.1 * rand()));
  return { ms: Math.round(Math.min(ms, cap * 1.25)), why: `backoff #${opts.strike}` };
}

export function coolingDown(name: string, now = Date.now()) {
  const st = states().get(name);
  return Boolean(st && now < st.until);
}

export function cooldownUntil(name: string) {
  return states().get(name)?.until ?? 0;
}

function fmtMs(ms: number) {
  if (ms < 90_000) return `${Math.round(ms / 1000)}s`;
  if (ms < 90 * 60_000) return `${Math.round(ms / 60_000)}m`;
  return `${(ms / 3600_000).toFixed(1)}h`;
}

/** Start a cooldown for `name` after a rate-limit error; logs one line. Returns the delay in ms. */
export function tripCooldown(
  name: string,
  err: unknown,
  servingNote = "",
  now = Date.now(),
  random = Math.random,
) {
  const map = states();
  const prev = map.get(name);
  const strike = (prev?.strikes ?? 0) + 1;
  const http = err instanceof HttpError ? err : null;
  const plan = planCooldown({
    strike,
    retryAfter: http?.retryAfter,
    reason: http?.reason,
    now,
    random,
  });
  map.set(name, { until: now + plan.ms, strikes: strike, since: prev?.since ?? now });
  const status = http ? `HTTP ${http.status}` : "rate-limited";
  const reason = http?.reason ? ` "${http.reason}"` : "";
  console.warn(
    `[isobar] ${name} ${status}${reason}: cooling down ${fmtMs(plan.ms)} (${plan.why})${servingNote ? `; ${servingNote}` : ""}`,
  );
  return plan.ms;
}

/** A request to `name` succeeded: drop the strike count (logs once if it had been cooling down). */
export function clearCooldown(name: string, now = Date.now()) {
  const map = states();
  const st = map.get(name);
  if (!st) return;
  map.delete(name);
  console.log(
    `[isobar] ${name} recovered after ${st.strikes} cooldown(s), ${fmtMs(now - st.since)} since first 429`,
  );
}
