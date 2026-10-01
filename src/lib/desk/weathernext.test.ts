import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { _resetCache } from "./cache.ts";
import { _resetEnsembleGuards, loadWeather } from "./weather.ts";
import {
  _resetWeatherNext,
  _setWeatherNextConfig,
  _setWeatherNextRunner,
  buildFetchSql,
  buildProbeSql,
  dailyMaxMembers,
  FETCH_BATCH_SIZE,
  probeLatestInit,
  dueInitCandidates,
  loadWeatherNext,
  memberRanks,
  parseFetchRows,
  probit,
  quantileAtZ,
  weatherNextConfig,
  weatherNextUsage,
  type WeatherNextConfig,
  type WeatherNextRow,
  type WnHour,
} from "./weathernext.ts";
import type { CityMeta } from "./types.ts";

const K = 273.15;

const nyc: CityMeta = { id: "nyc", name: "New York City", aliases: [], lat: 40.7829, lon: -73.9654, tz: "America/New_York", icao: "KNYC", country: "US" };
const tokyo: CityMeta = { id: "tokyo", name: "Tokyo", aliases: [], lat: 35.6762, lon: 139.6503, tz: "Asia/Tokyo", icao: "RJTT", country: "JP" };
const london: CityMeta = { id: "london", name: "London", aliases: [], lat: 51.5074, lon: -0.1278, tz: "Europe/London", icao: "EGLL", country: "GB" };

const cfg: WeatherNextConfig = {
  projectId: "billing-proj",
  datasetProject: "billing-proj",
  dataset: "weathernext_3",
  table: "weathernext_3_0_0_0p05deg",
  location: "US",
  probeMs: 30 * 60_000,
  maxHours: 120,
  initHours: [0, 12],
  dailyCapBytes: 9 * 1024 ** 3,
  monthlyCapBytes: 270 * 1024 ** 3,
  maxEstimateBytes: 28 * 1024 ** 3,
  usageFile: null,
};

const MIB = 1024 ** 2;

function latestInit() {
  return dueInitCandidates(Date.now(), cfg.initHours)[0].toISOString();
}

/** Fake BigQuery rows: diurnal cycle peaking 15:00 local-ish, p10/p50/p90 = mid ± 1.5. */
function fakeRows(cityIdx: number, init: string, base = 20): WeatherNextRow[] {
  const rows: WeatherNextRow[] = [];
  for (let h = 1; h <= 120; h++) {
    const mid = base + 5 * Math.sin((h / 24) * 2 * Math.PI);
    rows.push({
      i: cityIdx,
      init_time: { value: init },
      lon: 0,
      lat: 0,
      hours: h,
      p10: mid - 1.5 + K,
      p50: mid + K,
      p90: mid + 1.5 + K,
    });
  }
  return rows;
}

type Call = { sql: string };
/** Real (billed) jobs only. */
let calls: Call[] = [];
/** Dry runs (free). */
let dryCalls: Call[] = [];

const PARTITION_BYTES = 3_318_681_600; // measured dry-run size of one init's init_time column
const isProbe = (sql: string) => /^SELECT init_time FROM .* WHERE init_time = TIMESTAMP/.test(sql);
const sqlInit = (sql: string) => {
  const m = sql.match(/TIMESTAMP\('(\d{4}-\d\d-\d\d \d\d:\d\d:\d\d)\+00'\)/);
  return m ? new Date(`${m[1].replace(" ", "T")}Z`).toISOString() : null;
};

type DryOpts = { published?: (init: string) => number; fetchEstimate?: number };

/**
 * Mock BigQuery. Dry-run probe → partition size for inits ≤ the published one
 * (0 for newer); dry-run fetch → `fetchEstimate`; real jobs → handler rows.
 */
function runnerFor(handler: (sql: string) => WeatherNextRow[] | Promise<WeatherNextRow[]>, bytes = 90 * MIB, dry: DryOpts = {}) {
  const published = dry.published ?? ((i: string) => (Date.parse(i) <= Date.parse(latestInit()) ? PARTITION_BYTES : 0));
  _setWeatherNextRunner(async (sql, _cfg, opts) => {
    if (opts?.dryRun) {
      dryCalls.push({ sql });
      const est = isProbe(sql) ? published(sqlInit(sql)!) : (dry.fetchEstimate ?? 1.47e12 / 64);
      return { rows: [], bytesBilled: 0, bytesEstimated: est };
    }
    assert.ok(!isProbe(sql), "probe must never run as a billed job");
    calls.push({ sql });
    const rows = await handler(sql);
    return { rows, bytesBilled: bytes };
  });
}

/** Fetch → rows for every city index in the STRUCT list. */
function defaultHandler(init = latestInit(), skip: number[] = []) {
  return (sql: string) => {
    const n = (sql.match(/STRUCT\(\d+ AS i/g) ?? []).length;
    const rows: WeatherNextRow[] = [];
    for (let i = 0; i < n; i++) if (!skip.includes(i)) rows.push(...fakeRows(i, init));
    return rows;
  };
}

let realFetch: typeof fetch;

beforeEach(() => {
  _resetWeatherNext();
  _resetCache();
  _resetEnsembleGuards();
  _setWeatherNextConfig(cfg);
  calls = [];
  dryCalls = [];
  realFetch = globalThis.fetch;
});

afterEach(() => {
  _setWeatherNextRunner(null);
  _setWeatherNextConfig(undefined);
  _resetWeatherNext();
  globalThis.fetch = realFetch;
});

describe("WeatherNext distribution math", () => {
  it("probit inverts the normal CDF at known points", () => {
    assert.ok(Math.abs(probit(0.5)) < 1e-9);
    assert.ok(Math.abs(probit(0.9) - 1.2815515655) < 1e-6);
    assert.ok(Math.abs(probit(0.1) + 1.2815515655) < 1e-6);
  });

  it("quantileAtZ hits the knots, interpolates, extrapolates, and rearranges crossings", () => {
    const q = [10, 12, 15];
    assert.ok(Math.abs(quantileAtZ(q, probit(0.1)) - 10) < 1e-6);
    assert.equal(quantileAtZ(q, 0), 12);
    assert.ok(Math.abs(quantileAtZ(q, probit(0.9)) - 15) < 1e-6);
    assert.ok(quantileAtZ(q, -2) < 10);
    assert.ok(quantileAtZ(q, 2) > 15);
    // crossed input behaves like the sorted one
    assert.equal(quantileAtZ([15, 12, 10], 0.3), quantileAtZ([10, 12, 15], 0.3));
  });

  it("memberRanks are symmetric, increasing, and N long", () => {
    const r = memberRanks(50);
    assert.equal(r.length, 50);
    for (let i = 1; i < r.length; i++) assert.ok(r[i] > r[i - 1]);
    assert.ok(Math.abs(r[0] + r[49]) < 1e-9);
  });

  it("daily max is the comonotonic max per member, keyed by local date", () => {
    // NYC 2026-07-10 local = 04:00Z Jul 10 .. 03:00Z Jul 11 (EDT).
    const start = Date.parse("2026-07-10T04:00:00Z");
    const hours: WnHour[] = [];
    for (let h = 0; h < 24; h++) {
      const mid = h === 15 ? 30 : 20; // peak at 15:00 local
      const spread = h === 15 ? 1 : 4; // the cooler hour is wider
      hours.push({ validMs: start + h * 3600_000, q: [mid - spread, mid, mid + spread] });
    }
    const out = dailyMaxMembers(hours, "America/New_York", 50);
    assert.deepEqual(Object.keys(out), ["2026-07-10"]);
    const m = out["2026-07-10"];
    assert.equal(m.length, 50);
    const ranks = memberRanks(50);
    for (let i = 0; i < 50; i++) {
      const expected = Math.max(quantileAtZ([29, 30, 31], ranks[i]), quantileAtZ([16, 20, 24], ranks[i]));
      assert.ok(Math.abs(m[i] - expected) < 0.006);
    }
    // the median member's max is the peak hour's median
    assert.ok(Math.abs((m[24] + m[25]) / 2 - 30) < 0.05);
  });

  it("drops a local date whose afternoon-to-midnight hours are not covered", () => {
    // 18:00Z..23:00Z Jul 10 = 14:00..19:00 EDT only → not covered.
    const start = Date.parse("2026-07-10T18:00:00Z");
    const hours: WnHour[] = Array.from({ length: 6 }, (_, h) => ({ validMs: start + h * 3600_000, q: [20, 21, 22] }));
    assert.deepEqual(dailyMaxMembers(hours, "America/New_York"), {});
  });

  it("same UTC hours split into different local dates per timezone", () => {
    const init = "2026-07-10T00:00:00.000Z";
    const rows = [...fakeRows(0, init), ...fakeRows(1, init)];
    const parsed = parseFetchRows(rows, [nyc, tokyo]);
    const nycDates = Object.keys(parsed.get("nyc")!.membersByDate);
    const tokyoDates = Object.keys(parsed.get("tokyo")!.membersByDate);
    // init 00Z Jul 10 + 1h = 21:00 EDT Jul 9 (uncovered) / 10:00 JST Jul 10 (missing 10:00? covered from 11)
    assert.ok(!nycDates.includes("2026-07-09"));
    assert.ok(nycDates.includes("2026-07-10"));
    assert.ok(tokyoDates.includes("2026-07-10"));
    for (const m of Object.values(parsed.get("nyc")!.membersByDate)) assert.equal(m.length, 50);
    // Kelvin → °C
    const any = Object.values(parsed.get("nyc")!.membersByDate)[0];
    assert.ok(any.every((x) => x > 10 && x < 35));
  });
});

describe("WeatherNext SQL + config", () => {
  it("fetch SQL filters on one init_time partition and a constant MULTIPOINT, reads only 4 forecast columns", () => {
    const sql = buildFetchSql(cfg, [nyc, tokyo], "2026-10-01T12:00:00.000Z");
    assert.match(sql, /t\.init_time = TIMESTAMP\('2026-10-01 12:00:00\+00'\)/);
    assert.match(sql, /ST_GEOGFROMTEXT\('MULTIPOINT\(\(-73\.9654 40\.7829\),\(139\.6503 35\.6762\)\)'\)/);
    assert.match(sql, /`billing-proj\.weathernext_3\.weathernext_3_0_0_0p05deg`/);
    const cols = sql.match(/f\.station_head_[a-z0-9_]+/g) ?? [];
    assert.deepEqual(cols, [
      "f.station_head_temperature_2m_p10",
      "f.station_head_temperature_2m_p50",
      "f.station_head_temperature_2m_p90",
    ]);
    assert.ok(!/dewpoint|_mean|f\.time/.test(sql));
    assert.match(sql, /f\.hours <= 120/);
  });

  it("probe SQL is a single-partition init_time equality (dry-run only)", () => {
    const now = Date.parse("2026-10-01T22:19:00Z");
    const c = dueInitCandidates(now, [0, 12]);
    assert.equal(c[0].toISOString(), "2026-10-01T12:00:00.000Z");
    assert.ok(c.every((d) => [0, 12].includes(d.getUTCHours())));
    const sql = buildProbeSql(cfg, c[0]);
    assert.equal(
      sql,
      "SELECT init_time FROM `billing-proj.weathernext_3.weathernext_3_0_0_0p05deg` WHERE init_time = TIMESTAMP('2026-10-01 12:00:00+00')",
    );
    assert.ok(!/ IN \(|geography|forecast/.test(sql));
  });

  it("probeLatestInit dry-runs newest-first and stops at the loaded init", async () => {
    const c = dueInitCandidates(Date.parse("2026-10-01T22:19:00Z"), [0, 12]);
    const sizes: Record<string, number> = {
      "2026-10-01T12:00:00.000Z": 0, // not published yet
      "2026-10-01T00:00:00.000Z": 1_244_505_600,
      "2026-09-30T12:00:00.000Z": 3_526_099_200,
    };
    runnerFor(defaultHandler(), 0, { published: (i) => sizes[i] ?? 0 });
    const run = (globalThis as { __isobarWnRunner?: Parameters<typeof _setWeatherNextRunner>[0] }).__isobarWnRunner!;
    assert.equal(await probeLatestInit(cfg, run, c, null), "2026-10-01T00:00:00.000Z");
    assert.equal(dryCalls.length, 2);
    // already on 00Z and 12Z still missing → one dry run, nothing newer
    assert.equal(await probeLatestInit(cfg, run, c, "2026-10-01T00:00:00.000Z"), null);
    assert.equal(dryCalls.length, 3);
    sizes["2026-10-01T12:00:00.000Z"] = 3_318_681_600;
    assert.equal(await probeLatestInit(cfg, run, c, "2026-10-01T00:00:00.000Z"), "2026-10-01T12:00:00.000Z");
    assert.equal(calls.length, 0, "probing never runs a billed job");
  });

  it("weatherNextConfig: estimate limit defaults to 28 GiB and is overridable", () => {
    const base = { ISOBAR_WEATHERNEXT_PROJECT: "p", ISOBAR_WEATHERNEXT_DATASET: "d" };
    assert.equal(weatherNextConfig(base)!.maxEstimateBytes, 28 * 1024 ** 3);
    assert.equal(weatherNextConfig({ ...base, ISOBAR_WEATHERNEXT_MAX_ESTIMATE_GIB: "2048" })!.maxEstimateBytes, 2048 * 1024 ** 3);
    assert.equal(weatherNextConfig(base)!.dailyCapBytes, 8 * 1024 ** 3);
    assert.equal(weatherNextConfig(base)!.monthlyCapBytes, 240 * 1024 ** 3);
  });

  it("weatherNextConfig: off unless project + dataset set; parses JSON / base64 creds", () => {
    assert.equal(weatherNextConfig({}), null);
    assert.equal(weatherNextConfig({ ISOBAR_WEATHERNEXT_PROJECT: "p" }), null);
    const a = weatherNextConfig({ ISOBAR_WEATHERNEXT_PROJECT: "polym-509212", ISOBAR_WEATHERNEXT_DATASET: "weathernext_3" })!;
    assert.equal(a.datasetProject, "polym-509212");
    assert.deepEqual(a.initHours, [0, 12]);
    assert.equal(a.credentials, undefined);
    const b = weatherNextConfig({
      ISOBAR_WEATHERNEXT_PROJECT: "billing",
      ISOBAR_WEATHERNEXT_DATASET: "other-proj.wn3",
      ISOBAR_WEATHERNEXT_CREDENTIALS_JSON: Buffer.from('{"type":"service_account"}').toString("base64"),
      ISOBAR_WEATHERNEXT_INIT_HOURS: "0",
    })!;
    assert.equal(b.datasetProject, "other-proj");
    assert.equal(b.dataset, "wn3");
    assert.deepEqual(b.credentials, { type: "service_account" });
    assert.deepEqual(b.initHours, [0]);
    assert.equal(weatherNextConfig({ ISOBAR_WEATHERNEXT_PROJECT: "p", ISOBAR_WEATHERNEXT_DATASET: "d`; DROP" }), null);
    assert.equal(
      weatherNextConfig({ ISOBAR_WEATHERNEXT_PROJECT: "p", ISOBAR_WEATHERNEXT_DATASET: "d", ISOBAR_WEATHERNEXT_CREDENTIALS_JSON: "{bad" }),
      null,
    );
    assert.equal(weatherNextConfig({ ISOBAR_WEATHERNEXT_PROJECT: "p", ISOBAR_WEATHERNEXT_DATASET: "d", ISOBAR_WEATHERNEXT_DISABLED: "true" }), null);
  });
});

describe("loadWeatherNext caching + budget (mocked BigQuery)", () => {
  it("dry-run probe + one billed batched fetch, then serves from cache with zero queries", async () => {
    runnerFor(defaultHandler());
    const a = await loadWeatherNext([nyc, tokyo]);
    assert.equal(calls.length, 1);
    assert.equal(a.byCity.size, 2);
    assert.equal(a.init, latestInit());
    assert.equal((calls[0].sql.match(/STRUCT\(\d+ AS i/g) ?? []).length, 2);
    assert.ok(dryCalls.some((c) => isProbe(c.sql)));
    assert.ok(dryCalls.some((c) => c.sql === calls[0].sql), "fetch is dry-run first");
    for (let i = 0; i < 5; i++) await loadWeatherNext([nyc, tokyo]);
    assert.equal(calls.length, 1);
    // only billed bytes count; dry runs are free
    assert.equal(weatherNextUsage()!.dayBytes, 90 * MIB);
  });

  it("billed bytes below 10 MiB are charged at the BigQuery minimum", async () => {
    runnerFor(defaultHandler(), 1 * MIB);
    await loadWeatherNext([nyc]);
    assert.equal(weatherNextUsage()!.dayBytes, 10 * MIB);
  });

  it("splits many cities into batches of FETCH_BATCH_SIZE, one billed job each", async () => {
    const many: CityMeta[] = Array.from({ length: FETCH_BATCH_SIZE * 2 + 3 }, (_, i) => ({
      ...nyc,
      id: `c${i}`,
      lat: 10 + i * 0.5,
      lon: 10 + i * 0.5,
    }));
    runnerFor(defaultHandler());
    const a = await loadWeatherNext(many);
    assert.equal(calls.length, 3);
    assert.deepEqual(
      calls.map((c) => (c.sql.match(/STRUCT\(\d+ AS i/g) ?? []).length),
      [FETCH_BATCH_SIZE, FETCH_BATCH_SIZE, 3],
    );
    assert.equal(a.byCity.size, many.length);
    assert.equal(weatherNextUsage()!.dayBytes, 3 * 90 * MIB);
  });

  it("skips the billed job when the dry-run estimate exceeds the pre-run limit, and backs off", async () => {
    runnerFor(defaultHandler(), 90 * MIB, { fetchEstimate: 1.47e12 });
    const orig = console.error;
    const logged: string[] = [];
    console.error = (...a: unknown[]) => void logged.push(a.join(" "));
    try {
      const a = await loadWeatherNext([nyc]);
      assert.equal(calls.length, 0);
      assert.equal(a.byCity.size, 0);
      assert.match(a.error ?? "", /estimate 1369 GiB > 28 GiB pre-run limit/);
      const before = dryCalls.length;
      await loadWeatherNext([nyc]);
      assert.equal(dryCalls.length, before, "backed off: no further dry runs");
      assert.equal(weatherNextUsage()?.dayBytes ?? 0, 0);
      assert.ok(logged.some((l) => /pre-run limit/.test(l)));
    } finally {
      console.error = orig;
    }
  });

  it("a raised estimate limit lets the same fetch run", async () => {
    _setWeatherNextConfig({ ...cfg, maxEstimateBytes: 2048 * 1024 ** 3 });
    runnerFor(defaultHandler(), 90 * MIB, { fetchEstimate: 1.47e12 });
    const a = await loadWeatherNext([nyc]);
    assert.equal(calls.length, 1);
    assert.equal(a.byCity.size, 1);
  });

  it("no published init → dry runs only, no billed job", async () => {
    runnerFor(defaultHandler(), 90 * MIB, { published: () => 0 });
    const a = await loadWeatherNext([nyc]);
    assert.equal(calls.length, 0);
    assert.equal(a.byCity.size, 0);
    assert.match(a.error ?? "", /no init loaded/);
  });

  it("concurrent callers share one in-flight refresh", async () => {
    runnerFor(async (sql) => {
      await new Promise((r) => setTimeout(r, 20));
      return defaultHandler()(sql);
    });
    await Promise.all([loadWeatherNext([nyc]), loadWeatherNext([nyc]), loadWeatherNext([nyc])]);
    assert.equal(calls.length, 1);
  });

  it("a new city on the same init fetches only that city", async () => {
    runnerFor(defaultHandler());
    await loadWeatherNext([nyc]);
    await loadWeatherNext([nyc, london]);
    assert.equal(calls.length, 2);
    assert.match(calls[1].sql, /-0\.1278 51\.5074/);
    assert.ok(!calls[1].sql.includes("-73.9654"));
  });

  it("errors back off instead of retrying every tick", async () => {
    runnerFor(() => {
      throw new Error("403 Access Denied");
    });
    const orig = console.error;
    console.error = () => {};
    try {
      const a = await loadWeatherNext([nyc]);
      assert.equal(a.byCity.size, 0);
      assert.match(a.error ?? "", /403/);
      await loadWeatherNext([nyc]);
      assert.equal(calls.length, 1);
    } finally {
      console.error = orig;
    }
  });

  it("refuses to query past the daily byte cap", async () => {
    _setWeatherNextConfig({ ...cfg, dailyCapBytes: 50 * MIB });
    runnerFor(defaultHandler());
    const orig = console.warn;
    console.warn = () => {};
    try {
      const a = await loadWeatherNext([nyc]);
      // the dry-run probe is free; the ~95 MiB fetch does not fit
      assert.equal(calls.length, 0);
      assert.equal(a.byCity.size, 0);
      assert.match(a.error ?? "", /budget/);
    } finally {
      console.warn = orig;
    }
  });

  it("unconfigured → no queries", async () => {
    _setWeatherNextConfig(null);
    runnerFor(defaultHandler());
    const a = await loadWeatherNext([nyc]);
    assert.equal(a.configured, false);
    assert.equal(calls.length, 0);
  });
});

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function omEnsembleBody(dates: string[], n = 10) {
  const daily: Record<string, Array<number | string | null>> = { time: dates, temperature_2m_max: dates.map(() => 18) };
  for (let i = 1; i < n; i++) daily[`temperature_2m_max_member${String(i).padStart(2, "0")}`] = dates.map(() => 18 + i * 0.1);
  return { latitude: 0, longitude: 0, daily };
}

describe("loadWeather with WeatherNext primary", () => {
  function stub(fetchLog: string[]) {
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      fetchLog.push(url);
      if (url.includes("ensemble-api.open-meteo.com")) {
        const tz = new URL(url).searchParams.get("timezone") ?? "UTC";
        const d = new Intl.DateTimeFormat("en-CA", { timeZone: tz }).format(new Date());
        return jsonResponse(omEnsembleBody([d]));
      }
      if (url.includes("previous-runs-api.open-meteo.com")) return jsonResponse({});
      if (url.includes("aviationweather.gov")) return jsonResponse([]);
      return jsonResponse({}, 404);
    }) as typeof fetch;
  }

  it("WeatherNext city uses WN members + source; uncovered city falls back to Open-Meteo ensemble only for itself", async () => {
    const fetchLog: string[] = [];
    stub(fetchLog);
    runnerFor(defaultHandler(latestInit(), [1])); // index 1 (tokyo) returns no cells
    const wx = await loadWeather([nyc, tokyo]);
    assert.match(wx.nyc.source, /^WeatherNext 3 \(init \d\d-\d\d \d\dZ\)/);
    assert.ok(!wx.nyc.source.includes("Open-Meteo ensemble"));
    const wnDates = Object.keys(wx.nyc.membersByDate);
    assert.ok(wnDates.length >= 2);
    for (const d of wnDates) assert.equal(wx.nyc.membersByDate[d].length, 50);
    // membersC is strictly membersByDate[localDate] (or empty) — never another day.
    assert.deepEqual(wx.nyc.membersC, wx.nyc.membersByDate[wx.nyc.localDate] ?? []);
    assert.ok(wx.tokyo.source.includes("Open-Meteo ensemble"));
    assert.ok(!wx.tokyo.source.includes("WeatherNext"));
    const ens = fetchLog.filter((u) => u.includes("ensemble-api"));
    assert.equal(ens.length, 1);
    assert.match(ens[0], /latitude=35\.6762&/);
  });

  it("WeatherNext failure → every city falls back to Open-Meteo ensemble", async () => {
    const fetchLog: string[] = [];
    stub(fetchLog);
    runnerFor(() => {
      throw new Error("boom");
    });
    const orig = console.error;
    console.error = () => {};
    try {
      const wx = await loadWeather([nyc]);
      assert.ok(wx.nyc.source.includes("Open-Meteo ensemble"));
      assert.ok(!wx.nyc.source.includes("WeatherNext"));
      assert.ok(wx.nyc.membersC.length >= 8);
    } finally {
      console.error = orig;
    }
  });
});
