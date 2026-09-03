import { convertTemp } from "@/lib/utils";
import { loadWeatherEvents } from "./polymarket";
import { loadWeather } from "./weather";
import { bucketProbability, impliedTemp, kellyFraction, mean } from "./math";
import { PAPER_MAX_PRICE, PAPER_MIN_EDGE, PAPER_MIN_PRICE } from "./paper-book";
import { ensembleOk } from "./ensemble";
import type { DeskEvent, DeskSnapshot, MarketBucket, Signal, WeatherNow } from "./types";

const MIN_TRADE_PRICE = PAPER_MIN_PRICE;
const MAX_TRADE_PRICE = PAPER_MAX_PRICE;
const MIN_EDGE = PAPER_MIN_EDGE;
const MAX_SPREAD = 0.15;

export async function buildDeskSnapshot(): Promise<DeskSnapshot> {
  let events: Awaited<ReturnType<typeof loadWeatherEvents>> = [];
  let warning: string | null = null;
  try {
    events = await loadWeatherEvents();
  } catch (err) {
    warning = err instanceof Error ? err.message : "Polymarket feed unavailable";
  }
  const cities = [...new Map(events.map((e) => [e.city.id, e.city])).values()];
  let weather: Record<string, WeatherNow> = {};
  const sources = new Set<string>();
  try {
    weather = await loadWeather(cities);
    for (const w of Object.values(weather)) {
      for (const part of w.source.split(" · ")) if (part) sources.add(part);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Weather feed unavailable";
    warning = warning ? `${warning} · ${msg}` : msg;
  }

  const deskEvents: DeskEvent[] = [];
  const signals: Signal[] = [];

  for (const ev of events) {
    const wx = weather[ev.city.id];
    const members = membersForEvent(wx, ev.eventDate);
    const enough = ensembleOk(members);
    const isLiveDay = wx?.localDate === ev.eventDate;
    const observedC = isLiveDay ? (wx?.observedMaxC ?? null) : null;
    const buckets: MarketBucket[] = ev.markets.map((m) => {
      // Empty / thin ensemble must NOT price modelP=0 (that mints fake NO edges).
      const modelPRaw = enough
        ? bucketProbability(members, m.bound.lo, m.bound.hi, ev.unit, ev.eventDate, observedC)
        : 0;
      let modelP = modelPRaw;
      if (enough && observedC != null && Number.isFinite(m.bound.hi)) {
        const obsU = convertTemp(observedC, ev.unit);
        if (m.bound.hi <= obsU + 1e-6) modelP = 0;
      }
      const edgeYes = enough ? modelP - m.yesPrice : 0;
      const edgeNo = enough ? 1 - modelP - m.noPrice : 0;
      const tradeable =
        enough &&
        m.yesPrice >= MIN_TRADE_PRICE &&
        m.yesPrice <= MAX_TRADE_PRICE &&
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
        kellyYes: enough ? kellyFraction(modelP, m.yesPrice) : 0,
        kellyNo: enough ? kellyFraction(1 - modelP, m.noPrice) : 0,
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

    // Quant: no signals from thin/empty ensembles (members=[] => zero fills).
    if (enough && !warning) {
      for (const b of buckets) {
        const spreadOk = b.spread == null || (Number.isFinite(b.spread) && b.spread <= MAX_SPREAD);
        if (!spreadOk) continue;

        const candidates: Array<Omit<Signal, "id">> = [];
        if (
          b.edgeYes >= MIN_EDGE &&
          b.yesPrice >= MIN_TRADE_PRICE &&
          b.yesPrice <= MAX_TRADE_PRICE &&
          b.modelP > 0.05 &&
          b.modelP < 0.95
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
          noModel > 0.05 &&
          noModel < 0.95
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

  signals.sort((a, b) => b.edge - a.edge);
  deskEvents.sort((a, b) => b.volume24hr - a.volume24hr);

  for (const w of Object.values(weather)) {
    w.membersByDate = {};
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

function membersForEvent(wx: WeatherNow | undefined, eventDate: string) {
  if (!wx) return [];
  const dated = wx.membersByDate?.[eventDate];
  if (dated?.length) return dated;
  if (wx.localDate === eventDate && wx.membersC?.length) return wx.membersC;
  return [];
}
