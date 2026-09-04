import { convertTemp } from "../utils.ts";
import { loadWeatherEvents, type ParsedEvent } from "./polymarket.ts";
import { loadWeather } from "./weather.ts";
import { bucketProbability, impliedTemp, kellyFraction, mean, membersNearBucket, valueInBucket } from "./math.ts";
import {
  PAPER_MAX_PRICE,
  PAPER_MIN_EDGE,
  PAPER_MIN_PRICE,
  PAPER_MIN_PRICE_YES,
  PAPER_NO_MAX_YES,
} from "./paper-book.ts";
import { ensembleOk } from "./ensemble.ts";
import type { DeskEvent, DeskSnapshot, MarketBucket, Signal, TempKind, WeatherNow } from "./types";

const MIN_TRADE_PRICE = PAPER_MIN_PRICE;
const MAX_TRADE_PRICE = PAPER_MAX_PRICE;
const MIN_EDGE = PAPER_MIN_EDGE;
const MAX_SPREAD = 0.15;
const SETTLED_PRICE = 0.98;

export const ENSEMBLE_UNAVAILABLE = "Open-Meteo ensemble unavailable (need >=8 members)";

/** Dated members by kind. Never fall back to membersC (may be another calendar day). */
export function membersForEvent(
  wx: WeatherNow | undefined,
  eventDate: string,
  kind: TempKind = "high",
): number[] {
  const dated = kind === "low" ? wx?.membersMinByDate?.[eventDate] : wx?.membersByDate?.[eventDate];
  return Array.isArray(dated) ? dated : [];
}

function weatherHasDatedEnsemble(w: WeatherNow | undefined) {
  if (!w) return false;
  return (
    Object.values(w.membersByDate ?? {}).some((m) => ensembleOk(m)) ||
    Object.values(w.membersMinByDate ?? {}).some((m) => ensembleOk(m))
  );
}

export async function buildDeskSnapshot(): Promise<DeskSnapshot> {
  let events: ParsedEvent[] = [];
  let warning: string | null = null;
  try {
    events = await loadWeatherEvents();
  } catch (err) {
    warning = err instanceof Error ? err.message : "Polymarket feed unavailable";
  }
  const cities = [...new Map(events.map((e) => [e.city.id, e.city])).values()];
  let weather: Record<string, WeatherNow> = {};
  try {
    weather = await loadWeather(cities);
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Weather feed unavailable";
    warning = warning ? `${warning} \u00b7 ${msg}` : msg;
  }
  return assembleDeskSnapshot({ events, weather, warning });
}

export function assembleDeskSnapshot(opts: {
  events: ParsedEvent[];
  weather: Record<string, WeatherNow>;
  warning?: string | null;
}): DeskSnapshot {
  const { events, weather } = opts;
  let warning = opts.warning ?? null;
  const sources = new Set<string>();
  for (const w of Object.values(weather)) {
    for (const part of w.source.split(" \u00b7 ")) if (part) sources.add(part);
  }

  const anyDated = events.some((ev) =>
    ensembleOk(membersForEvent(weather[ev.city.id], ev.eventDate, ev.kind)),
  );
  if (events.length && !anyDated) {
    const hasAny = Object.values(weather).some(weatherHasDatedEnsemble);
    const msg = hasAny
      ? "Open-Meteo ensemble has no members for event dates (need >=8)"
      : ENSEMBLE_UNAVAILABLE;
    warning = warning ? `${warning} \u00b7 ${msg}` : msg;
  }

  const deskEvents: DeskEvent[] = [];
  const signals: Signal[] = [];

  for (const ev of events) {
    const wx = weather[ev.city.id];
    const members = membersForEvent(wx, ev.eventDate, ev.kind);
    const enough = ensembleOk(members);
    const isLiveDay = wx?.localDate === ev.eventDate;
    const dayEnded = Boolean(wx?.localDate && wx.localDate > ev.eventDate);
    // Observed max only applies to daily-high. Flooring lows at observedMaxC is wrong.
    const observedC = isLiveDay && ev.kind === "high" ? (wx?.observedMaxC ?? null) : null;
    const obsU = observedC != null ? convertTemp(observedC, ev.unit) : null;
    const buckets: MarketBucket[] = ev.markets.map((m) => {
      const modelPRaw = enough
        ? bucketProbability(members, m.bound.lo, m.bound.hi, ev.unit, ev.eventDate, observedC)
        : 0;
      let modelP = modelPRaw;
      if (enough && observedC != null && Number.isFinite(m.bound.hi)) {
        const obsU = convertTemp(observedC, ev.unit);
        if (m.bound.hi <= obsU + 1e-6) modelP = 0;
      }
      const near = enough && membersNearBucket(members, m.bound.lo, m.bound.hi, ev.unit, ev.eventDate);
      const obsIn = obsU != null && valueInBucket(obsU, m.bound.lo, m.bound.hi);
      // Don't short the ensemble, a live high already in-bucket, or an 80%+ crowd YES.
      const noOk = enough && !near && !obsIn && m.yesPrice < PAPER_NO_MAX_YES;
      // P0: KDE tails are not YES support. Never mutate modelP.
      const edgeYes = enough && near ? modelP - m.yesPrice : 0;
      const edgeNo = noOk ? 1 - modelP - m.noPrice : 0;
      const yesPxOk =
        m.yesPrice >= PAPER_MIN_PRICE_YES && m.yesPrice <= MAX_TRADE_PRICE && m.yesPrice < SETTLED_PRICE;
      const noPxOk =
        m.noPrice >= MIN_TRADE_PRICE && m.noPrice <= MAX_TRADE_PRICE && m.noPrice < SETTLED_PRICE;
      const tradeable =
        enough &&
        !dayEnded &&
        m.noPrice < SETTLED_PRICE &&
        (yesPxOk || noPxOk) &&
        (Math.abs(edgeYes) >= MIN_EDGE || Math.abs(edgeNo) >= MIN_EDGE);
      return {
        marketId: String(m.id),
        conditionId: m.conditionId ?? "",
        question: m.question,
        slug: m.slug ?? "",
        label: m.bound.label,
        lo: m.bound.lo,
        hi: m.bound.hi,
        kind: m.bound.kind,
        yesPrice: m.yesPrice,
        noPrice: m.noPrice,
        bestBid: m.bestBid ?? null,
        bestAsk: m.bestAsk ?? null,
        spread: m.spread ?? null,
        volume: Number(m.volume ?? 0) || 0,
        volume24hr: Number(m.volume24hr ?? 0) || 0,
        clobYes: null,
        clobNo: null,
        modelP,
        edgeYes,
        edgeNo,
        kellyYes: enough && near ? kellyFraction(modelP, m.yesPrice) : 0,
        kellyNo: noOk ? kellyFraction(1 - modelP, m.noPrice) : 0,
        tradeable,
      };
    });

    const modelHigh = enough
      ? convertTemp(mean(members), ev.unit)
      : wx?.modelMeanC != null
        ? convertTemp(wx.modelMeanC, ev.unit)
        : null;
    const observed =
      observedC != null
        ? convertTemp(observedC, ev.unit)
        : wx?.tempC != null
          ? convertTemp(wx.tempC, ev.unit)
          : null;
    const implied = impliedTemp(buckets);

    const event: DeskEvent = {
      eventId: ev.eventId,
      slug: ev.slug,
      title: ev.title,
      cityId: ev.city.id,
      cityName: ev.city.name,
      kind: ev.kind,
      unit: ev.unit,
      eventDate: ev.eventDate,
      endDate: ev.endDate,
      volume: ev.volume,
      volume24hr: ev.volume24hr,
      liquidity: ev.liquidity,
      image: null,
      context: ev.context ? ev.context.slice(0, 280) : null,
      buckets,
      implied,
      modelHigh,
      observed,
      bestSignal: null,
    };

    if (enough && !warning && !dayEnded) {
      for (const b of buckets) {
        const spreadOk = b.spread == null || (Number.isFinite(b.spread) && b.spread <= MAX_SPREAD);
        if (!spreadOk) continue;

        const candidates: Array<Omit<Signal, "id">> = [];
        if (
          b.edgeYes >= MIN_EDGE &&
          b.yesPrice >= PAPER_MIN_PRICE_YES &&
          b.yesPrice <= MAX_TRADE_PRICE &&
          b.yesPrice < SETTLED_PRICE &&
          b.modelP > 0.05 &&
          membersNearBucket(members, b.lo, b.hi, ev.unit, ev.eventDate)
        ) {
          candidates.push({
            eventId: event.eventId,
            marketId: b.marketId,
            cityId: event.cityId,
            cityName: event.cityName,
            date: event.eventDate,
            kind: event.kind,
            unit: event.unit,
            question: b.question,
            label: b.label,
            side: "YES",
            marketP: b.yesPrice,
            modelP: b.modelP,
            edge: b.edgeYes,
            kelly: b.kellyYes,
            volume24hr: b.volume24hr || event.volume24hr,
          });
        }
        const noModel = 1 - b.modelP;
        if (
          b.edgeNo >= MIN_EDGE &&
          b.noPrice >= MIN_TRADE_PRICE &&
          b.noPrice <= MAX_TRADE_PRICE &&
          b.noPrice < SETTLED_PRICE &&
          noModel > 0.05 &&
          noModel < 0.95 &&
          !membersNearBucket(members, b.lo, b.hi, ev.unit, ev.eventDate) &&
          !(obsU != null && valueInBucket(obsU, b.lo, b.hi)) &&
          b.yesPrice < PAPER_NO_MAX_YES
        ) {
          candidates.push({
            eventId: event.eventId,
            marketId: b.marketId,
            cityId: event.cityId,
            cityName: event.cityName,
            date: event.eventDate,
            kind: event.kind,
            unit: event.unit,
            question: b.question,
            label: b.label,
            side: "NO",
            marketP: b.noPrice,
            modelP: noModel,
            edge: b.edgeNo,
            kelly: b.kellyNo,
            volume24hr: b.volume24hr || event.volume24hr,
          });
        }
        for (const c of candidates) {
          const sig: Signal = { ...c, id: `${c.marketId}-${c.side}` };
          signals.push(sig);
          if (!event.bestSignal || sig.edge > event.bestSignal.edge) event.bestSignal = sig;
        }
      }
    }

    deskEvents.push(event);
  }

  // YES (winning bucket) before NO, then by edge. Worker fills in this order.
  signals.sort((a, b) => {
    if (a.side !== b.side) return a.side === "YES" ? -1 : 1;
    return b.edge - a.edge;
  });
  deskEvents.sort((a, b) => b.volume24hr - a.volume24hr);

  for (const w of Object.values(weather)) {
    w.hourly = w.hourly.slice(0, 24);
  }

  return {
    fetchedAt: new Date().toISOString(),
    events: deskEvents,
    weather,
    signals: warning ? [] : signals.slice(0, 40),
    totals: {
      events: deskEvents.length,
      cities: new Set(deskEvents.map((e) => e.cityId)).size,
      volume24hr: deskEvents.reduce((a, e) => a + e.volume24hr, 0),
      openSignals: warning ? 0 : signals.length,
    },
    sources: [...sources],
    warning,
  };
}
