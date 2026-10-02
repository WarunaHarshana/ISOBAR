import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseBucket, settlementRule } from "./parse.ts";
import { CITIES, resolveCity } from "./cities.ts";
import { bucketProbability, leadSigmaC } from "./math.ts";
import { assembleDeskSnapshot, observedForSignal } from "./snapshot.ts";
import { plausibilityVeto } from "./plausibility.ts";
import { _resetCache } from "./cache.ts";
import {
  _resetEnsembleGuards,
  ensembleKey,
  hoursSinceLocalMidnight,
  loadWeather,
  metarRetryable,
  observedMaxForLocalDay,
} from "./weather.ts";
import { _resetWeatherNext, _setWeatherNextConfig } from "./weathernext.ts";
import type { CityMeta, Signal, WeatherNow } from "./types.ts";
import type { ParsedEvent } from "./polymarket.ts";

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

// Excerpts of real Gamma descriptions (Oct 2026).
const NOAA_DESC =
  'This market will resolve to the temperature range that contains the highest temperature recorded by NOAA at the LaGuardia Airport Station in degrees Fahrenheit on 1 Oct \'26. ... The resolution source for this market measures temperatures to whole degrees Fahrenheit (eg, 21°F).';
const HKO_DESC =
  'This market will resolve to the temperature range that contains the highest temperature recorded by the Hong Kong Observatory in degrees Celsius ... The resolution source for this market measures temperatures in Celsius to one decimal place (eg, 9.1°C).';

describe("#1 bucket edges match settlement rounding", () => {
  it("rule comes from the description", () => {
    assert.equal(settlementRule(NOAA_DESC), "round");
    assert.equal(settlementRule(HKO_DESC), "floor");
    assert.equal(settlementRule(undefined), "round");
  });

  it("whole-degree (NOAA/WU) buckets are centred on the integer", () => {
    const q = (s: string) => parseBucket(s, null, "round")!;
    assert.deepEqual([q("Will the highest temperature in NYC be between 72-73°F on October 2?").lo, q("Will the highest temperature in NYC be between 72-73°F on October 2?").hi], [71.5, 73.5]);
    const exact = q("Will the highest temperature in Tokyo be 23°C on October 2?");
    assert.deepEqual([exact.lo, exact.hi], [22.5, 23.5]);
    const below = q("Will the highest temperature in NYC be 71°F or below on October 2?");
    assert.deepEqual([below.lo, below.hi], [-Infinity, 71.5]);
    const above = q("Will the highest temperature in Tokyo be 30°C or higher on October 2?");
    assert.deepEqual([above.lo, above.hi], [29.5, Infinity]);
    const neg = q("Will the highest temperature in Helsinki be -3°C on January 5?");
    assert.deepEqual([neg.lo, neg.hi], [-3.5, -2.5]);
  });

  it("HKO one-decimal buckets truncate: 28°C = [28, 29)", () => {
    const b = parseBucket("Will the highest temperature in Hong Kong be 28°C on October 2?", null, "floor")!;
    assert.deepEqual([b.lo, b.hi], [28, 29]);
    const below = parseBucket("Will the highest temperature in Hong Kong be 24°C or below on October 2?", null, "floor")!;
    assert.equal(below.hi, 25);
  });

  it("real settled examples land in the winning bucket", () => {
    // KMIA 2026-09-29: METAR max 28.3 °C = 82.9 °F → winner "82-83°F"
    const f = (28.3 * 9) / 5 + 32;
    const win = parseBucket("Will the highest temperature in Miami be between 82-83°F on September 29?", null, "round")!;
    const lose = parseBucket("Will the highest temperature in Miami be between 84-85°F on September 29?", null, "round")!;
    assert.ok(f >= win.lo && f < win.hi);
    assert.ok(!(f >= lose.lo && f < lose.hi));
    // HKO 2026-08-04 Absolute Daily Max 32.5 → winner "32°C"
    const hk = parseBucket("Will the highest temperature in Hong Kong be 32°C on August 4?", null, "floor")!;
    assert.ok(32.5 >= hk.lo && 32.5 < hk.hi);
  });

  it("probability mass sits on the rounded bucket: members all at 23.2 °C → '23°C' not '22°C'", () => {
    const members = Array(20).fill(23.2);
    const b23 = parseBucket("Will the highest temperature in Tokyo be 23°C on October 9?", null, "round")!;
    const b22 = parseBucket("Will the highest temperature in Tokyo be 22°C on October 9?", null, "round")!;
    const p23 = bucketProbability(members, b23.lo, b23.hi, "C", "2026-10-09", null, "Asia/Tokyo", new Date("2026-10-09T00:00:00Z"));
    const p22 = bucketProbability(members, b22.lo, b22.hi, "C", "2026-10-09", null, "Asia/Tokyo", new Date("2026-10-09T00:00:00Z"));
    assert.ok(p23 > p22 * 1.5, `p23=${p23} p22=${p22}`);
  });

  it("plausibility label fallback uses the rounded interval", () => {
    const sig = { side: "YES", kind: "high", unit: "C", label: "23°C", modelP: 0, cityId: "tokyo", cityName: "Tokyo", date: "2026-10-02" } as Signal;
    // a member at 22.6 rounds to 23 → bucket is not empty → no "no members" veto
    assert.deepEqual(plausibilityVeto(sig, { members: Array(8).fill(22.6) }), { ok: true });
  });
});

describe("#3 forecast coordinates = settlement station", () => {
  const byId = (id: string) => CITIES.find((c) => c.id === id)!;
  it("stations named in current Polymarket rules", () => {
    const expect: Record<string, string> = {
      nyc: "KLGA", london: "EGLC", paris: "LFPB", dallas: "KDAL", houston: "KHOU", denver: "KBKF",
      moscow: "UUWW", "sao-paulo": "SBGR", taipei: "RCSS", qingdao: "ZSQD", tokyo: "RJTT", "buenos-aires": "SAEZ", "panama-city": "MPMG",
    };
    for (const [id, icao] of Object.entries(expect)) assert.equal(byId(id).icao, icao, id);
    // LaGuardia, not Central Park
    assert.ok(Math.abs(byId("nyc").lat - 40.779) < 0.01 && Math.abs(byId("nyc").lon + 73.88) < 0.01);
    // Hong Kong settles on the Observatory: HKO coordinates, no METAR
    assert.equal(byId("hong-kong").icao, "");
    assert.ok(Math.abs(byId("hong-kong").lat - 22.302) < 0.01);
  });

  it("every desk city has finite station coords and a source tag", () => {
    for (const c of CITIES) {
      assert.ok(Number.isFinite(c.lat) && Number.isFinite(c.lon) && (c.lat !== 0 || c.lon !== 0), c.id);
      assert.ok(c.settlementSource, c.id);
      if (c.settlementSource !== "hko") assert.match(c.icao, /^[A-Z]{4}$/, c.id);
    }
    assert.equal(resolveCity("Buenos Aires")?.id, "buenos-aires");
    assert.equal(resolveCity("Panama City")?.id, "panama-city");
  });
});

describe("#4 leadSigmaC uses the city's local date", () => {
  it("Tokyo just after local midnight: event 'today' locally is today, not tomorrow", () => {
    const now = new Date("2026-10-01T16:00:00Z"); // 01:00 JST Oct 2
    assert.equal(leadSigmaC("2026-10-02", now, "Asia/Tokyo"), 0.55);
    assert.ok(leadSigmaC("2026-10-02", now) > 0.55); // UTC view says tomorrow
  });
  it("Los Angeles evening: tomorrow locally is tomorrow, not today", () => {
    const now = new Date("2026-10-02T03:00:00Z"); // 20:00 PDT Oct 1
    assert.ok(Math.abs(leadSigmaC("2026-10-02", now, "America/Los_Angeles") - 1.05) < 1e-9);
    assert.equal(leadSigmaC("2026-10-02", now), 0.55);
  });
});

const nyc: CityMeta = { id: "nyc", name: "NYC", aliases: [], lat: 40.779, lon: -73.88, tz: "America/New_York", icao: "KLGA", country: "US" };
const tokyo: CityMeta = { id: "tokyo", name: "Tokyo", aliases: [], lat: 35.553, lon: 139.781, tz: "Asia/Tokyo", icao: "RJTT", country: "JP" };
const hk: CityMeta = { id: "hong-kong", name: "Hong Kong", aliases: [], lat: 22.3022, lon: 114.1742, tz: "Asia/Hong_Kong", icao: "", country: "HK" };

describe("#2 observed max = real METAR at/before now in the local day", () => {
  it("observedMaxForLocalDay drops future reports and yesterday's reports", () => {
    const now = Date.parse("2026-10-01T20:00:00Z"); // 16:00 EDT
    const r = (iso: string, temp: number) => ({ icaoId: "KLGA", obsTime: Date.parse(iso) / 1000, temp });
    const reports = [
      r("2026-10-01T03:51:00Z", 30), // 23:51 EDT Sep 30 → yesterday
      r("2026-10-01T12:51:00Z", 20.6),
      r("2026-10-01T18:51:00Z", 25.6),
      r("2026-10-01T21:51:00Z", 31), // future
    ];
    assert.equal(observedMaxForLocalDay(reports, "America/New_York", now), 25.6);
    assert.equal(observedMaxForLocalDay([], "America/New_York", now), null);
  });

  it("hours window covers local midnight → now", () => {
    const now = Date.parse("2026-10-01T20:30:00Z");
    assert.equal(hoursSinceLocalMidnight("America/New_York", now), 18); // 16:30 local → 17 + 1
    assert.equal(hoursSinceLocalMidnight("Asia/Tokyo", now), 7); // 05:30 local → 6 + 1
  });

  let realFetch: typeof fetch;
  beforeEach(() => {
    _setWeatherNextConfig(null);
    _resetWeatherNext();
    _resetCache();
    _resetEnsembleGuards();
    realFetch = globalThis.fetch;
  });
  afterEach(() => {
    _setWeatherNextConfig(undefined);
    globalThis.fetch = realFetch;
    _resetCache();
    _resetEnsembleGuards();
  });

  it("loadWeather: observedMaxC is METAR max so far, never a hotter forecast hour; HKO city → null", async () => {
    const now = Date.now();
    const metarUrls: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("aviationweather.gov")) {
        metarUrls.push(url);
        return json([
          { icaoId: "KLGA", obsTime: Math.floor((now - 60_000) / 1000), temp: 18.3 },
          { icaoId: "KLGA", obsTime: Math.floor((now - 10 * 60_000) / 1000), temp: 19.4 },
          { icaoId: "KLGA", obsTime: Math.floor((now + 3600_000) / 1000), temp: 40 }, // bogus future row
        ]);
      }
      if (url.includes("previous-runs-api")) {
        // forecast says 35 °C for every hour today — must NOT become "observed"
        const d = new Intl.DateTimeFormat("en-CA", { timeZone: nyc.tz }).format(new Date(now));
        const times = Array.from({ length: 24 }, (_, h) => `${d}T${String(h).padStart(2, "0")}:00`);
        return json([
          { current: { temperature_2m: 35 }, hourly: { time: times, temperature_2m: times.map(() => 35) }, daily: { time: [d], temperature_2m_max: [35] } },
          { current: { temperature_2m: 30 }, hourly: { time: times, temperature_2m: times.map(() => 30) }, daily: { time: [d], temperature_2m_max: [30] } },
        ]);
      }
      return json({ error: true }, 503);
    }) as typeof fetch;
    const orig = console.error;
    console.error = () => {};
    try {
      const wx = await loadWeather([nyc, hk]);
      const localMidnightOk = observedMaxForLocalDay(
        [{ icaoId: "KLGA", obsTime: Math.floor((now - 10 * 60_000) / 1000), temp: 19.4 }],
        nyc.tz,
        now,
      );
      // 10 minutes ago may be yesterday right after local midnight; otherwise 19.4.
      assert.equal(wx.nyc.observedMaxC, localMidnightOk == null ? 18.3 : 19.4);
      assert.equal(wx["hong-kong"].observedMaxC, null);
      assert.ok(metarUrls.every((u) => /hours=\d+/.test(u) && !u.includes("ids=,")));
    } finally {
      console.error = orig;
    }
  });

  it("splits a METAR batch that hits the 400-row cap", async () => {
    const seen: string[] = [];
    const cities: CityMeta[] = ["KAAA", "KBBB", "KCCC", "KDDD"].map((icao, i) => ({ ...nyc, id: `c${i}`, icao }));
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("aviationweather.gov")) {
        const ids = new URL(url).searchParams.get("ids")!.split(",");
        seen.push(ids.join(","));
        const rows = ids.length > 1 ? Array.from({ length: 400 }, () => ({ icaoId: ids[0], obsTime: 0, temp: 0 })) : [{ icaoId: ids[0], obsTime: Math.floor(Date.now() / 1000) - 60, temp: 12 }];
        return json(rows);
      }
      return json({ error: true }, 503);
    }) as typeof fetch;
    const orig = console.error;
    console.error = () => {};
    try {
      const wx = await loadWeather(cities);
      for (const c of cities) assert.equal(wx[c.id].observedMaxC, 12, c.id);
      assert.ok(seen.includes("KAAA") && seen.includes("KDDD"));
    } finally {
      console.error = orig;
    }
  });

  it("METAR: retries an aborted / 5xx attempt and sends a descriptive User-Agent", async () => {
    let calls = 0;
    const agents: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("aviationweather.gov")) {
        calls++;
        agents.push(String((init?.headers as Record<string, string>)["user-agent"]));
        if (calls === 1) throw new DOMException("This operation was aborted", "AbortError");
        if (calls === 2) return json({ error: "busy" }, 502);
        return json([{ icaoId: "KLGA", obsTime: Math.floor(Date.now() / 1000) - 60, temp: 21 }]);
      }
      return json({ error: true }, 503);
    }) as typeof fetch;
    const orig = console.error;
    console.error = () => {};
    try {
      const wx = await loadWeather([nyc]);
      assert.equal(calls, 3);
      assert.equal(wx.nyc.observedMaxC, 21);
      assert.ok(agents.every((a) => a.startsWith("IsobarDesk/") && a.includes("+https://")), agents.join(" | "));
    } finally {
      console.error = orig;
    }
  });

  it("METAR: a batch that keeps failing keeps each station's last good observed max", async () => {
    let down = false;
    let calls = 0;
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("aviationweather.gov")) {
        calls++;
        if (down) throw new DOMException("This operation was aborted", "AbortError");
        return json([{ icaoId: "KLGA", obsTime: Math.floor(Date.now() / 1000) - 60, temp: 23.3 }]);
      }
      return json({ error: true }, 503);
    }) as typeof fetch;
    const orig = console.error;
    const errors: string[] = [];
    console.error = (...a: unknown[]) => void errors.push(a.join(" "));
    try {
      assert.equal((await loadWeather([nyc])).nyc.observedMaxC, 23.3);
      _resetCache();
      down = true;
      calls = 0;
      const wx = await loadWeather([nyc]);
      assert.equal(calls, 3, "3 attempts before giving up");
      assert.equal(wx.nyc.observedMaxC, 23.3);
      assert.ok(errors.some((e) => e.includes("METAR history batch failed") && e.includes("kept last good for 1/1")));
    } finally {
      console.error = orig;
    }
  });

  it("METAR: 4xx is not retried; at most 3 requests in flight", async () => {
    assert.equal(metarRetryable(new Error("400 Bad Request for x")), false);
    assert.equal(metarRetryable(new Error("429 Too Many Requests for x")), true);
    assert.equal(metarRetryable(new Error("503 Service Unavailable for x")), true);
    assert.equal(metarRetryable(new TypeError("fetch failed")), true);
    let inflight = 0;
    let peak = 0;
    const cities: CityMeta[] = Array.from({ length: 30 }, (_, i) => ({ ...nyc, id: `s${i}`, icao: `K${String(i).padStart(3, "0")}` }));
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("aviationweather.gov")) {
        inflight++;
        peak = Math.max(peak, inflight);
        await new Promise((r) => setTimeout(r, 15));
        inflight--;
        const ids = new URL(url).searchParams.get("ids")!.split(",");
        return json(ids.map((id) => ({ icaoId: id, obsTime: Math.floor(Date.now() / 1000) - 60, temp: 10 })));
      }
      return json({ error: true }, 503);
    }) as typeof fetch;
    const orig = console.error;
    console.error = () => {};
    try {
      const wx = await loadWeather(cities);
      assert.ok(peak <= 3, `peak ${peak}`);
      for (const c of cities) assert.equal(wx[c.id].observedMaxC, 10, c.id);
    } finally {
      console.error = orig;
    }
  });

  it("observedForSignal: only HIGH signals on the city's current local date", () => {
    const wx = { localDate: "2026-10-02", observedMaxC: 24 } as WeatherNow;
    assert.equal(observedForSignal(wx, { date: "2026-10-02", kind: "high" }), 24);
    assert.equal(observedForSignal(wx, { date: "2026-10-03", kind: "high" }), null);
    assert.equal(observedForSignal(wx, { date: "2026-10-02", kind: "low" }), null);
  });
});

describe("#5 Open-Meteo single-flight is per city set", () => {
  let realFetch: typeof fetch;
  beforeEach(() => {
    _setWeatherNextConfig(null);
    _resetWeatherNext();
    _resetCache();
    _resetEnsembleGuards();
    realFetch = globalThis.fetch;
  });
  afterEach(() => {
    _setWeatherNextConfig(undefined);
    globalThis.fetch = realFetch;
  });

  it("ensembleKey is order-insensitive and distinct per set", () => {
    assert.equal(ensembleKey([nyc, tokyo]), ensembleKey([tokyo, nyc]));
    assert.notEqual(ensembleKey([nyc]), ensembleKey([tokyo]));
  });

  it("concurrent loadWeather for different cities each get their own members", async () => {
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("ensemble-api")) {
        await new Promise((r) => setTimeout(r, 30));
        const tz = new URL(url).searchParams.get("timezone")!;
        const d = new Intl.DateTimeFormat("en-CA", { timeZone: tz }).format(new Date());
        const base = tz === "Asia/Tokyo" ? 25 : 15;
        const daily: Record<string, unknown[]> = { time: [d], temperature_2m_max: [base] };
        for (let i = 1; i < 10; i++) daily[`temperature_2m_max_member0${i}`] = [base + i * 0.1];
        return json({ latitude: 0, longitude: 0, daily });
      }
      if (url.includes("aviationweather.gov")) return json([]);
      return json({ error: true }, 503);
    }) as typeof fetch;
    const orig = console.error;
    console.error = () => {};
    try {
      const [a, b] = await Promise.all([loadWeather([nyc]), loadWeather([tokyo])]);
      assert.ok(a.nyc.membersC.length >= 8);
      assert.ok(b.tokyo.membersC.length >= 8, "tokyo must not receive nyc's in-flight result");
      assert.ok(b.tokyo.membersC.every((m) => m >= 25));
    } finally {
      console.error = orig;
    }
  });
});

describe("low-temperature events are not priced with daily-max members", () => {
  it("kind=low with only daily-MAX members → no tradeable buckets, no signals", () => {
    const wx = {
      tempC: 20, humidity: null, windMs: null, weatherCode: null, cover: null, station: null, observedAt: null,
      observedMaxC: null, observedMinC: null, modelMeanC: 20, modelStdC: 1, modelMinC: 18, modelMaxC: 22,
      membersC: [], membersByDate: { "2099-01-02": Array.from({ length: 20 }, (_, i) => 18 + i * 0.2) }, membersMinByDate: {},
      localDate: "2099-01-01", hourly: [], source: "test",
    } as WeatherNow;
    const ev: ParsedEvent = {
      eventId: "e", slug: "s", title: "Lowest temperature in NYC", city: nyc, cityRaw: "NYC", kind: "low", unit: "C",
      eventDate: "2099-01-02", endDate: "", volume: 0, volume24hr: 0, liquidity: 0, image: null, context: null, settlement: "round",
      markets: [{ id: "m", question: "q", bound: { lo: 18.5, hi: 19.5, label: "19°C", kind: "exact" }, yesPrice: 0.1, noPrice: 0.9, tokens: [] }],
    };
    const snap = assembleDeskSnapshot({ events: [ev], weather: { nyc: wx } });
    assert.equal(snap.signals.length, 0);
    assert.equal(snap.events[0].buckets[0].tradeable, false);
    assert.equal(snap.events[0].buckets[0].modelP, 0);
  });
});
