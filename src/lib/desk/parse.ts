import type { BucketBound, TempKind, TempUnit } from "./types";

const TITLE_RE = /(highest|lowest)\s+temperature\s+in\s+(.+?)\s+on\s+/i;

export function parseEventTitle(title: string): { kind: TempKind; cityRaw: string } | null {
  const m = title.match(TITLE_RE);
  if (!m) return null;
  return {
    kind: m[1].toLowerCase() === "lowest" ? "low" : "high",
    cityRaw: m[2].trim(),
  };
}

export function parseJsonArray(raw: unknown): string[] {
  if (Array.isArray(raw)) return raw.map(String);
  if (typeof raw !== "string") return [];
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) ? v.map(String) : [];
  } catch {
    return [];
  }
}

export function parseNumber(raw: unknown, fallback = 0) {
  if (typeof raw === "number" && Number.isFinite(raw)) return raw;
  if (typeof raw === "string" && raw.trim()) {
    const n = Number(raw);
    if (Number.isFinite(n)) return n;
  }
  return fallback;
}

/**
 * How the resolution source turns the true temperature into the settled number.
 * - "round": NOAA/Weather Underground station reports in whole degrees of the
 *   market unit (METAR/ASOS → nearest degree). A "72°F" bucket wins when the
 *   true max is in [71.5, 72.5). Verified against closed KLGA/KMIA/EGLC/RJTT
 *   markets vs METAR history (e.g. KMIA 28.3 °C = 82.9 °F → "82-83°F").
 * - "floor": Hong Kong Observatory "Absolute Daily Max" to 0.1 °C; Polymarket
 *   buckets contain the reading truncated to the degree (Aug 2026: 32.5 → "32°C",
 *   36.9 → "36°C"), so "28°C" = [28.0, 29.0).
 */
export type SettlementRule = "round" | "floor";

/** Pick the rule from a Gamma event/market description. */
export function settlementRule(description: string | null | undefined): SettlementRule {
  return /one decimal place/i.test(description ?? "") ? "floor" : "round";
}

/**
 * Bucket bounds on the continuous true temperature, half-open [lo, hi), in the
 * market's unit, matching the settlement rule.
 */
export function parseBucket(question: string, groupTitle?: string | null, rule: SettlementRule = "round"): BucketBound | null {
  const unitMatch = question.match(/°\s*([CF])/i);
  const unit = (unitMatch?.[1]?.toUpperCase() === "F" ? "F" : "C") as TempUnit;
  const deg = unit === "F" ? "°F" : "°C";
  // Reported value n covers [n + off, n + 1 + off).
  const off = rule === "floor" ? 0 : -0.5;

  const below = question.match(/be\s+(?:between\s+)?(-?\d+)(?:\s*[-–]\s*-?\d+)?\s*°/i);
  if (/or below/i.test(question) && below) {
    const n = Number(below[1]);
    return { lo: -Infinity, hi: n + 1 + off, kind: "floor", label: groupTitle?.trim() || `${n}${deg} or below` };
  }

  const above = question.match(/be\s+(-?\d+)\s*°/i);
  if (/or higher/i.test(question) && above) {
    const n = Number(above[1]);
    return { lo: n + off, hi: Infinity, kind: "ceil", label: groupTitle?.trim() || `${n}${deg}+` };
  }

  const range = question.match(/between\s+(-?\d+)\s*[-–]\s*(-?\d+)\s*°/i);
  if (range) {
    const a = Number(range[1]);
    const b = Number(range[2]);
    return { lo: a + off, hi: b + 1 + off, kind: "range", label: groupTitle?.trim() || `${a}–${b}${deg}` };
  }

  const exact = question.match(/be\s+(-?\d+)\s*°/i);
  if (exact) {
    const n = Number(exact[1]);
    return { lo: n + off, hi: n + 1 + off, kind: "exact", label: groupTitle?.trim() || `${n}${deg}` };
  }

  return null;
}

export function detectUnit(question: string): TempUnit {
  return /°\s*F/i.test(question) ? "F" : "C";
}

export function weatherLabel(code: number | null, cover: string | null) {
  if (cover) {
    const map: Record<string, string> = {
      CLR: "Clear",
      SKC: "Clear",
      FEW: "Few clouds",
      SCT: "Scattered",
      BKN: "Broken cloud",
      OVC: "Overcast",
      VV: "Obscured",
    };
    if (map[cover]) return map[cover];
  }
  if (code == null) return "—";
  if (code === 0) return "Clear";
  if (code <= 3) return "Partly cloudy";
  if (code <= 48) return "Fog";
  if (code <= 57) return "Drizzle";
  if (code <= 67) return "Rain";
  if (code <= 77) return "Snow";
  if (code <= 82) return "Showers";
  if (code <= 86) return "Snow showers";
  if (code <= 99) return "Thunderstorm";
  return "—";
}
