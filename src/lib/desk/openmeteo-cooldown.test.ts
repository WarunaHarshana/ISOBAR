import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { HttpError, _resetCache } from "./cache.ts";
import { parseRetryAfter, planCooldown } from "./cooldown.ts";
import {
  ENSEMBLE_MIN_REFRESH_MS,
  FORECAST_REFRESH_MS,
  _resetEnsembleGuards,
  ensembleCallWeight,
  ensembleRefreshMs,
  loadWeather,
} from "./weather.ts";
import { _resetWeatherNext, _setWeatherNextConfig } from "./weathernext.ts";
import type { CityMeta } from "./types.ts";

const nyc: CityMeta = {
  id: "nyc",
  name: "New York City",
  aliases: [],
  lat: 40.7829,
  lon: -73.9654,
  tz: "America/New_York",
  icao: "KNYC",
  country: "US",
};

function json(body: unknown, status = 200, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), {
    status,
    statusText: status === 200 ? "OK" : status === 429 ? "Too Many Requests" : "ERR",
    headers: { "content-type": "application/json", ...headers },
  });
}

function ensembleBody(tz: string) {
  const d = new Intl.DateTimeFormat("en-CA", { timeZone: tz }).format(new Date(Date.now()));
  const daily: Record<string, Array<number | string>> = { time: [d], temperature_2m_max: [20] };
  for (let i = 1; i < 10; i++)
    daily[`temperature_2m_max_member${String(i).padStart(2, "0")}`] = [20 + i * 0.1];
  return { latitude: 0, longitude: 0, daily };
}

const forecastBody = {
  current: {
    time: "2026-10-02T12:00",
    temperature_2m: 21,
    relative_humidity_2m: 50,
    wind_speed_10m: 3,
    weather_code: 1,
  },
  hourly: { time: ["2026-10-02T00:00"], temperature_2m: [21] },
  daily: { time: ["2026-10-02"], temperature_2m_max: [25], temperature_2m_min: [15] },
};

let realFetch: typeof fetch;
let realNow: () => number;
let clock = 0;
let calls: string[] = [];
let logs: string[] = [];
let origErr: typeof console.error;
let origWarn: typeof console.warn;
let origLog: typeof console.log;

type Mode = "ok" | "429" | "429-ra" | "503";
let ensMode: Mode = "ok";
let fcMode: Mode = "ok";

function respond(mode: Mode, ok: () => Response) {
  if (mode === "429")
    return json(
      {
        error: true,
        reason: "Hourly API request limit exceeded. Please try again in the next hour.",
      },
      429,
    );
  if (mode === "429-ra")
    return json({ error: true, reason: "Too many concurrent requests" }, 429, {
      "retry-after": "120",
    });
  if (mode === "503") return json({ error: true }, 503);
  return ok();
}

beforeEach(() => {
  _setWeatherNextConfig(null);
  _resetWeatherNext();
  _resetCache();
  _resetEnsembleGuards();
  calls = [];
  logs = [];
  ensMode = "ok";
  fcMode = "ok";
  realFetch = globalThis.fetch;
  realNow = Date.now;
  clock = Date.parse("2026-10-02T06:10:00Z");
  Date.now = () => clock;
  origErr = console.error;
  origWarn = console.warn;
  origLog = console.log;
  const sink = (...a: unknown[]) => void logs.push(a.map(String).join(" "));
  console.error = sink;
  console.warn = sink;
  console.log = sink;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    calls.push(url);
    if (url.includes("ensemble-api.open-meteo.com")) {
      return respond(ensMode, () =>
        json(ensembleBody(new URL(url).searchParams.get("timezone") ?? "UTC")),
      );
    }
    if (url.includes("previous-runs-api.open-meteo.com"))
      return respond(fcMode, () => json(forecastBody));
    if (url.includes("aviationweather.gov")) return json([]);
    return json({}, 404);
  }) as typeof fetch;
});

afterEach(() => {
  _setWeatherNextConfig(undefined);
  globalThis.fetch = realFetch;
  Date.now = realNow;
  console.error = origErr;
  console.warn = origWarn;
  console.log = origLog;
  _resetCache();
  _resetEnsembleGuards();
});

const ens = () => calls.filter((u) => u.includes("ensemble-api"));
const fc = () => calls.filter((u) => u.includes("previous-runs-api"));
const cooldownLines = (name: string) =>
  logs.filter((l) => l.includes(`${name} HTTP 429`) && l.includes("cooling down"));

describe("Open-Meteo call weight and cadence", () => {
  it("ensemble weight follows Open-Meteo's formula (1 daily var × 51 members / 10 per city)", () => {
    assert.equal(ensembleCallWeight(1), 5.1);
    assert.ok(Math.abs(ensembleCallWeight(48) - 244.8) < 1e-9);
  });

  it("refresh interval is ≥ 30 min and keeps a 48-city fallback under ~6000 weighted calls/day", () => {
    assert.equal(ensembleRefreshMs(1), ENSEMBLE_MIN_REFRESH_MS);
    const ms48 = ensembleRefreshMs(48);
    assert.ok(ms48 > 55 * 60_000 && ms48 < 65 * 60_000, String(ms48));
    assert.ok((86_400_000 / ms48) * ensembleCallWeight(48) <= 6000 + 1e-6);
  });

  it("ensemble and forecast are cached per city and only re-requested after their interval", async () => {
    await loadWeather([nyc]);
    assert.equal(ens().length, 1);
    assert.equal(fc().length, 1);
    assert.match(ens()[0], /daily=temperature_2m_max&/);
    clock += 10 * 60_000;
    const wx = await loadWeather([nyc]);
    assert.equal(ens().length, 1, "no ensemble call inside the refresh interval");
    assert.equal(fc().length, 1, "no forecast call inside the refresh interval");
    assert.ok(wx.nyc.source.includes("Open-Meteo ensemble"));
    assert.ok(wx.nyc.source.includes("Open-Meteo forecast"));
    clock += Math.max(ENSEMBLE_MIN_REFRESH_MS, FORECAST_REFRESH_MS);
    await loadWeather([nyc]);
    assert.equal(ens().length, 2);
    assert.equal(fc().length, 2);
  });
});

describe("Open-Meteo 429 cooldown", () => {
  it("parseRetryAfter handles seconds and HTTP dates", () => {
    const now = Date.parse("2026-10-02T06:00:00Z");
    assert.equal(parseRetryAfter("120", now), 120_000);
    assert.equal(parseRetryAfter("Fri, 02 Oct 2026 06:05:00 GMT", now), 300_000);
    assert.equal(parseRetryAfter(null, now), null);
    assert.equal(parseRetryAfter("soon", now), null);
  });

  it("honours Retry-After (+≤10 % jitter), else exponential backoff with jitter and a cap", () => {
    const now = Date.parse("2026-10-02T06:10:00Z");
    const ra = planCooldown({ strike: 1, retryAfter: "120", now, random: () => 0.99 });
    assert.ok(ra.ms >= 120_000 && ra.ms <= 132_000, String(ra.ms));
    const lo = (s: number) => planCooldown({ strike: s, now, random: () => 0 }).ms;
    const hi = (s: number) => planCooldown({ strike: s, now, random: () => 0.999 }).ms;
    assert.equal(lo(1), 45_000);
    assert.ok(hi(1) < 75_000);
    assert.equal(lo(2), 90_000);
    assert.equal(lo(3), 180_000);
    assert.ok(hi(20) <= 75 * 60_000, "capped near 1 h");
    // Open-Meteo's reason text raises the floor.
    const hourly = planCooldown({
      strike: 1,
      reason: "Hourly API request limit exceeded",
      now,
      random: () => 0,
    });
    assert.equal(hourly.ms, 50 * 60_000, "waits for the next UTC hour");
    const daily = planCooldown({
      strike: 1,
      reason: "Daily API request limit exceeded",
      now,
      random: () => 0,
    });
    assert.equal(daily.ms, 30 * 60_000);
  });

  it("HttpError keeps the status/reason/Retry-After and the old message shape", () => {
    const e = new HttpError(
      429,
      "Too Many Requests",
      "60",
      "Minutely API request limit exceeded",
      "https://x",
    );
    assert.match(
      e.message,
      /^429 Too Many Requests retry-after=60 \(Minutely API request limit exceeded\) for https:\/\/x$/,
    );
  });

  it("429 → one log line, no requests during the cooldown, last good data kept; recovery logged once", async () => {
    await loadWeather([nyc]);
    const good = (await loadWeather([nyc])).nyc.membersByDate;
    assert.ok(Object.values(good).some((m) => m.length >= 8));
    // Refresh due, endpoint now rate-limits with Retry-After: 120.
    clock += ENSEMBLE_MIN_REFRESH_MS + 1;
    ensMode = "429-ra";
    const before = ens().length;
    let wx = await loadWeather([nyc]);
    assert.equal(ens().length, before + 1);
    assert.deepEqual(wx.nyc.membersByDate, good, "last good members still served");
    assert.ok(wx.nyc.source.includes("Open-Meteo ensemble"));
    assert.equal(cooldownLines("Open-Meteo ensemble").length, 1);
    assert.match(
      cooldownLines("Open-Meteo ensemble")[0],
      /retry-after 120.*serving last good data for 1\/1 cities/,
    );
    // Paper-worker ticks inside the cooldown: no requests, no new log lines.
    const logCount = logs.length;
    for (let i = 0; i < 4; i++) {
      clock += 25_000;
      wx = await loadWeather([nyc]);
    }
    assert.equal(ens().length, before + 1, "no ensemble calls while cooling down");
    assert.equal(logs.length, logCount, "silent while cooling down");
    assert.deepEqual(wx.nyc.membersByDate, good);
    // Cooldown over (120 s + jitter < 132 s), endpoint healthy again.
    clock += 60_000;
    ensMode = "ok";
    await loadWeather([nyc]);
    assert.equal(ens().length, before + 2);
    assert.equal(logs.filter((l) => l.includes("Open-Meteo ensemble recovered")).length, 1);
  });

  it("without Retry-After the next cooldown backs off further (strike 2)", async () => {
    ensMode = "429";
    fcMode = "ok";
    await loadWeather([nyc]);
    assert.equal(ens().length, 1);
    assert.match(cooldownLines("Open-Meteo ensemble")[0], /backoff #1/);
    clock += 61 * 60_000; // past the hourly-limit floor
    await loadWeather([nyc]);
    assert.equal(ens().length, 2);
    assert.equal(cooldownLines("Open-Meteo ensemble").length, 2);
    assert.match(cooldownLines("Open-Meteo ensemble")[1], /backoff #2/);
  });

  it("forecast 429 cools down that endpoint only, skips the second URL and keeps the last good forecast", async () => {
    await loadWeather([nyc]);
    assert.equal(fc().length, 1);
    clock += FORECAST_REFRESH_MS + 1;
    fcMode = "429-ra";
    const wx = await loadWeather([nyc]);
    assert.equal(fc().length, 2, "one request, the fallback URL is not fired into a 429");
    assert.ok(wx.nyc.source.includes("Open-Meteo forecast"));
    assert.equal(wx.nyc.humidity, 50);
    assert.equal(cooldownLines("Open-Meteo forecast").length, 1);
    assert.equal(cooldownLines("Open-Meteo ensemble").length, 0);
    clock += 30_000;
    await loadWeather([nyc]);
    assert.equal(fc().length, 2);
  });

  it("a persistent non-429 failure is logged once and retried at most every 2 min", async () => {
    ensMode = "503";
    for (let i = 0; i < 4; i++) {
      await loadWeather([nyc]);
      clock += 25_000;
    }
    // 1 request + 1 transient retry, then held off.
    assert.equal(ens().length, 2);
    assert.equal(logs.filter((l) => l.includes("ensemble unavailable")).length, 1);
  });
});
