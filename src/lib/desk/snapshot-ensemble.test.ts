import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { ensembleOk } from "./ensemble.ts";
import { loadWeather } from "./weather.ts";
import { buildDeskSnapshot } from "./snapshot.ts";
import type { ParsedEvent } from "./polymarket.ts";
import type { CityMeta, WeatherNow } from "./types.ts";

/**
 * Full buildDeskSnapshot integration needs mocks for polymarket/weather.
 * Ensemble gate used by snapshot is covered here (and in ensemble.test.ts).
 */
describe("snapshot ensembleOk gate", () => {
  it("empty ensemble is not ok", () => {
    assert.equal(ensembleOk([]), false);
  });

  it("length-7 ensemble is not ok", () => {
    assert.equal(ensembleOk(Array.from({ length: 7 }, () => 20)), false);
  });
});

const city: CityMeta = {
  id: "test-city",
  name: "Test City",
  aliases: [],
  lat: 10,
  lon: 20,
  tz: "UTC",
  icao: "TEST",
  country: "US",
};

function eventForDate(eventDate: string): ParsedEvent {
  return {
    eventId: "ev1",
    slug: "ev-1",
    title: "Test City high temp",
    city,
    cityRaw: city.name,
    kind: "high",
    unit: "C",
    eventDate,
    endDate: `${eventDate}T23:59:59Z`,
    volume: 100,
    volume24hr: 100,
    liquidity: 100,
    image: null,
    context: null,
    markets: [
      {
        id: "m1",
        question: "Will high be between 30°C and 35°C?",
        slug: "m1",
        conditionId: "c1",
        bound: { lo: 30, hi: 35, label: "30-35°C", kind: "range" },
        yesPrice: 0.5,
        noPrice: 0.5,
        tokens: [],
      },
    ],
  };
}

function weatherBase(overrides: Partial<WeatherNow>): WeatherNow {
  return {
    tempC: 20,
    humidity: 50,
    windMs: 3,
    weatherCode: 1,
    cover: null,
    station: city.icao,
    observedAt: null,
    observedMaxC: null,
    modelMeanC: 20,
    modelStdC: 1,
    modelMinC: 19,
    modelMaxC: 21,
    membersC: [],
    membersByDate: {},
    localDate: "2026-09-01",
    hourly: [],
    source: "Open-Meteo forecast · METAR TEST",
    ...overrides,
  };
}

afterEach(() => {
  globalThis.fetch = originalFetch;
});

const originalFetch = globalThis.fetch;

describe("weather ensemble behavior", () => {
  it("ensemble success populates members and source", async () => {
    globalThis.fetch = (async (url: string | URL) => {
      const parsed = new URL(String(url));
      if (parsed.hostname === "ensemble-api.open-meteo.com") {
        return new Response(
          JSON.stringify({
            daily: {
              time: ["2026-09-03", "2026-09-04"],
              temperature_2m_max: [24, 25],
              temperature_2m_max_member_01: [23, 24],
            },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      if (parsed.hostname === "previous-runs-api.open-meteo.com") {
        return new Response(
          JSON.stringify({
            current: { temperature_2m: 22, relative_humidity_2m: 55, wind_speed_10m: 3, weather_code: 2 },
            hourly: { time: [], temperature_2m: [] },
            daily: { time: ["2026-09-03"], temperature_2m_max: [25], temperature_2m_min: [17] },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      if (parsed.hostname === "aviationweather.gov") {
        return new Response(JSON.stringify([]), { status: 200, headers: { "content-type": "application/json" } });
      }
      return new Response("not found", { status: 404 });
    }) as typeof globalThis.fetch;

    const loaded = await loadWeather([city]);
    assert.ok(loaded.weather[city.id].membersC.length > 0);
    assert.ok(loaded.weather[city.id].source.includes("Open-Meteo ensemble"));
    assert.equal(loaded.ensembleError, null);
  });
});

describe("snapshot ensemble handling", () => {
  it("ensemble unavailable sets warning and keeps zero-signal behavior", async () => {
    const eventDate = "2026-09-10";
    const snapshot = await buildDeskSnapshot({
      loadWeatherEventsFn: async () => [eventForDate(eventDate)],
      loadWeatherFn: async () => ({
        weather: {
          [city.id]: weatherBase({ localDate: eventDate, membersC: [], membersByDate: {} }),
        },
        ensembleError: "Open-Meteo ensemble unavailable",
      }),
    });

    assert.match(snapshot.warning ?? "", /Open-Meteo ensemble unavailable/);
    assert.equal(snapshot.events[0].buckets[0].modelP, 0);
    assert.equal(snapshot.events[0].buckets[0].edgeYes, 0);
    assert.equal(snapshot.events[0].buckets[0].edgeNo, 0);
    assert.equal(snapshot.signals.length, 0);
    assert.equal(snapshot.totals.openSignals, 0);
  });

  it("thin ensemble remains blocked", async () => {
    const eventDate = "2026-09-10";
    const thin = Array.from({ length: 7 }, () => 32);
    const snapshot = await buildDeskSnapshot({
      loadWeatherEventsFn: async () => [eventForDate(eventDate)],
      loadWeatherFn: async () => ({
        weather: {
          [city.id]: weatherBase({
            localDate: eventDate,
            membersC: thin,
            membersByDate: { [eventDate]: thin },
            source: "Open-Meteo ensemble · Open-Meteo forecast",
          }),
        },
        ensembleError: null,
      }),
    });

    assert.equal(snapshot.warning, null);
    assert.equal(snapshot.events[0].buckets[0].modelP, 0);
    assert.equal(snapshot.events[0].buckets[0].edgeYes, 0);
    assert.equal(snapshot.signals.length, 0);
  });

  it("dated event uses membersByDate[eventDate] and keeps dated members on snapshot weather", async () => {
    const eventDate = "2026-09-10";
    const dated = Array.from({ length: 8 }, () => 5);
    const local = Array.from({ length: 8 }, () => 40);
    const snapshot = await buildDeskSnapshot({
      loadWeatherEventsFn: async () => [eventForDate(eventDate)],
      loadWeatherFn: async () => ({
        weather: {
          [city.id]: weatherBase({
            membersC: local,
            membersByDate: { [eventDate]: dated },
            source: "Open-Meteo ensemble · Open-Meteo forecast",
          }),
        },
        ensembleError: null,
      }),
    });

    assert.equal(snapshot.events[0].modelHigh, 5);
    assert.deepEqual(snapshot.weather[city.id].membersByDate[eventDate], dated);
  });
});
