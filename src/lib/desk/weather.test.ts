import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { _resetCache } from "./cache.ts";
import { _resetEnsembleGuards, ensembleRequestUrl, loadWeather, MULTI_MODELS } from "./weather.ts";
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

const bos: CityMeta = {
  id: "boston",
  name: "Boston",
  aliases: [],
  lat: 42.3601,
  lon: -71.0589,
  tz: "America/New_York",
  icao: "KBOS",
  country: "US",
};

const tokyo: CityMeta = {
  id: "tokyo",
  name: "Tokyo",
  aliases: [],
  lat: 35.6762,
  lon: 139.6503,
  tz: "Asia/Tokyo",
  icao: "RJTT",
  country: "JP",
};

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    statusText: status === 200 ? "OK" : status === 429 ? "Too Many Requests" : "ERR",
    headers: { "content-type": "application/json" },
  });
}

function ensembleBody(dates: string[], valuesByDate: number[], n = 8) {
  const daily: Record<string, Array<number | string | null>> = { time: dates };
  const maxAt = (i: number) => valuesByDate[i] ?? valuesByDate[0] ?? 20;
  const maxSeries = (offset: number) => dates.map((_, i) => maxAt(i) + offset);
  const minSeries = (offset: number) => dates.map((_, i) => maxAt(i) - 8 + offset);
  daily.temperature_2m_max = maxSeries(0);
  for (let i = 1; i < n; i++) {
    daily[`temperature_2m_max_member${String(i).padStart(2, "0")}`] = maxSeries(i * 0.01);
  }
  daily.temperature_2m_min = minSeries(0);
  for (let i = 1; i < n; i++) {
    daily[`temperature_2m_min_member${String(i).padStart(2, "0")}`] = minSeries(i * 0.01);
  }
  return { latitude: nyc.lat, longitude: nyc.lon, daily };
}

function multiModelBody(dates: string[], value = 27) {
  const daily: Record<string, Array<number | string | null>> = { time: dates };
  for (const model of MULTI_MODELS) {
    daily[`temperature_2m_max_${model}`] = dates.map(() => value);
    daily[`temperature_2m_min_${model}`] = dates.map(() => value - 8);
  }
  return { latitude: nyc.lat, longitude: nyc.lon, daily };
}

function forecastBody() {
  return {
    current: {
      time: "2026-09-04T12:00",
      temperature_2m: 21,
      relative_humidity_2m: 50,
      wind_speed_10m: 3,
      weather_code: 1,
    },
    hourly: { time: ["2026-09-04T00:00"], temperature_2m: [21] },
    daily: { time: ["2026-09-04"], temperature_2m_max: [25], temperature_2m_min: [15] },
  };
}

let realFetch: typeof fetch;
const calls: string[] = [];

beforeEach(() => {
  _resetCache();
  _resetEnsembleGuards();
  calls.length = 0;
  realFetch = globalThis.fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
  _resetCache();
  _resetEnsembleGuards();
});

function stubFetch(handler: (url: string) => Response | Promise<Response>) {
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    calls.push(url);
    return handler(url);
  }) as typeof fetch;
}

function ensembleCalls() {
  return calls.filter((u) => u.includes("ensemble-api.open-meteo.com"));
}

describe("loadWeather ensemble date-key", () => {
  it("success: membersC is localDate only and source includes Open-Meteo ensemble", async () => {
    const localDate = new Intl.DateTimeFormat("en-CA", { timeZone: nyc.tz }).format(new Date());
    const next = "2099-01-02";
    stubFetch((url) => {
      if (url.includes("ensemble-api.open-meteo.com")) {
        return jsonResponse(ensembleBody([localDate, next], [27, 30], 8));
      }
      if (url.includes("previous-runs-api.open-meteo.com")) return jsonResponse(forecastBody());
      if (url.includes("aviationweather.gov")) {
        return jsonResponse([{ icaoId: "KNYC", temp: 21, wspd: 4, cover: "CLR", name: "NYC" }]);
      }
      return jsonResponse({}, 404);
    });
    const wx = await loadWeather([nyc]);
    assert.ok(wx.nyc.source.includes("Open-Meteo ensemble"));
    assert.ok(wx.nyc.membersC.length >= 8);
    assert.equal(wx.nyc.localDate, localDate);
    assert.ok(wx.nyc.membersByDate[localDate]?.length >= 8);
    assert.ok(wx.nyc.membersByDate[next]?.length >= 8);
    assert.equal(wx.nyc.membersC.length, wx.nyc.membersByDate[localDate].length);
    assert.ok(wx.nyc.membersMinByDate[localDate]?.length >= 8);
    assert.ok(
      Math.max(...wx.nyc.membersMinByDate[localDate]) < Math.min(...wx.nyc.membersByDate[localDate]),
    );
  });

  it("wrong-day fallback blocked: missing localDate does not use dates[0]", async () => {
    const localDate = new Intl.DateTimeFormat("en-CA", { timeZone: nyc.tz }).format(new Date());
    const omStart = "2099-01-01";
    assert.notEqual(localDate, omStart);
    stubFetch((url) => {
      if (url.includes("ensemble-api.open-meteo.com")) {
        return jsonResponse(ensembleBody([omStart, "2099-01-02"], [31, 32], 31));
      }
      if (url.includes("previous-runs-api.open-meteo.com")) return jsonResponse(forecastBody());
      if (url.includes("aviationweather.gov")) return jsonResponse([]);
      return jsonResponse({}, 404);
    });
    const wx = await loadWeather([nyc]);
    assert.equal(wx.nyc.membersC.length, 0);
    assert.ok(wx.nyc.membersByDate[omStart]?.length >= 8);
    assert.ok(wx.nyc.source.includes("Open-Meteo ensemble"));
  });

  it("chunks per-city only on 400/URI-too-long, not on 5xx", async () => {
    const localDate = new Intl.DateTimeFormat("en-CA", { timeZone: nyc.tz }).format(new Date());
    const errors: unknown[] = [];
    const orig = console.error;
    console.error = (...args: unknown[]) => {
      errors.push(args.join(" "));
    };
    try {
      stubFetch((url) => {
        if (url.includes("ensemble-api.open-meteo.com")) {
          const latParam = new URL(url).searchParams.get("latitude") ?? "";
          if (latParam.includes(",")) return jsonResponse({ error: "URI too long" }, 400);
          return jsonResponse(ensembleBody([localDate], [22], 8));
        }
        if (url.includes("previous-runs-api.open-meteo.com")) return jsonResponse(forecastBody());
        if (url.includes("aviationweather.gov")) return jsonResponse([]);
        return jsonResponse({}, 404);
      });
      const wx = await loadWeather([nyc, bos]);
      assert.ok(errors.some((e) => String(e).includes("ensemble")));
      assert.ok(wx.nyc.membersC.length >= 8);
      assert.ok(wx.boston.membersC.length >= 8);
      assert.ok(calls.some((u) => u.includes("ensemble-api") && (new URL(u).searchParams.get("latitude") ?? "").includes(",")));
      assert.ok(calls.filter((u) => u.includes("ensemble-api") && !(new URL(u).searchParams.get("latitude") ?? "").includes(",")).length >= 2);
    } finally {
      console.error = orig;
    }
  });

  it("fail/empty: logs ensemble failure and does not claim ensemble in source", async () => {
    const errors: unknown[] = [];
    const orig = console.error;
    console.error = (...args: unknown[]) => {
      errors.push(args.join(" "));
    };
    try {
      stubFetch((url) => {
        if (url.includes("ensemble-api.open-meteo.com")) return jsonResponse({ error: "down" }, 503);
        if (url.includes("previous-runs-api.open-meteo.com")) return jsonResponse(forecastBody());
        if (url.includes("aviationweather.gov")) return jsonResponse([]);
        return jsonResponse({}, 404);
      });
      const wx = await loadWeather([nyc]);
      assert.equal(wx.nyc.membersC.length, 0);
      assert.deepEqual(wx.nyc.membersByDate, {});
      assert.equal(wx.nyc.source.includes("Open-Meteo ensemble"), false);
      assert.ok(wx.nyc.source.includes("Open-Meteo forecast"));
      assert.ok(errors.some((e) => String(e).toLowerCase().includes("ensemble")));
    } finally {
      console.error = orig;
    }
  });

  it("429 on first tz-group does not fire chunk or per-city retries", async () => {
    stubFetch((url) => {
      if (url.includes("ensemble-api.open-meteo.com")) return jsonResponse({ error: "rate" }, 429);
      if (url.includes("previous-runs-api.open-meteo.com")) return jsonResponse(forecastBody());
      if (url.includes("aviationweather.gov")) return jsonResponse([]);
      return jsonResponse({}, 404);
    });
    const wx = await loadWeather([nyc, tokyo]);
    assert.equal(ensembleCalls().length, 1);
    assert.equal(wx.nyc.membersC.length, 0);
    assert.equal(wx.tokyo.membersC.length, 0);
    assert.deepEqual(wx.nyc.membersByDate, {});
    assert.equal(wx.nyc.source.includes("Open-Meteo ensemble"), false);
  });

  it("concurrent loadWeather shares one ensemble fetch", async () => {
    const localDate = new Intl.DateTimeFormat("en-CA", { timeZone: nyc.tz }).format(new Date());
    stubFetch(async (url) => {
      if (url.includes("ensemble-api.open-meteo.com")) {
        await new Promise((r) => setTimeout(r, 40));
        return jsonResponse(ensembleBody([localDate], [27], 8));
      }
      if (url.includes("previous-runs-api.open-meteo.com")) return jsonResponse(forecastBody());
      if (url.includes("aviationweather.gov")) return jsonResponse([]);
      return jsonResponse({}, 404);
    });
    const [a, b] = await Promise.all([loadWeather([nyc]), loadWeather([nyc])]);
    assert.equal(ensembleCalls().length, 1);
    assert.ok(a.nyc.membersByDate[localDate]?.length >= 8);
    assert.ok(b.nyc.membersByDate[localDate]?.length >= 8);
  });

  it("429 cooldown skips a second loadWeather HTTP burst", async () => {
    stubFetch((url) => {
      if (url.includes("ensemble-api.open-meteo.com")) return jsonResponse({ error: "rate" }, 429);
      if (url.includes("previous-runs-api.open-meteo.com")) return jsonResponse(forecastBody());
      if (url.includes("aviationweather.gov")) return jsonResponse([]);
      return jsonResponse({}, 404);
    });
    await loadWeather([nyc]);
    const first = ensembleCalls().length;
    assert.equal(first, 1);
    await loadWeather([nyc]);
    assert.equal(ensembleCalls().length, first);
  });

  it("OPEN_METEO_API_KEY uses customer ensemble host", () => {
    const prev = process.env.OPEN_METEO_API_KEY;
    process.env.OPEN_METEO_API_KEY = "test-key";
    try {
      const url = ensembleRequestUrl("40.78", "-73.96", "America/New_York");
      assert.ok(url.startsWith("https://customer-ensemble-api.open-meteo.com/v1/ensemble?"));
      assert.ok(url.includes("apikey=test-key"));
      assert.equal(url.includes("://ensemble-api.open-meteo.com"), false);
    } finally {
      if (prev === undefined) delete process.env.OPEN_METEO_API_KEY;
      else process.env.OPEN_METEO_API_KEY = prev;
    }
    const free = ensembleRequestUrl("40.78", "-73.96", "America/New_York");
    assert.ok(free.startsWith("https://ensemble-api.open-meteo.com/v1/ensemble?"));
    assert.equal(free.includes("apikey="), false);
  });

  it("429 after a success keeps last-good members", async () => {
    const localDate = new Intl.DateTimeFormat("en-CA", { timeZone: nyc.tz }).format(new Date());
    stubFetch((url) => {
      if (url.includes("ensemble-api.open-meteo.com")) {
        return jsonResponse(ensembleBody([localDate], [27], 8));
      }
      if (url.includes("previous-runs-api.open-meteo.com")) return jsonResponse(forecastBody());
      if (url.includes("aviationweather.gov")) return jsonResponse([]);
      return jsonResponse({}, 404);
    });
    const ok = await loadWeather([nyc]);
    assert.ok(ok.nyc.membersByDate[localDate]?.length >= 8);
    _resetCache();
    stubFetch((url) => {
      if (url.includes("ensemble-api.open-meteo.com")) return jsonResponse({ error: "rate" }, 429);
      if (url.includes("previous-runs-api.open-meteo.com")) return jsonResponse(forecastBody());
      if (url.includes("aviationweather.gov")) return jsonResponse([]);
      return jsonResponse({}, 404);
    });
    const stale = await loadWeather([nyc]);
    assert.ok(stale.nyc.membersByDate[localDate]?.length >= 8);
    assert.ok(stale.nyc.source.includes("Open-Meteo ensemble"));
  });

  it("ensemble 429 falls back to multi-model forecast members", async () => {
    const localDate = new Intl.DateTimeFormat("en-CA", { timeZone: nyc.tz }).format(new Date());
    stubFetch((url) => {
      if (url.includes("ensemble-api.open-meteo.com")) return jsonResponse({ error: "rate" }, 429);
      if (url.includes("api.open-meteo.com") && url.includes("models=")) {
        return jsonResponse(multiModelBody([localDate, "2099-01-02"], 27));
      }
      if (url.includes("previous-runs-api.open-meteo.com")) return jsonResponse(forecastBody());
      if (url.includes("aviationweather.gov")) return jsonResponse([]);
      return jsonResponse({}, 404);
    });
    const wx = await loadWeather([nyc]);
    assert.equal(ensembleCalls().length, 1);
    assert.ok(wx.nyc.membersByDate[localDate]?.length >= 8);
    assert.ok(wx.nyc.source.includes("Open-Meteo multi-model"));
    assert.equal(wx.nyc.source.includes("Open-Meteo ensemble"), false);
  });
});
