import { convertTemp } from "../utils";
import { loadWeatherEvents, type ParsedEvent } from "./polymarket";
import { loadWeather } from "./weather";
import {
  bucketMid,
  bucketProbability,
  impliedTemp,
  intradayBucketProbability,
  intradayFinalMembers,
  intradayModel,
  kdeBandwidth,
  localHourIn,
  median,
  type IntradayModel,
  kellyFraction,
  mean,
  membersNearBucket,
  stdev,
  noGapMin,
  valueInBucket,
  yesLeadMax,
} from "./math";
import {
  PAPER_MAX_PRICE,
  PAPER_MIN_EDGE,
  PAPER_MIN_PRICE,
  PAPER_MIN_PRICE_YES,
  PAPER_FAVORITE_GUARD,
  PAPER_FAVORITE_GUARD_MODELP,
  PAPER_LIVE_DAY_DEFER,
  PAPER_NO_MAX_YES,
  PAPER_YES_MIN_MODELP,
} from "./paper-book";
import { ensembleOk } from "./ensemble";
import type { DeskEvent, DeskSnapshot, EnsembleStats, MarketBucket, Signal, TempKind, WeatherNow } from "./types";

const MIN_TRADE_PRICE = PAPER_MIN_PRICE;
const MAX_TRADE_PRICE = PAPER_MAX_PRICE;
const MIN_EDGE = PAPER_MIN_EDGE;
const MAX_SPREAD = 0.15;
const SETTLED_PRICE = 0.98;

export const ENSEMBLE_UNAVAILABLE = "Forecast ensemble unavailable (WeatherNext 3 / Open-Meteo, need >=8 members)";

/**
 * Dated members by kind: daily-MAX members for high markets, daily-MIN members
 * for low markets. Never fall back to membersC (may be another calendar day)
 * and never price a low with max members.
 */
export function membersForEvent(wx: WeatherNow | undefined, eventDate: string, kind: TempKind = "high"): number[] {
  const dated = kind === "low" ? wx?.membersMinByDate?.[eventDate] : wx?.membersByDate?.[eventDate];
  return Array.isArray(dated) ? dated : [];
}

/**
 * Observed extreme usable for a signal: the observed max for HIGH markets, the
 * observed min for LOW markets, and only when the signal's date is the city's
 * current local date (never today's obs for tomorrow).
 */
export function observedForSignal(wx: WeatherNow | undefined, sig: { date: string; kind: string }): number | null {
  if (!wx || wx.localDate !== sig.date) return null;
  if (sig.kind === "high") return wx.observedMaxC ?? null;
  if (sig.kind === "low") return wx.observedMinC ?? null;
  return null;
}

/** Display stats of the daily-MIN members pricing a low event (°C); null for highs. */
export function lowEnsembleStats(wx: WeatherNow | undefined, eventDate: string, kind: TempKind): EnsembleStats | null {
  if (kind !== "low") return null;
  const m = membersForEvent(wx, eventDate, "low");
  return {
    members: m.length,
    stdC: m.length ? stdev(m) : null,
    minC: m.length ? Math.min(...m) : null,
    maxC: m.length ? Math.max(...m) : null,
    source: m.length ? (wx?.minSource ?? null) : null,
  };
}

/** Live-day high without an observed max (no METAR at the settlement station): not traded from this local hour. */
export const HIGH_BLIND_FROM_H = 12;

export type PricingModel = {
  /** Raw dated members (°C) of the event's kind. */
  members: number[];
  /** Live-day intraday model (observation + time of day); null off the live day or without an observation. */
  intraday: IntradayModel | null;
  /** Members used for the support test and the model mean: final-extreme point estimates when intraday, else raw. */
  supportMembers: number[];
};

/**
 * How an event is priced: off the live day from the raw ensemble; on the city's live
 * local day with an observed extreme, from the intraday model (observed extreme +
 * remaining-hours forecast, collapsing onto the observation after the daily peak).
 */
export function pricingModel(
  wx: WeatherNow | undefined,
  sig: { date: string; kind: TempKind },
  tz: string | undefined,
  now = new Date(),
): PricingModel {
  const members = membersForEvent(wx, sig.date, sig.kind);
  const observedC = observedForSignal(wx, sig);
  if (!wx || observedC == null || !ensembleOk(members)) return { members, intraday: null, supportMembers: members };
  const bw = kdeBandwidth(members, "C", sig.date, tz, now);
  const intraday = intradayModel(
    members,
    {
      kind: sig.kind,
      observedC,
      latestObsC: wx.latestObsC ?? null,
      latestObsAt: wx.latestObsAt ?? null,
      hourly: wx.hourly,
      localDate: wx.localDate,
      tz,
      now,
    },
    bw,
  );
  return { members, intraday, supportMembers: intradayFinalMembers(intraday) };
}

/** Executable buy price: YES at the ask, NO at 1 − YES bid (never better than the mid). */
export function execPrice(side: "YES" | "NO", m: { yesPrice: number; noPrice: number; bestBid?: number | null; bestAsk?: number | null }) {
  if (side === "YES") {
    const ask = m.bestAsk;
    return ask != null && Number.isFinite(ask) && ask > 0 ? Math.max(m.yesPrice, ask) : m.yesPrice;
  }
  const bid = m.bestBid;
  return bid != null && Number.isFinite(bid) && bid > 0 ? Math.max(m.noPrice, 1 - bid) : m.noPrice;
}

function weatherHasDatedEnsemble(w: WeatherNow | undefined) {
  if (!w) return false;
  return (
    Object.values(w.membersByDate ?? {}).some((m) => ensembleOk(m)) ||
    Object.values(w.membersMinByDate ?? {}).some((m) => ensembleOk(m))
  );
}

/** Live low markets per city → event dates (only these cities get daily-min members). */
export function lowDatesFor(events: Pick<ParsedEvent, "kind" | "city" | "eventDate">[]): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const ev of events) {
    if (ev.kind !== "low") continue;
    const list = (out[ev.city.id] ??= []);
    if (!list.includes(ev.eventDate)) list.push(ev.eventDate);
  }
  return out;
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
    weather = await loadWeather(cities, { lowDates: lowDatesFor(events) });
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
  now?: Date;
}): DeskSnapshot {
  const { events, weather } = opts;
  const now = opts.now ?? new Date();
  let warning = opts.warning ?? null;
  const sources = new Set<string>();
  for (const w of Object.values(weather)) {
    for (const part of w.source.split(" \u00b7 ")) if (part) sources.add(part);
  }

  const anyDated = events.some((ev) => ensembleOk(membersForEvent(weather[ev.city.id], ev.eventDate, ev.kind)));
  if (events.length && !anyDated) {
    const hasAny = Object.values(weather).some(weatherHasDatedEnsemble);
    const msg = hasAny
      ? "Forecast ensemble has no members for event dates (need >=8)"
      : ENSEMBLE_UNAVAILABLE;
    warning = warning ? `${warning} \u00b7 ${msg}` : msg;
  }

  const deskEvents: DeskEvent[] = [];
  const signals: Signal[] = [];

  for (const ev of events) {
    const wx = weather[ev.city.id];
    const low = ev.kind === "low";
    // Daily-MAX members for highs, daily-MIN members for lows (never the other kind).
    const tz = ev.city.tz;
    const pm = pricingModel(wx, { date: ev.eventDate, kind: ev.kind }, tz, now);
    const members = pm.members;
    const enough = ensembleOk(members);
    const support = pm.supportMembers;
    const dayEnded = Boolean(wx?.localDate && wx.localDate > ev.eventDate);
    // Observed max (high) / observed min (low), only on the city's current local day.
    const observedC = observedForSignal(wx, { date: ev.eventDate, kind: ev.kind });
    const obsU = observedC != null ? convertTemp(observedC, ev.unit) : null;
    // A low is usually set by early morning: on its live day, without an observed min (no METAR
    // at the settlement station, e.g. HKO, or METAR down) it is priced for display but never traded.
    const lowBlind = low && wx?.localDate === ev.eventDate && observedC == null;
    // Same for a live-day high from early afternoon: without an observed max the time-of-day
    // conditioning can't run, and the raw daily-max ensemble ignores the hours already gone.
    const highBlind = !low && wx?.localDate === ev.eventDate && observedC == null && localHourIn(tz, now) >= HIGH_BLIND_FROM_H;
    const blind = lowBlind || highBlind;
    const mu = enough ? mean(support.map((m) => convertTemp(m, ev.unit))) : 0;
    const medU = enough ? convertTemp(median(support), ev.unit) : NaN;
    const gap = noGapMin(ev.unit);
    const near = (lo: number, hi: number) => enough && membersNearBucket(support, lo, hi, ev.unit, ev.eventDate, tz, now);
    const buckets: MarketBucket[] = ev.markets.map((m) => {
      const modelPRaw = !enough
        ? 0
        : pm.intraday
          ? intradayBucketProbability(pm.intraday, m.bound.lo, m.bound.hi, ev.unit)
          : bucketProbability(members, m.bound.lo, m.bound.hi, ev.unit, ev.eventDate, observedC, tz, now, ev.kind);
      let modelP = modelPRaw;
      if (enough && obsU != null) {
        // Settled side of the observation: a high can't end below its max, a low can't end above its min.
        if (!low && Number.isFinite(m.bound.hi) && m.bound.hi <= obsU + 1e-6) modelP = 0;
        if (low && Number.isFinite(m.bound.lo) && m.bound.lo > obsU + 1e-6) modelP = 0;
      }
      // Near-certainty gate: YES needs a raw member near the bucket (KDE tails are not support);
      // NO never shorts a supported bucket, the bucket the observation sits in, a close bucket,
      // or an 80%+ crowd favorite. modelP itself is never mutated by the gate.
      const supported = near(m.bound.lo, m.bound.hi);
      const obsIn = obsU != null && valueInBucket(obsU, m.bound.lo, m.bound.hi);
      const mid = bucketMid(m.bound.lo, m.bound.hi);
      const far = Math.abs(mid - mu) >= gap && (obsU == null || Math.abs(mid - obsU) >= gap);
      const noOk = enough && !supported && !obsIn && far && m.yesPrice < PAPER_NO_MAX_YES;
      // Edges are against the executable price (YES ask / NO = 1 − YES bid), not the mid.
      const yesExec = execPrice("YES", m);
      const noExec = execPrice("NO", m);
      const edgeYes = enough && supported ? modelP - yesExec : 0;
      const edgeNo = noOk ? 1 - modelP - noExec : 0;
      const yesPxOk = yesExec >= PAPER_MIN_PRICE_YES && yesExec <= MAX_TRADE_PRICE && m.yesPrice < SETTLED_PRICE;
      const noPxOk = noExec >= MIN_TRADE_PRICE && noExec <= MAX_TRADE_PRICE && m.noPrice < SETTLED_PRICE;
      const tradeable =
        enough &&
        !dayEnded &&
        !blind &&
        m.noPrice < SETTLED_PRICE &&
        m.yesPrice < SETTLED_PRICE &&
        ((yesPxOk && edgeYes >= MIN_EDGE) || (noPxOk && edgeNo >= MIN_EDGE));
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
        kellyYes: enough && supported ? kellyFraction(modelP, yesExec) : 0,
        kellyNo: noOk ? kellyFraction(1 - modelP, noExec) : 0,
        tradeable,
      };
    });

    const modelHigh = enough
      ? convertTemp(mean(members), ev.unit)
      : !low && wx?.modelMeanC != null
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
      lowEnsemble: lowEnsembleStats(wx, ev.eventDate, ev.kind),
      intraday: pm.intraday
        ? {
            localHour: pm.intraday.localHour,
            remainingFrac: pm.intraday.remainingFrac,
            observedC: pm.intraday.observedC,
            remainingFcC: pm.intraday.remainingFcC,
            biasC: pm.intraday.biasC,
            centerC: pm.intraday.centerC,
            sigmaC: pm.intraday.sigmaC,
          }
        : null,
      bestSignal: null,
    };

    if (enough && !warning && !dayEnded && !blind) {
      // YES only on the modal bucket: highest modelP (≥ 20%) with member support.
      const modalYes = buckets
        .filter((b) => b.modelP >= PAPER_YES_MIN_MODELP && near(b.lo, b.hi))
        .sort((a, b) => b.modelP - a.modelP)[0];
      // Market-sanity guard: when the crowd prices one bucket at ≥ 85%, no YES on any other bucket.
      // Exceptions need independent support: on the live day only the observation itself (the
      // observed extreme already sits in the bucket we buy, i.e. the market is stale); on other
      // days a model that gives the favorite < 50%.
      const fav = [...buckets].sort((a, b) => b.yesPrice - a.yesPrice)[0];
      const liveDay = wx?.localDate === ev.eventDate;
      const favGuard = (b: MarketBucket) => {
        if (fav == null || fav.marketId === b.marketId || fav.yesPrice < PAPER_FAVORITE_GUARD) return false;
        if (liveDay) return !(obsU != null && valueInBucket(obsU, b.lo, b.hi));
        return fav.modelP >= PAPER_FAVORITE_GUARD_MODELP;
      };
      // Live-day deference (see PAPER_LIVE_DAY_DEFER): after the window starts, YES only on the crowd favorite.
      const liveStarted = PAPER_LIVE_DAY_DEFER && pm.intraday != null && pm.intraday.remainingFrac < 1;
      const deferOk = (b: MarketBucket) => !liveStarted || (fav != null && fav.marketId === b.marketId);
      // Open-ended tail buckets aggregate many degrees, so "most mass" can be a tail: YES on one
      // needs the ensemble median inside it.
      const tailOk = (b: MarketBucket) => (Number.isFinite(b.lo) && Number.isFinite(b.hi)) || valueInBucket(medU, b.lo, b.hi);
      const lead = yesLeadMax(ev.unit);
      for (const b of buckets) {
        const spreadOk = b.spread == null || (Number.isFinite(b.spread) && b.spread <= MAX_SPREAD);
        if (!spreadOk) continue;

        const candidates: Array<Omit<Signal, "id">> = [];
        // Live day: the YES bucket can't be miles past the observed extreme (above the max / below the min).
        const yesLeadOk =
          obsU == null || (low ? !Number.isFinite(b.hi) || b.hi >= obsU - lead : !Number.isFinite(b.lo) || b.lo <= obsU + lead);
        if (
          modalYes != null &&
          b.marketId === modalYes.marketId &&
          yesLeadOk &&
          b.edgeYes >= MIN_EDGE &&
          execPrice("YES", b) >= PAPER_MIN_PRICE_YES &&
          execPrice("YES", b) <= MAX_TRADE_PRICE &&
          b.yesPrice < SETTLED_PRICE &&
          b.modelP >= PAPER_YES_MIN_MODELP &&
          near(b.lo, b.hi) &&
          !favGuard(b) &&
          deferOk(b) &&
          tailOk(b)
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
            marketP: execPrice("YES", b),
            modelP: b.modelP,
            edge: b.edgeYes,
            kelly: b.kellyYes,
            volume24hr: b.volume24hr || event.volume24hr,
          });
        }
        const noModel = 1 - b.modelP;
        if (
          b.edgeNo >= MIN_EDGE &&
          execPrice("NO", b) >= MIN_TRADE_PRICE &&
          execPrice("NO", b) <= MAX_TRADE_PRICE &&
          b.noPrice < SETTLED_PRICE &&
          noModel > 0.05 &&
          !near(b.lo, b.hi) &&
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
            marketP: execPrice("NO", b),
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

  // Member-supported YES (modal bucket) before NO, then by edge. The worker fills in this order.
  signals.sort((a, b) => {
    if (a.side !== b.side) return a.side === "YES" ? -1 : 1;
    return b.edge - a.edge;
  });
  deskEvents.sort((a, b) => b.volume24hr - a.volume24hr);

  for (const w of Object.values(weather)) {
    w.hourly = w.hourly.slice(0, 24);
  }

  return {
    fetchedAt: now.toISOString(),
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
