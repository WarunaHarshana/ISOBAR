/**
 * Live-day time-of-day conditioning, market-sanity guard, executable-price edges and
 * mark-to-market. Scenario data is the real 2 Oct 2026 Chengdu state (WeatherNext 3
 * daily-max members, ZUUU METAR, Open-Meteo hourly) at the time the bot bought YES 23°C.
 */
import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { bucketProbability, intradayBucketProbability, intradayFinalMembers, kdeBandwidth } from "./math.ts";
import { assembleDeskSnapshot, execPrice, pricingModel } from "./snapshot.ts";
import { emptyBook, fillMarkPnl, fillTickets, markPrice, paperTrade } from "./paper-book.ts";
import { plausibilityVeto } from "./plausibility.ts";
import { refreshOpenFillsFromGamma } from "./paper-worker.ts";
import { _resetCache } from "./cache.ts";
import type { CityMeta, PaperFill, Signal, WeatherNow } from "./types.ts";
import type { ParsedEvent } from "./polymarket.ts";

const chengdu: CityMeta = { id: "chengdu", name: "Chengdu", aliases: [], lat: 30.576, lon: 103.95, tz: "Asia/Shanghai", icao: "ZUUU", country: "CN" };
const DATE = "2026-10-02";
/** 17:00 Chengdu local. */
const AT_17 = new Date("2026-10-02T09:00:00Z");
const MEMBERS = [21.1, 21.4, 21.7, 21.8, 21.9, 22.0, 22.1, 22.2, 22.3, 22.4, 22.5, 22.5, 22.6, 22.7, 22.7, 22.8, 22.8, 22.9, 22.9, 23.0, 23.1, 23.1, 23.2, 23.2, 23.3, 23.3, 23.4, 23.5, 23.6, 23.6, 23.7, 23.8, 23.9, 23.9, 24.0, 24.1, 24.2, 24.3, 24.4, 24.5, 24.6, 24.7, 24.8, 24.9, 25.1, 25.3, 25.5, 25.7, 26.1, 26.7];
const HOURLY_C = [18.7, 18.5, 18.8, 18.8, 19, 18.9, 18.8, 18.7, 19, 19.3, 20.2, 20.7, 21.5, 22.5, 23.5, 24, 23.5, 23.3, 23, 21.7, 20.9, 20.4, 20.1, 19.8];
const hourly = (date: string, temps: number[]) => temps.map((t, h) => ({ time: `${date}T${String(h).padStart(2, "0")}:00`, tempC: t }));

function wx(over: Partial<WeatherNow> = {}): WeatherNow {
  return {
    tempC: 22, humidity: null, windMs: null, weatherCode: null, cover: null, station: "ZUUU", observedAt: null,
    observedMaxC: 22, observedMinC: 18, latestObsC: 22, latestObsAt: "2026-10-02T08:00:00.000Z",
    modelMeanC: null, modelStdC: null, modelMinC: null, modelMaxC: null, membersC: MEMBERS,
    membersByDate: { [DATE]: MEMBERS }, membersMinByDate: {}, localDate: DATE, hourly: hourly(DATE, HOURLY_C), source: "test",
    ...over,
  };
}

type Mkt = { n: number; yes: number; bid?: number; ask?: number; lo?: number; hi?: number };
function chengduEvent(mkts: Mkt[], over: Partial<ParsedEvent> = {}): ParsedEvent {
  return {
    eventId: "ev-chengdu", slug: "s", title: "Highest temperature in Chengdu on October 2?", city: chengdu, cityRaw: "Chengdu",
    kind: "high", unit: "C", eventDate: DATE, endDate: "", volume: 0, volume24hr: 1000, liquidity: 0, image: null, context: null,
    settlement: "round",
    markets: mkts.map((m) => ({
      id: `b${m.n}`, question: `Will the highest temperature in Chengdu be ${m.n}°C on October 2?`,
      bound: { lo: m.lo ?? m.n - 0.5, hi: m.hi ?? m.n + 0.5, label: `${m.n}°C`, kind: "exact" as const },
      yesPrice: m.yes, noPrice: 1 - m.yes, bestBid: m.bid ?? null, bestAsk: m.ask ?? null, spread: m.ask != null && m.bid != null ? m.ask - m.bid : null,
      tokens: [],
    })),
    ...over,
  };
}

/** The 2 Oct market at the fill: 22°C ~94%, 23°C ~7% (bid 3¢ / ask 20¢ → the 0.20 fill). */
const BOOK_AT_FILL: Mkt[] = [
  { n: 21, yes: 0.003, bid: 0.001, ask: 0.005 },
  { n: 22, yes: 0.94, bid: 0.92, ask: 0.96 },
  { n: 23, yes: 0.07, bid: 0.06, ask: 0.2 },
  { n: 24, yes: 0.006, bid: 0.004, ask: 0.008 },
  { n: 25, yes: 0.004, bid: 0.002, ask: 0.006 },
  { n: 26, yes: 0.002, bid: 0.001, ask: 0.003 },
];

describe("intraday conditioning (Chengdu 2 Oct, 17:00 local, ZUUU max 22 °C)", () => {
  it("collapses onto the observed-max bucket after the peak: 22 °C near-certain, 23 °C small", () => {
    const pm = pricingModel(wx(), { date: DATE, kind: "high" }, chengdu.tz, AT_17);
    assert.ok(pm.intraday, "live day with an observation → intraday model");
    assert.equal(pm.intraday!.remainingFrac, 0, "past the forecast peak (15:00) + 1 h");
    assert.ok(pm.intraday!.biasC < -1, `forecast ran ~2 °C warm: bias ${pm.intraday!.biasC}`);
    const p22 = intradayBucketProbability(pm.intraday!, 21.5, 22.5, "C");
    const p23 = intradayBucketProbability(pm.intraday!, 22.5, 23.5, "C");
    const p21 = intradayBucketProbability(pm.intraday!, 20.5, 21.5, "C");
    assert.ok(p22 > 0.95, `P(22) = ${p22}`);
    assert.ok(p23 < 0.05, `P(23) = ${p23}`);
    assert.equal(p21, 0, "a high can't end below its observed max");
    // The old floor-only conditioning (the bug) put most of the mass on 23–25 °C.
    const old23 = bucketProbability(MEMBERS, 22.5, 23.5, "C", DATE, 22, chengdu.tz, AT_17, "high");
    assert.ok(old23 > 0.25, `old model P(23) = ${old23}`);
  });

  it("no YES on 23 °C (the bug fill), and no other signal on the event", () => {
    const snap = assembleDeskSnapshot({ events: [chengduEvent(BOOK_AT_FILL)], weather: { chengdu: wx() }, now: AT_17 });
    const ev = snap.events[0];
    const b22 = ev.buckets.find((b) => b.label === "22°C")!;
    const b23 = ev.buckets.find((b) => b.label === "23°C")!;
    assert.ok(b22.modelP > 0.95, String(b22.modelP));
    assert.ok(b23.modelP < 0.05, String(b23.modelP));
    assert.equal(b23.edgeYes <= 0, true);
    assert.equal(snap.signals.filter((s) => s.side === "YES" && s.label === "23°C").length, 0);
    assert.equal(snap.signals.filter((s) => s.side === "YES").length, 0);
    assert.ok(ev.intraday && ev.intraday.remainingFrac === 0);
  });

  it("without an hourly forecast, after 17:00 local it still collapses onto the observation", () => {
    const pm = pricingModel(wx({ hourly: [] }), { date: DATE, kind: "high" }, chengdu.tz, AT_17);
    const p22 = intradayBucketProbability(pm.intraday!, 21.5, 22.5, "C");
    assert.ok(p22 > 0.8, String(p22));
  });

  it("the plausibility gate sees the conditioned members: no support for 24 °C at 17:00", () => {
    const pm = pricingModel(wx(), { date: DATE, kind: "high" }, chengdu.tz, AT_17);
    const sig = { side: "YES", kind: "high", unit: "C", date: DATE, label: "24°C", modelP: 0.3 } as Signal;
    const veto = plausibilityVeto(sig, { members: pm.supportMembers, observedC: 22, lo: 23.5, hi: 24.5, tz: chengdu.tz, now: AT_17 });
    assert.equal(veto.ok, false);
    assert.ok(intradayFinalMembers(pm.intraday!).every((m) => m >= 22 && m < 22.5));
  });

  it("early morning (before the warming window) keeps the ensemble: same as the old floor conditioning", () => {
    const early = new Date("2026-10-01T21:30:00Z"); // 05:30 local
    const w = wx({ observedMaxC: 18.8, latestObsC: 18.8, latestObsAt: "2026-10-01T21:00:00Z" });
    const pm = pricingModel(w, { date: DATE, kind: "high" }, chengdu.tz, early);
    assert.equal(pm.intraday!.remainingFrac, 1);
    const bw = kdeBandwidth(MEMBERS, "C", DATE, chengdu.tz, early);
    assert.ok(bw > 0);
    for (const [lo, hi] of [[21.5, 22.5], [22.5, 23.5], [23.5, 24.5]]) {
      const a = intradayBucketProbability(pm.intraday!, lo, hi, "C");
      assert.ok(a > 0.1 && a < 0.45, `[${lo},${hi}) ${a}`);
    }
  });

  it("mid-afternoon before the peak: upside stays open but tighter than the raw ensemble", () => {
    const at13 = new Date("2026-10-02T05:00:00Z"); // 13:00 local, forecast peak 15:00
    const w = wx({ observedMaxC: 21, latestObsC: 21, latestObsAt: "2026-10-02T05:00:00Z" });
    const pm = pricingModel(w, { date: DATE, kind: "high" }, chengdu.tz, at13);
    const f = pm.intraday!.remainingFrac;
    assert.ok(f > 0.2 && f < 0.5, String(f));
    const p23plus = intradayBucketProbability(pm.intraday!, 22.5, Infinity, "C");
    const raw = bucketProbability(MEMBERS, 22.5, Infinity, "C", DATE, 21, chengdu.tz, at13, "high");
    assert.ok(p23plus > 0.05 && p23plus < raw, `${p23plus} vs raw ${raw}`);
  });

  it("lows mirror: after the dawn trough the observed min mostly holds, but an evening drop in the forecast counts", () => {
    const tz = chengdu.tz;
    const at14 = new Date("2026-10-02T06:00:00Z"); // 14:00 local
    const minMembers = MEMBERS.map((m) => m - 6); // ~15–20 °C
    const flatEvening = hourly(DATE, HOURLY_C); // min 18.5 at 01:00
    const base = { observedMinC: 18, latestObsC: 23, latestObsAt: "2026-10-02T06:00:00Z", membersMinByDate: { [DATE]: minMembers } };
    const pmHold = pricingModel(wx({ ...base, hourly: flatEvening }), { date: DATE, kind: "low" }, tz, at14);
    assert.equal(pmHold.intraday!.remainingFrac, 0);
    const pHold = intradayBucketProbability(pmHold.intraday!, 17.5, 18.5, "C");
    assert.ok(pHold > 0.95, `min holds at 18: ${pHold}`);
    const drop = [...HOURLY_C.slice(0, 20), 18, 16.5, 15.5, 15]; // front: 15 °C by midnight
    const pmDrop = pricingModel(wx({ ...base, hourly: hourly(DATE, drop) }), { date: DATE, kind: "low" }, tz, at14);
    const pBelow = intradayBucketProbability(pmDrop.intraday!, -Infinity, 17.5, "C");
    assert.ok(pBelow > 0.5, `evening drop: ${pBelow}`);
  });

  it("probabilities over a full ladder sum to 1", () => {
    const pm = pricingModel(wx(), { date: DATE, kind: "high" }, chengdu.tz, new Date("2026-10-02T04:00:00Z"));
    let sum = intradayBucketProbability(pm.intraday!, -Infinity, 15.5, "C") + intradayBucketProbability(pm.intraday!, 30.5, Infinity, "C");
    for (let n = 16; n <= 30; n++) sum += intradayBucketProbability(pm.intraday!, n - 0.5, n + 0.5, "C");
    assert.ok(Math.abs(sum - 1) < 1e-6, String(sum));
  });
});

describe("market-sanity guard, executable edges, tail buckets", () => {
  const tomorrow = "2026-10-03";
  const wxTomorrow = (members: number[]) => wx({ membersByDate: { [DATE]: MEMBERS, [tomorrow]: members } });

  it("live day: no YES against a ≥85% favorite unless the observation is already in the bought bucket", () => {
    // Broken model (no hourly, members far above, morning) would otherwise buy 24 against a 90% favorite.
    const morning = new Date("2026-10-02T01:00:00Z"); // 09:00 local
    const w = wx({ hourly: [], observedMaxC: 20, latestObsC: 20, membersByDate: { [DATE]: MEMBERS.map((m) => m + 1.5) } });
    const book: Mkt[] = [{ n: 22, yes: 0.9, bid: 0.89, ask: 0.91 }, { n: 23, yes: 0.06, bid: 0.05, ask: 0.07 }, { n: 24, yes: 0.04, bid: 0.03, ask: 0.05 }, { n: 25, yes: 0.03, bid: 0.02, ask: 0.04 }];
    const snap = assembleDeskSnapshot({ events: [chengduEvent(book)], weather: { chengdu: w }, now: morning });
    assert.equal(snap.signals.filter((s) => s.side === "YES").length, 0, JSON.stringify(snap.signals));
  });

  it("live day after the window starts: YES only on the market favorite (deference)", () => {
    // 11:00 local, still warming; the model prefers 23 while the crowd favors 24 at 60%.
    const at11 = new Date("2026-10-02T03:00:00Z");
    const w = wx({ observedMaxC: 20.2, latestObsC: 20.2, latestObsAt: "2026-10-02T03:00:00Z" });
    const book: Mkt[] = [{ n: 22, yes: 0.05, bid: 0.04, ask: 0.06 }, { n: 23, yes: 0.1, bid: 0.09, ask: 0.11 }, { n: 24, yes: 0.6, bid: 0.59, ask: 0.61 }, { n: 25, yes: 0.25, bid: 0.24, ask: 0.26 }];
    const snap = assembleDeskSnapshot({ events: [chengduEvent(book)], weather: { chengdu: w }, now: at11 });
    const ev = snap.events[0];
    assert.ok(ev.intraday && ev.intraday.remainingFrac < 1 && ev.intraday.remainingFrac > 0);
    const yes = snap.signals.filter((s) => s.side === "YES");
    assert.ok(yes.every((s) => s.label === "24°C"), JSON.stringify(yes));
  });

  it("other days: YES against a ≥85% favorite only when the model gives the favorite < 50%", () => {
    const at = new Date("2026-10-02T01:00:00Z");
    const ev = (fav: number) => chengduEvent([{ n: 22, yes: fav, bid: fav - 0.01, ask: fav + 0.01 }, { n: 24, yes: 0.05, bid: 0.04, ask: 0.06 }], { eventDate: tomorrow });
    // Model centered on 24 → P(22) small → strong disagreement allowed.
    const tight24 = Array.from({ length: 30 }, (_, i) => 23.6 + i * 0.03);
    const s1 = assembleDeskSnapshot({ events: [ev(0.88)], weather: { chengdu: wxTomorrow(tight24) }, now: at });
    assert.equal(s1.signals.filter((s) => s.label === "24°C" && s.side === "YES").length, 1);
    // Model split (P(22) ≥ 50%) → blocked.
    const split = [...Array.from({ length: 20 }, () => 22), ...Array.from({ length: 12 }, () => 24)];
    const s2 = assembleDeskSnapshot({ events: [ev(0.88)], weather: { chengdu: wxTomorrow(split) }, now: at });
    assert.equal(s2.signals.filter((s) => s.label === "24°C" && s.side === "YES").length, 0);
  });

  it("edge is measured against the ask, not the mid", () => {
    const at = new Date("2026-10-02T01:00:00Z");
    const tight23 = Array.from({ length: 30 }, (_, i) => 22.6 + i * 0.03);
    const mk = (ask: number) =>
      chengduEvent([{ n: 22, yes: 0.5, bid: 0.49, ask: 0.51 }, { n: 23, yes: 0.2, bid: 0.19, ask }, { n: 24, yes: 0.2, bid: 0.19, ask: 0.21 }], { eventDate: tomorrow });
    const s = assembleDeskSnapshot({ events: [mk(0.21)], weather: { chengdu: wxTomorrow(tight23) }, now: at });
    const sig = s.signals.find((x) => x.label === "23°C" && x.side === "YES");
    assert.ok(sig, JSON.stringify(s.events[0].buckets.map((b) => [b.label, b.modelP, b.edgeYes])));
    assert.equal(sig!.marketP, 0.21, "signal price = ask");
    const p = s.events[0].buckets.find((b) => b.label === "23°C")!.modelP;
    // Ask high enough to kill the edge → no signal.
    // Same mid (0.20) but an ask that leaves < 6¢ of edge → no signal.
    const s2 = assembleDeskSnapshot({ events: [mk(Math.min(0.85, p - 0.03))], weather: { chengdu: wxTomorrow(tight23) }, now: at });
    assert.equal(s2.signals.filter((x) => x.label === "23°C").length, 0);
    assert.equal(execPrice("NO", { yesPrice: 0.3, noPrice: 0.7, bestBid: 0.25, bestAsk: 0.35 }), 0.75);
  });

  it("open-ended tail bucket: YES needs the ensemble median inside it", () => {
    const at = new Date("2026-10-02T01:00:00Z");
    // Wide ensemble centered at 24: the "≤21" tail collects lots of mass but the median is 24.
    const wide = Array.from({ length: 40 }, (_, i) => 18 + i * 0.3);
    const book: ParsedEvent = chengduEvent([], { eventDate: tomorrow });
    book.markets = [
      { id: "tail", question: "21°C or below", bound: { lo: -Infinity, hi: 21.5, label: "21°C or below", kind: "floor" }, yesPrice: 0.05, noPrice: 0.95, bestBid: 0.04, bestAsk: 0.06, tokens: [] },
      ...[22, 23, 24, 25, 26].map((n) => ({ id: `b${n}`, question: `${n}`, bound: { lo: n - 0.5, hi: n + 0.5, label: `${n}°C`, kind: "exact" as const }, yesPrice: 0.18, noPrice: 0.82, bestBid: 0.17, bestAsk: 0.19, tokens: [] })),
    ];
    const s = assembleDeskSnapshot({ events: [book], weather: { chengdu: wxTomorrow(wide) }, now: at });
    assert.ok(s.events[0].buckets[0].modelP >= 0.2, String(s.events[0].buckets[0].modelP));
    assert.equal(s.signals.filter((x) => x.label === "21°C or below" && x.side === "YES").length, 0);
  });
});

describe("paper fills at the executable price; mark-to-market", () => {
  const sig = (over: Partial<Signal> = {}): Signal => ({
    id: "m-YES", eventId: "e", marketId: "m", cityId: "chengdu", cityName: "Chengdu", date: DATE, kind: "high", unit: "C",
    question: "q", label: "23°C", side: "YES", marketP: 0.07, modelP: 0.29, edge: 0.22, kelly: 0.24, volume24hr: 0, ...over,
  });

  it("a mid-priced signal is not bought when the ask kills the edge; Kelly re-sized at the fill price", () => {
    assert.equal(paperTrade(sig(), emptyBook(), { bestBid: 0.03, bestAsk: 0.25 }), null);
    const ok = paperTrade(sig(), emptyBook(), { bestBid: 0.03, bestAsk: 0.2 });
    assert.ok(ok);
    assert.equal(ok!.price, 0.2);
    // Kelly at 0.20 = 0.09/0.8 = 0.1125 (< signal's 0.24) → stake 10k × 0.1125 × 0.12 = 135.
    assert.ok(Math.abs(ok!.cost - 135) < 1e-6, String(ok!.cost));
  });

  it("marks: YES at the YES bid, NO at 1 − YES ask, mid when one side is missing, cost when unquoted", () => {
    const at = "2026-10-02T09:00:00Z";
    assert.equal(markPrice("YES", { yesBid: 0.01, yesAsk: 0.04, yesMid: 0.025, at }), 0.01);
    assert.ok(Math.abs(markPrice("NO", { yesBid: 0.01, yesAsk: 0.04, yesMid: 0.025, at })! - 0.96) < 1e-9);
    assert.equal(markPrice("YES", { yesBid: null, yesAsk: 0.04, yesMid: 0.025, at }), 0.025);
    assert.equal(markPrice("YES", null), null);
    // Chengdu bug fill: 956.5 shares @0.20 ($191.29), 23°C bid 1¢ → mark ≈ −$181.7 (was +$90 marked at modelP).
    const f: PaperFill = { id: "x", eventId: "e", marketId: "m", cityId: "chengdu", cityName: "Chengdu", date: DATE, question: "q", side: "YES", price: 0.2, shares: 956.4720530172279, cost: 191.29441060344558, modelP: 0.294, placedAt: at, status: "open", payout: 0 };
    const marks = { m: { yesBid: 0.01, yesAsk: 0.04, yesMid: 0.025, at } };
    assert.ok(Math.abs(fillMarkPnl(f, marks) - (956.4720530172279 * 0.01 - 191.29441060344558)) < 1e-9);
    assert.equal(fillTickets([f], marks)[0].markSource, "bid");
    assert.equal(fillMarkPnl({ ...f, status: "lost" }, marks), -191.29441060344558);
    assert.equal(fillMarkPnl({ ...f, status: "won", payout: f.shares }, marks), f.shares - f.cost);
  });

  describe("Gamma refresh records quotes for open tickets", () => {
    let realFetch: typeof fetch;
    beforeEach(() => {
      _resetCache();
      realFetch = globalThis.fetch;
      globalThis.fetch = (async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.endsWith("/m-open")) return Response.json({ id: "m-open", closed: false, bestBid: 0.01, bestAsk: "0.04", outcomes: '["Yes","No"]', outcomePrices: '["0.025","0.975"]' });
        return Response.json({ id: "m-closed", closed: true, outcomes: '["Yes","No"]', outcomePrices: '["0","1"]' });
      }) as typeof fetch;
    });
    afterEach(() => {
      globalThis.fetch = realFetch;
    });
    it("open market → mark; closed market → settled from the winner, no mark", async () => {
      const base = { eventId: "e", cityId: "c", cityName: "C", date: DATE, question: "q", side: "YES" as const, price: 0.2, shares: 10, cost: 2, modelP: 0.3, placedAt: "", status: "open" as const, payout: 0 };
      const { fills, marks } = await refreshOpenFillsFromGamma([{ ...base, id: "1", marketId: "m-open" }, { ...base, id: "2", marketId: "m-closed" }]);
      assert.deepEqual({ bid: marks["m-open"].yesBid, ask: marks["m-open"].yesAsk, mid: marks["m-open"].yesMid }, { bid: 0.01, ask: 0.04, mid: 0.025 });
      assert.equal(marks["m-closed"], undefined);
      assert.equal(fills[0].status, "open");
      assert.equal(fills[1].status, "lost");
    });
  });
});
