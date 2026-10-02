import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ensembleOk } from "./ensemble.ts";
import {
  assembleDeskSnapshot,
  ENSEMBLE_UNAVAILABLE,
  membersForEvent,
} from "./snapshot.ts";
import type { CityMeta, WeatherNow } from "./types.ts";
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

function members(n: number, value: number) {
  return Array.from({ length: n }, () => value);
}

function wx(over: Partial<WeatherNow> = {}): WeatherNow {
  return {
    tempC: 21,
    humidity: 50,
    windMs: 3,
    weatherCode: 1,
    cover: "CLR",
    station: "NYC",
    observedAt: "2026-09-04T16:00:00Z",
    observedMaxC: 21,
    observedMinC: null,
    modelMeanC: 27,
    modelStdC: 0.5,
    modelMinC: 26,
    modelMaxC: 28,
    membersC: [],
    membersByDate: {},
    membersMinByDate: {},
    localDate: "2026-09-03",
    hourly: [],
    source: "Open-Meteo ensemble \u00b7 Open-Meteo forecast",
    ...over,
  };
}

function event(over: Partial<ParsedEvent> = {}): ParsedEvent {
  return {
    eventId: "e1",
    slug: "nyc-high",
    title: "Highest temperature in NYC",
    city: nyc,
    cityRaw: "NYC",
    kind: "high",
    unit: "F",
    eventDate: "2026-09-03",
    endDate: "2026-09-04",
    volume: 1000,
    volume24hr: 500,
    liquidity: 200,
    image: null,
    context: null,
    settlement: "round",
    markets: [
      {
        id: "m1",
        question: "Will the highest temperature be 80\u00b0F?",
        bound: { lo: 79.5, hi: 80.5, label: "80\u00b0F", kind: "exact" },
        yesPrice: 0.4,
        noPrice: 0.6,
        tokens: [],
      },
    ],
    ...over,
  };
}

describe("snapshot ensembleOk gate", () => {
  it("empty ensemble is not ok", () => {
    assert.equal(ensembleOk([]), false);
  });

  it("length-7 ensemble is not ok", () => {
    assert.equal(ensembleOk(Array.from({ length: 7 }, () => 20)), false);
  });
});

describe("membersForEvent date-key", () => {
  it("uses only membersByDate[eventDate] and never membersC", () => {
    const weather = wx({
      localDate: "2026-09-03",
      membersC: members(31, 10),
      membersByDate: {
        "2026-09-03": members(8, 20),
        "2026-09-04": members(31, 31),
      },
    });
    assert.deepEqual(membersForEvent(weather, "2026-09-04"), members(31, 31));
    assert.deepEqual(membersForEvent(weather, "2026-09-03"), members(8, 20));
    assert.deepEqual(membersForEvent(weather, "2026-09-05"), []);
    const wrongDay = wx({
      localDate: "2026-09-03",
      membersC: members(31, 31),
      membersByDate: { "2026-09-04": members(31, 31) },
    });
    assert.deepEqual(membersForEvent(wrongDay, "2026-09-03"), []);
  });
});

describe("assembleDeskSnapshot date-key", () => {
  it("blocks wrong-day fallback: Sep 3 event does not use Sep 4 members", () => {
    const snap = assembleDeskSnapshot({
      events: [event({ eventDate: "2026-09-03" })],
      weather: {
        nyc: wx({
          localDate: "2026-09-03",
          membersC: members(31, 31),
          membersByDate: { "2026-09-04": members(31, 31) },
        }),
      },
    });
    const b = snap.events[0].buckets[0];
    assert.equal(b.modelP, 0);
    assert.equal(b.edgeYes, 0);
    assert.equal(b.edgeNo, 0);
    assert.equal(b.tradeable, false);
    assert.equal(snap.signals.length, 0);
    assert.ok(snap.warning);
  });

  it("prices dated members only and keeps membersByDate after pricing", () => {
    const dated = members(8, 27);
    const snap = assembleDeskSnapshot({
      events: [event({ eventDate: "2026-09-04" })],
      weather: {
        nyc: wx({
          localDate: "2026-09-03",
          membersC: members(8, 10),
          membersByDate: {
            "2026-09-03": members(8, 10),
            "2026-09-04": dated,
          },
        }),
      },
    });
    const b = snap.events[0].buckets[0];
    assert.ok(b.modelP > 0, "dated 27C members should mass into 80F");
    assert.ok((snap.events[0].modelHigh ?? 0) > 70, "modelHigh from dated 27C not membersC 10C");
    assert.ok((snap.events[0].modelHigh ?? 0) < 90);
    assert.deepEqual(snap.weather.nyc.membersByDate["2026-09-04"], dated);
    assert.deepEqual(snap.weather.nyc.membersC, members(8, 10));
    assert.equal(snap.warning, null);
  });

  it("ended-day (localDate > eventDate) emits zero signals", () => {
    const snap = assembleDeskSnapshot({
      events: [event({ eventDate: "2026-09-03" })],
      weather: {
        nyc: wx({
          localDate: "2026-09-04",
          membersC: members(8, 27),
          membersByDate: { "2026-09-03": members(8, 27) },
        }),
      },
    });
    assert.equal(snap.signals.length, 0);
    assert.equal(snap.events[0].bestSignal, null);
    assert.equal(snap.events[0].buckets[0].tradeable, false);
    assert.ok(snap.weather.nyc.membersByDate["2026-09-03"]?.length >= 8);
  });

  it("thin ensemble (<8) zeros edges and warns", () => {
    const snap = assembleDeskSnapshot({
      events: [event({ eventDate: "2026-09-04" })],
      weather: {
        nyc: wx({
          localDate: "2026-09-04",
          membersC: members(7, 27),
          membersByDate: { "2026-09-04": members(7, 27) },
        }),
      },
    });
    const b = snap.events[0].buckets[0];
    assert.equal(b.modelP, 0);
    assert.equal(b.edgeYes, 0);
    assert.equal(b.edgeNo, 0);
    assert.equal(snap.signals.length, 0);
    assert.ok(snap.warning);
  });

  it("fail/empty ensemble sets warning and does not mint edges", () => {
    const snap = assembleDeskSnapshot({
      events: [event()],
      weather: {
        nyc: wx({
          membersC: [],
          membersByDate: {},
          source: "Open-Meteo forecast \u00b7 METAR KNYC",
        }),
      },
    });
    assert.match(snap.warning ?? "", /ensemble/i);
    assert.equal(snap.events[0].buckets[0].modelP, 0);
    assert.equal(snap.events[0].buckets[0].edgeYes, 0);
    assert.equal(snap.events[0].buckets[0].edgeNo, 0);
    assert.equal(snap.signals.length, 0);
    assert.ok(ENSEMBLE_UNAVAILABLE.includes("8"));
  });

  it("success: live day with >=8 dated members keeps membersC and can signal", () => {
    const live = members(8, 27);
    const snap = assembleDeskSnapshot({
      events: [event({ eventDate: "2026-09-04" })],
      weather: {
        nyc: wx({
          localDate: "2026-09-04",
          membersC: live,
          membersByDate: { "2026-09-04": live },
        }),
      },
    });
    assert.equal(snap.warning, null);
    assert.ok(snap.events[0].buckets[0].modelP > 0);
    assert.deepEqual(snap.weather.nyc.membersC, live);
    assert.deepEqual(snap.weather.nyc.membersByDate["2026-09-04"], live);
  });
});
