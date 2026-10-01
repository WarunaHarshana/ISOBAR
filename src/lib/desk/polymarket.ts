import { cached, fetchJson } from "./cache";
import { parseEventTitle, parseJsonArray, parseNumber, parseBucket, detectUnit, settlementRule, type SettlementRule } from "./parse";
import { resolveCity, unknownCity } from "./cities";
import type { CityMeta } from "./types";

export type RawMarket = {
  id: string;
  question: string;
  slug?: string;
  conditionId?: string;
  groupItemTitle?: string;
  description?: string;
  outcomePrices?: string | string[];
  outcomes?: string | string[];
  bestBid?: number | null;
  bestAsk?: number | null;
  spread?: number | null;
  volume?: string | number;
  volume24hr?: string | number;
  clobTokenIds?: string | string[];
  active?: boolean;
  closed?: boolean;
};

export type RawEvent = {
  id: string;
  title: string;
  slug: string;
  description?: string;
  eventDate?: string;
  endDate?: string;
  volume?: number;
  volume24hr?: number;
  liquidity?: number;
  image?: string;
  eventMetadata?: { context_description?: string };
  markets?: RawMarket[];
};

export type ParsedEvent = {
  eventId: string;
  slug: string;
  title: string;
  city: CityMeta;
  cityRaw: string;
  kind: "high" | "low";
  unit: "C" | "F";
  eventDate: string;
  endDate: string;
  volume: number;
  volume24hr: number;
  liquidity: number;
  image: string | null;
  context: string | null;
  /** How the resolution source rounds the settled number (see parse.ts). */
  settlement: SettlementRule;
  markets: Array<
    RawMarket & {
      bound: NonNullable<ReturnType<typeof parseBucket>>;
      yesPrice: number;
      noPrice: number;
      tokens: string[];
    }
  >;
};

export async function loadWeatherEvents(): Promise<ParsedEvent[]> {
  const url =
    "https://gamma-api.polymarket.com/events?tag_id=84&closed=false&limit=80&order=volume24hr&ascending=false";
  const events = await cached("gamma:weather", 25_000, () =>
    fetchJson<RawEvent[]>(url, {
      headers: { "user-agent": "Mozilla/5.0 (compatible; IsobarDesk/1.0)" },
    }),
  );

  const out: ParsedEvent[] = [];
  for (const event of events ?? []) {
    const parsed = parseEventTitle(event.title ?? "");
    if (!parsed) continue;
    const markets: ParsedEvent["markets"] = [];
    const settlement = settlementRule(event.description || event.markets?.[0]?.description);
    let unit: "C" | "F" = "C";
    for (const m of event.markets ?? []) {
      if (m.closed) continue;
      const bound = parseBucket(m.question ?? "", m.groupItemTitle, settlementRule(m.description || event.description));
      if (!bound) continue;
      unit = detectUnit(m.question ?? "");
      const prices = parseJsonArray(m.outcomePrices).map(Number);
      const tokens = parseJsonArray(m.clobTokenIds);
      markets.push({
        ...m,
        bound,
        yesPrice: Number.isFinite(prices[0]) ? prices[0] : 0,
        noPrice: Number.isFinite(prices[1]) ? prices[1] : 1 - (prices[0] || 0),
        tokens,
      });
    }
    if (!markets.length) continue;
    const city = resolveCity(parsed.cityRaw) ?? unknownCity(parsed.cityRaw);
    const eventDate = (event.eventDate || event.endDate || "").slice(0, 10);
    out.push({
      eventId: String(event.id),
      slug: event.slug,
      title: event.title,
      city,
      cityRaw: parsed.cityRaw,
      kind: parsed.kind,
      unit,
      eventDate,
      endDate: event.endDate ?? "",
      volume: parseNumber(event.volume),
      volume24hr: parseNumber(event.volume24hr),
      liquidity: parseNumber(event.liquidity),
      image: event.image ?? null,
      context: event.eventMetadata?.context_description ?? null,
      settlement,
      markets,
    });
  }
  return out;
}
