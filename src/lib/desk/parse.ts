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

export function parseBucket(question: string, groupTitle?: string | null): BucketBound | null {
  const unitMatch = question.match(/°\s*([CF])/i);
  const unit = (unitMatch?.[1]?.toUpperCase() === "F" ? "F" : "C") as TempUnit;
  const deg = unit === "F" ? "°F" : "°C";

  const below = question.match(/be\s+(?:between\s+)?(\d+)(?:\s*[-–]\s*\d+)?\s*°/i);
  if (/or below/i.test(question) && below) {
    const n = Number(below[1]);
    return { lo: -Infinity, hi: n + 1, kind: "floor", label: groupTitle?.trim() || `${n}${deg} or below` };
  }

  const above = question.match(/be\s+(\d+)\s*°/i);
  if (/or higher/i.test(question) && above) {
    const n = Number(above[1]);
    return { lo: n, hi: Infinity, kind: "ceil", label: groupTitle?.trim() || `${n}${deg}+` };
  }

  const range = question.match(/between\s+(\d+)\s*[-–]\s*(\d+)\s*°/i);
  if (range) {
    const a = Number(range[1]);
    const b = Number(range[2]);
    return { lo: a, hi: b + 1, kind: "range", label: groupTitle?.trim() || `${a}–${b}${deg}` };
  }

  const exact = question.match(/be\s+(\d+)\s*°/i);
  if (exact) {
    const n = Number(exact[1]);
    return { lo: n, hi: n + 1, kind: "exact", label: groupTitle?.trim() || `${n}${deg}` };
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
