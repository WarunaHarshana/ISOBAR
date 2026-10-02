/**
 * Desk logic ported from fix/near-certainty-gate onto main's architecture:
 * near-certainty gate, low-temp pricing from daily-MIN members + observed min,
 * multi-model tertiary fallback, server-side city ledger / tickets, headless paper arm.
 */
import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { _resetCache } from "./cache.ts";
import { bucketMid, bucketProbability, membersNearBucket, valueInBucket } from "./math.ts";
import {
  PAPER_MAX_OPEN_PER_CITY_DATE,
  _resetPaperBookCache,
  cityLedger,
  emptyBook,
  fillMarkPnl,
  fillTickets,
  loadPaperBook,
  paperTrade,
  savePaperBook,
} from "./paper-book.ts";
import { plausibilityVeto } from "./plausibility.ts";
import { assembleDeskSnapshot, lowDatesFor, membersForEvent, observedForSignal } from "./snapshot.ts";
import { _resetEnsembleGuards, loadWeather, observedMinForLocalDay } from "./weather.ts";
import { _resetWeatherNext, _setWeatherNextConfig } from "./weathernext.ts";
import { tickPaperWorker } from "./paper-worker.ts";
import type { CityMeta, PaperFill, Signal, WeatherNow } from "./types.ts";
import type { ParsedEvent } from "./polymarket.ts";

const nyc: CityMeta = {
  id: "nyc",
  name: "New York City",
  aliases: ["nyc"],
  lat: 40.7829,
  lon: -73.9654,
  tz: "America/New_York",
  icao: "KNYC",
  country: "US",
};

const FUTURE = "2099-01-02";
/** NYC's current local date: lead σ is at its floor, so a tight ensemble gives a clear mode. */
const TODAY = new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York" }).format(new Date());
const spread = (n: number, center: number, step = 0.1) => Array.from({ length: n }, (_, i) => center + (i - (n - 1) / 2) * step);

function wx(over: Partial<WeatherNow> = {}): WeatherNow {
  return {
    tempC: 15,
    humidity: null,
    windMs: null,
    weatherCode: null,
    cover: null,
    station: null,
    observedAt: null,
    observedMaxC: null,
    observedMinC: null,
    modelMeanC: null,
    modelStdC: null,
    modelMinC: null,
    modelMaxC: null,
    membersC: [],
    membersByDate: {},
    membersMinByDate: {},
    localDate: "2099-01-01",
    hourly: [],
    source: "test",
    ...over,
  };
}

type Mkt = { id: string; lo: number; hi: number; yes: number };
function event(kind: "high" | "low", mkts: Mkt[], over: Partial<ParsedEvent> = {}): ParsedEvent {
  return {
    eventId: `ev-${kind}`,
    slug: "s",
    title: kind === "low" ? "Lowest temperature in NYC" : "Highest temperature in NYC",
    city: nyc,
    cityRaw: "NYC",
    kind,
    unit: "C",
    eventDate: FUTURE,
    endDate: "",
    volume: 0,
    volume24hr: 100,
    liquidity: 0,
    image: null,
    context: null,
    settlement: "round",
    markets: mkts.map((m) => ({
      id: m.id,
      question: `q ${m.id}`,
      bound: { lo: m.lo, hi: m.hi, label: m.id, kind: Number.isFinite(m.lo) && Number.isFinite(m.hi) ? "exact" : Number.isFinite(m.lo) ? "ceil" : "floor" },
      yesPrice: m.yes,
      noPrice: 1 - m.yes,
      tokens: [],
    })),
    ...over,
  };
}

/** Whole-degree °C buckets 2..18 (round rule: n covers [n-0.5, n+0.5)). */
function ladder(prices: Record<number, number>, from = 2, to = 18): Mkt[] {
  const out: Mkt[] = [];
  for (let n = from; n <= to; n++) out.push({ id: `b${n}`, lo: n - 0.5, hi: n + 0.5, yes: prices[n] ?? 0.04 });
  return out;
}

describe("math helpers (near-certainty gate)", () => {
  it("membersNearBucket: a raw member within one KDE bandwidth counts; KDE tails do not", () => {
    const m = spread(20, 20, 0.05); // ~19.5..20.5 °C
    assert.equal(membersNearBucket(m, 19.5, 20.5, "C", FUTURE), true);
    assert.equal(membersNearBucket(m, 21.5, 22.5, "C", FUTURE), true, "inside bandwidth (lead σ ≥ 0.7 °C)");
    assert.equal(membersNearBucket(m, 26.5, 27.5, "C", FUTURE), false);
    assert.equal(membersNearBucket([], 19.5, 20.5, "C", FUTURE), false);
    assert.equal(membersNearBucket(m, 66.5, 68.5, "F", FUTURE), true, "converted to the event unit");
  });

  it("valueInBucket is half-open like the settlement-rounded bounds; bucketMid handles open ends", () => {
    assert.equal(valueInBucket(19.5, 19.5, 20.5), true);
    assert.equal(valueInBucket(20.5, 19.5, 20.5), false);
    assert.equal(valueInBucket(-40, -Infinity, 0.5), true);
    assert.equal(bucketMid(19.5, 20.5), 20);
    assert.equal(bucketMid(-Infinity, 10.5), 10);
    assert.equal(bucketMid(30.5, Infinity), 31);
  });
});

describe("low markets: observed min mirrors observed max", () => {
  const members = spread(30, 10, 0.1); // daily-min members around 10 °C
  it("default kind is high and unchanged", () => {
    const a = bucketProbability(members, 9.5, 10.5, "C", FUTURE, null);
    const b = bucketProbability(members, 9.5, 10.5, "C", FUTURE, null, undefined, undefined, "high");
    assert.equal(a, b);
  });

  it("a low bucket wholly above the observed min is dead; the bucket holding it is renormalized", () => {
    const obs = 8.8; // already colder than the forecast lows
    assert.equal(bucketProbability(members, 9.5, 10.5, "C", FUTURE, obs, undefined, undefined, "low"), 0);
    assert.equal(bucketProbability(members, 10.5, Infinity, "C", FUTURE, obs, undefined, undefined, "low"), 0);
    // Bucket holding the obs: KDE mass on [lo, obs] renormalized by mass ≤ obs (mirror of the high rule).
    const cond = bucketProbability(members, 8.5, 9.5, "C", FUTURE, obs, undefined, undefined, "low");
    assert.ok(cond > 0 && cond <= 1, String(cond));
    assert.ok(bucketProbability(members, -Infinity, 8.5, "C", FUTURE, obs, undefined, undefined, "low") > 0);
    // High kind with the same obs would floor members instead (sanity: different answers).
    assert.notEqual(bucketProbability(members, 9.5, 10.5, "C", FUTURE, obs, undefined, undefined, "high"), 0);
  });

  it("observedMinForLocalDay: METAR at/before now, current local day only", () => {
    const now = Date.parse("2026-10-02T16:00:00Z"); // 12:00 EDT
    const reports = [
      { icaoId: "KNYC", obsTime: Date.parse("2026-10-02T03:00:00Z") / 1000, temp: 5 }, // 23:00 EDT prev day
      { icaoId: "KNYC", obsTime: Date.parse("2026-10-02T09:00:00Z") / 1000, temp: 11 }, // 05:00 EDT
      { icaoId: "KNYC", obsTime: Date.parse("2026-10-02T15:00:00Z") / 1000, temp: 17 },
      { icaoId: "KNYC", obsTime: Date.parse("2026-10-02T17:00:00Z") / 1000, temp: 2 }, // future
    ];
    assert.equal(observedMinForLocalDay(reports, "America/New_York", now), 11);
    assert.equal(observedMinForLocalDay([], "America/New_York", now), null);
  });

  it("observedForSignal: max for high, min for low, live local day only", () => {
    const w = wx({ localDate: "2026-10-02", observedMaxC: 24, observedMinC: 11 });
    assert.equal(observedForSignal(w, { date: "2026-10-02", kind: "high" }), 24);
    assert.equal(observedForSignal(w, { date: "2026-10-02", kind: "low" }), 11);
    assert.equal(observedForSignal(w, { date: "2026-10-03", kind: "low" }), null);
  });
});

describe("snapshot: low markets are priced from daily-MIN members", () => {
  it("membersForEvent picks the kind; lowDatesFor lists live low dates per city", () => {
    const w = wx({ membersByDate: { [FUTURE]: [30] }, membersMinByDate: { [FUTURE]: [10] } });
    assert.deepEqual(membersForEvent(w, FUTURE, "high"), [30]);
    assert.deepEqual(membersForEvent(w, FUTURE, "low"), [10]);
    assert.deepEqual(lowDatesFor([event("low", []), event("high", []), event("low", [], { eventDate: "2099-01-03" })]), {
      nyc: [FUTURE, "2099-01-03"],
    });
  });

  it("low event uses min members (not max), produces modelP, tradeable buckets and a modal YES", () => {
    // Observed min 11.2 °C so far (the forecast low of ~10 °C is still ahead).
    const w = wx({ localDate: TODAY, observedMinC: 11.2, membersByDate: { [TODAY]: spread(30, 25) }, membersMinByDate: { [TODAY]: spread(30, 10) } });
    const snap = assembleDeskSnapshot({ events: [event("low", ladder({ 10: 0.2 }), { eventDate: TODAY })], weather: { nyc: w } });
    const ev = snap.events[0];
    const b10 = ev.buckets.find((b) => b.label === "b10")!;
    const b18 = ev.buckets.find((b) => b.label === "b18")!;
    assert.ok(b10.modelP > 0.3, String(b10.modelP));
    assert.ok(b18.modelP < 0.01);
    assert.ok(Math.abs(ev.modelHigh! - 10) < 0.01, "model low = mean of min members");
    const yes = snap.signals.filter((s) => s.side === "YES");
    assert.equal(yes.length, 1);
    assert.equal(yes[0].label, "b10");
    assert.equal(yes[0].kind, "low");
  });

  it("low event with only daily-MAX members is not priced", () => {
    const w = wx({ membersByDate: { [FUTURE]: spread(30, 10) } });
    const snap = assembleDeskSnapshot({ events: [event("low", ladder({ 10: 0.2 }))], weather: { nyc: w } });
    assert.equal(snap.signals.length, 0);
    assert.ok(snap.events[0].buckets.every((b) => b.modelP === 0 && !b.tradeable));
  });

  it("live day: buckets above the observed min get modelP 0; observed shows the min", () => {
    const today = "2099-01-01";
    const w = wx({ localDate: today, observedMinC: 8, observedMaxC: 30, membersMinByDate: { [today]: spread(30, 10) } });
    const snap = assembleDeskSnapshot({ events: [event("low", ladder({}), { eventDate: today })], weather: { nyc: w } });
    const ev = snap.events[0];
    assert.equal(ev.observed, 8);
    for (const b of ev.buckets) if (b.lo > 8) assert.equal(b.modelP, 0, b.label);
    assert.ok(ev.buckets.find((b) => b.label === "b8")!.modelP > 0);
  });
});

describe("snapshot: live-day low without an observed min", () => {
  it("is priced for display but never tradeable (the low may already be set)", () => {
    const w = wx({ localDate: TODAY, observedMinC: null, membersMinByDate: { [TODAY]: spread(30, 10) } });
    const snap = assembleDeskSnapshot({ events: [event("low", ladder({ 10: 0.2 }), { eventDate: TODAY })], weather: { nyc: w } });
    assert.ok(snap.events[0].buckets.find((b) => b.label === "b10")!.modelP > 0.3);
    assert.ok(snap.events[0].buckets.every((b) => !b.tradeable));
    assert.equal(snap.signals.length, 0);
  });
});

describe("snapshot: near-certainty gate", () => {
  const w = wx({ localDate: TODAY, membersByDate: { [TODAY]: spread(30, 20) } });
  const hi = (prices: Record<number, number>) => event("high", ladder(prices, 14, 28), { eventDate: TODAY });

  it("YES only on the member-supported modal bucket; NO only on far buckets; YES sorts first", () => {
    // Crowd underprices the mode (20) and overprices a close bucket (22) and a far one (27).
    const snap = assembleDeskSnapshot({
      events: [hi({ 20: 0.2, 21: 0.3, 22: 0.3, 27: 0.3 })],
      weather: { nyc: w },
    });
    const yes = snap.signals.filter((s) => s.side === "YES");
    const no = snap.signals.filter((s) => s.side === "NO");
    assert.deepEqual(yes.map((s) => s.label), ["b20"]);
    assert.ok(no.some((s) => s.label === "b27"), "far bucket NO allowed");
    assert.ok(!no.some((s) => ["b20", "b21", "b22"].includes(s.label)), "no NO on close / supported buckets");
    assert.equal(snap.signals[0].side, "YES");
    const b22 = snap.events[0].buckets.find((b) => b.label === "b22")!;
    assert.equal(b22.edgeNo, 0);
  });

  it("no NO against an 80%+ crowd favorite even when far from the model", () => {
    const snap = assembleDeskSnapshot({ events: [hi({ 27: 0.85 })], weather: { nyc: w } });
    assert.ok(!snap.signals.some((s) => s.side === "NO" && s.label === "b27"));
  });

  it("KDE tail is not YES support: unsupported cheap bucket gets no YES edge", () => {
    const snap = assembleDeskSnapshot({ events: [hi({ 26: 0.03 })], weather: { nyc: w } });
    const b26 = snap.events[0].buckets.find((b) => b.label === "b26")!;
    assert.equal(b26.edgeYes, 0);
    assert.equal(b26.kellyYes, 0);
  });
});

describe("plausibility gate (ported rules)", () => {
  const sig = (over: Partial<Signal> = {}): Signal => ({
    id: "m-YES",
    eventId: "e",
    marketId: "m",
    cityId: "nyc",
    cityName: "New York City",
    date: FUTURE,
    kind: "high",
    unit: "C",
    question: "q",
    label: "20°C",
    side: "YES",
    marketP: 0.3,
    modelP: 0.5,
    edge: 0.2,
    kelly: 0.3,
    volume24hr: 0,
    ...over,
  });
  const members = spread(30, 20);

  it("YES without a member near the bucket is vetoed; supported YES passes", () => {
    assert.deepEqual(plausibilityVeto(sig(), { members, lo: 19.5, hi: 20.5 }), { ok: true });
    assert.equal(plausibilityVeto(sig(), { members, lo: 27.5, hi: 28.5 }).ok, false);
  });

  it("NO on a supported bucket, or on the bucket the observation sits in, is vetoed", () => {
    assert.equal(plausibilityVeto(sig({ side: "NO" }), { members, lo: 19.5, hi: 20.5 }).ok, false);
    assert.deepEqual(plausibilityVeto(sig({ side: "NO" }), { members, lo: 27.5, hi: 28.5 }), { ok: true });
    assert.equal(plausibilityVeto(sig({ side: "NO" }), { members, lo: 27.5, hi: 28.5, observedC: 28 }).ok, false);
  });

  it("low YES on a bucket wholly above the observed min is vetoed", () => {
    const low = sig({ kind: "low", label: "12°C" });
    const lowMembers = spread(30, 12);
    assert.equal(plausibilityVeto(low, { members: lowMembers, lo: 11.5, hi: 12.5, observedC: 10 }).ok, false);
    assert.deepEqual(plausibilityVeto(low, { members: lowMembers, lo: 11.5, hi: 12.5, observedC: 12 }), { ok: true });
  });
});

describe("paper book: ledger, tickets, YES floor", () => {
  const fill = (over: Partial<PaperFill>): PaperFill => ({
    id: Math.random().toString(36),
    eventId: "e",
    marketId: "m",
    cityId: "nyc",
    cityName: "New York City",
    date: FUTURE,
    question: "q",
    side: "YES",
    price: 0.4,
    shares: 25,
    cost: 10,
    modelP: 0.6,
    placedAt: new Date().toISOString(),
    status: "open",
    payout: 0,
    ...over,
  });

  it("cityLedger ranks by closed PnL then mark-to-model; tickets carry mark PnL", () => {
    const fills = [
      fill({ cityId: "nyc", status: "won", payout: 25 }), // +15 closed
      fill({ cityId: "nyc", side: "NO", status: "open" }), // mark 25*0.6-10 = +5
      fill({ cityId: "lon", cityName: "London", status: "lost", payout: 0 }), // -10 closed
      fill({ cityId: "tok", cityName: "Tokyo", status: "open", modelP: 0.8 }), // mark +10
    ];
    const rows = cityLedger(fills);
    assert.deepEqual(rows.map((r) => r.cityId), ["nyc", "tok", "lon"]);
    assert.deepEqual(
      { yes: rows[0].yes, no: rows[0].no, open: rows[0].open, won: rows[0].won, closed: rows[0].closedPnl, mark: rows[0].markPnl },
      { yes: 1, no: 1, open: 1, won: 1, closed: 15, mark: 20 },
    );
    assert.equal(rows[2].lost, 1);
    const t = fillTickets(fills);
    assert.equal(t.length, 4);
    assert.equal(t[1].pnl, fillMarkPnl(fills[1]));
    assert.equal(t[0].city, "New York City");
  });

  it("YES may fill from 3¢, NO still needs 5¢; one ticket per city-date", () => {
    const base = { ...emptyBook(), fills: [] as PaperFill[] };
    const s = (side: "YES" | "NO", p: number): Signal => ({
      id: `m-${side}`, eventId: "e", marketId: "m", cityId: "nyc", cityName: "NYC", date: FUTURE, kind: "high", unit: "C",
      question: "q", label: "20°C", side, marketP: p, modelP: 0.5, edge: 0.4, kelly: 0.5, volume24hr: 0,
    });
    assert.ok(paperTrade(s("YES", 0.04), base));
    assert.equal(paperTrade(s("NO", 0.04), base), null);
    assert.equal(PAPER_MAX_OPEN_PER_CITY_DATE, 1);
  });
});

describe("Open-Meteo: min only for live low cities, multi-model only as last resort", () => {
  let realFetch: typeof fetch;
  let calls: string[] = [];
  let ensMode: "ok" | "429" = "ok";
  let quiet: Array<[keyof Console, (...a: unknown[]) => void]> = [];
  beforeEach(() => {
    _setWeatherNextConfig(null);
    _resetWeatherNext();
    _resetCache();
    _resetEnsembleGuards();
    calls = [];
    ensMode = "ok";
    realFetch = globalThis.fetch;
    quiet = (["error", "warn", "log"] as const).map((k) => [k, console[k]]);
    for (const [k] of quiet) (console as unknown as Record<string, unknown>)[k] = () => {};
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      calls.push(url);
      const q = new URL(url).searchParams;
      const tz = q.get("timezone") ?? "UTC";
      const days = [0, 1].map((k) => new Intl.DateTimeFormat("en-CA", { timeZone: tz }).format(new Date(Date.now() + k * 86_400_000)));
      if (url.includes("ensemble-api.open-meteo.com")) {
        if (ensMode === "429") return new Response(JSON.stringify({ error: true }), { status: 429, statusText: "Too Many Requests" });
        const key = q.get("daily")!;
        const daily: Record<string, unknown[]> = { time: days, [key]: days.map(() => 10) };
        for (let i = 1; i <= 20; i++) daily[`${key}_member${String(i).padStart(2, "0")}`] = days.map(() => 10 + i * 0.1);
        return Response.json({ daily });
      }
      if (url.startsWith("https://api.open-meteo.com/v1/forecast")) {
        const daily: Record<string, unknown[]> = { time: days };
        for (const key of q.get("daily")!.split(",")) for (const m of q.get("models")!.split(",")) daily[`${key}_${m}`] = days.map(() => 12);
        return Response.json({ daily });
      }
      if (url.includes("previous-runs-api.open-meteo.com")) return Response.json({});
      if (url.includes("aviationweather.gov")) return Response.json([]);
      return new Response("{}", { status: 404 });
    }) as typeof fetch;
  });
  afterEach(() => {
    globalThis.fetch = realFetch;
    for (const [k, fn] of quiet) (console as unknown as Record<string, unknown>)[k] = fn;
    _setWeatherNextConfig(undefined);
    _resetEnsembleGuards();
    _resetCache();
  });
  const ens = () => calls.filter((u) => u.includes("ensemble-api"));
  const mm = () => calls.filter((u) => u.startsWith("https://api.open-meteo.com/v1/forecast"));

  it("no live low markets → max only (unchanged request shape), no min members", async () => {
    const wx = await loadWeather([nyc]);
    assert.equal(ens().length, 1);
    assert.match(ens()[0], /daily=temperature_2m_max&/);
    assert.deepEqual(wx.nyc.membersMinByDate, {});
    assert.equal(mm().length, 0);
  });

  it("live low market → one extra min request; cached per city like the max", async () => {
    const lowDates = { nyc: [new Intl.DateTimeFormat("en-CA", { timeZone: nyc.tz }).format(new Date())] };
    const wx = await loadWeather([nyc], { lowDates });
    assert.equal(ens().filter((u) => u.includes("temperature_2m_min")).length, 1);
    assert.ok(Object.values(wx.nyc.membersMinByDate).some((m) => m.length >= 8));
    await loadWeather([nyc], { lowDates });
    assert.equal(ens().length, 2, "second tick served from the per-city cache");
  });

  it("ensemble 429 with no last good → shared cooldown blocks the min request; multi-model fills in once", async () => {
    ensMode = "429";
    const lowDates = { nyc: [new Intl.DateTimeFormat("en-CA", { timeZone: nyc.tz }).format(new Date())] };
    const wx = await loadWeather([nyc], { lowDates });
    assert.equal(ens().length, 1, "429 on max → no min request into the cooldown");
    assert.equal(mm().length, 1);
    assert.match(mm()[0], /models=ecmwf_ifs025%2Cgfs_seamless/);
    assert.match(mm()[0], /daily=temperature_2m_max%2Ctemperature_2m_min/);
    assert.match(wx.nyc.source, /Open-Meteo multi-model/);
    assert.ok(Object.values(wx.nyc.membersByDate).some((m) => m.length === 8));
    assert.ok(Object.values(wx.nyc.membersMinByDate).some((m) => m.length === 8));
    await loadWeather([nyc], { lowDates });
    assert.equal(ens().length, 1, "still cooling down");
    assert.equal(mm().length, 1, "multi-model cached per city (30 min)");
  });
});

describe("headless paper arm", () => {
  let dir: string;
  const saved: Record<string, string | undefined> = {};
  let realFetch: typeof fetch;
  const keys = ["ISOBAR_DATA_DIR", "ISOBAR_PAPER_ARMED", "ISOBAR_LIVE"];
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "isobar-arm-"));
    for (const k of keys) saved[k] = process.env[k];
    process.env.ISOBAR_DATA_DIR = dir;
    delete process.env.ISOBAR_LIVE;
    _resetPaperBookCache();
    _resetCache();
    realFetch = globalThis.fetch;
    globalThis.fetch = (async () => Response.json([])) as typeof fetch; // no Gamma events
    savePaperBook(emptyBook());
  });
  afterEach(() => {
    for (const k of keys) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    globalThis.fetch = realFetch;
    _resetPaperBookCache();
    rmSync(dir, { recursive: true, force: true });
  });

  it("ISOBAR_PAPER_ARMED=false (Railway) leaves the book disarmed", async () => {
    process.env.ISOBAR_PAPER_ARMED = "false";
    await tickPaperWorker();
    assert.equal(loadPaperBook({ refresh: true }).settings.armed, false);
  });

  it("ISOBAR_PAPER_ARMED=true arms the paper book; ISOBAR_LIVE always wins", async () => {
    process.env.ISOBAR_PAPER_ARMED = "true";
    const log = console.log;
    console.log = () => {};
    try {
      await tickPaperWorker();
      assert.equal(loadPaperBook({ refresh: true }).settings.armed, true);
      process.env.ISOBAR_LIVE = "true";
      await tickPaperWorker();
      assert.equal(loadPaperBook({ refresh: true }).settings.armed, false);
    } finally {
      console.log = log;
    }
  });
});
