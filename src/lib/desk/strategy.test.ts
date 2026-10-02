/**
 * Backtest-fitted strategy: YES floor, taker fee, model/market blend, station bias,
 * order-book depth fills, research log.
 */
import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { gunzipSync } from "node:zlib";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  LEGACY_STRATEGY,
  _setStrategyParams,
  blendProb,
  blendWeight,
  debiasMembers,
  limitPrice,
  marketMid,
  shrinkBiases,
  strategy,
  strategyFromEnv,
  takerFee,
  walkAsks,
} from "./strategy.ts";
import { MODEL_PARAMS } from "./model-params.ts";
import {
  PAPER_MIN_EDGE,
  PAPER_MIN_PRICE_YES,
  emptyBook,
  fillMarkPnl,
  paperTrade,
  realizedPnl,
} from "./paper-book.ts";
import { assembleDeskSnapshot, pricingModel } from "./snapshot.ts";
import {
  _resetForecastLog,
  appendLog,
  marketRecord,
  rotateLogs,
  snapshotDue,
  wnInitRecords,
} from "./forecast-log.ts";
import { parseFetchRows } from "./weathernext.ts";
import type { CityMeta, PaperFill, Signal, WeatherNow } from "./types.ts";
import type { ParsedEvent } from "./polymarket.ts";

afterEach(() => _setStrategyParams(null));

const sig = (over: Partial<Signal> = {}): Signal => ({
  id: "m-YES",
  eventId: "e",
  marketId: "m",
  cityId: "nyc",
  cityName: "NYC",
  date: "2099-01-01",
  kind: "high",
  unit: "C",
  question: "q",
  label: "20°C",
  side: "YES",
  marketP: 0.3,
  modelP: 0.6,
  edge: 0.25,
  kelly: 0.4,
  volume24hr: 0,
  ...over,
});

describe("strategy params", () => {
  it("defaults come from model-params.ts; env overrides are clamped", () => {
    const d = strategyFromEnv({});
    assert.equal(d.minPriceYes, MODEL_PARAMS.minPriceYes);
    assert.ok(d.minPriceYes >= 0.1 && d.minPriceYes <= 0.15, "YES floor chosen inside 10–15¢");
    assert.equal(PAPER_MIN_PRICE_YES, MODEL_PARAMS.minPriceYes);
    assert.equal(d.takerFeeRate, 0.05);
    assert.equal(strategyFromEnv({ ISOBAR_PAPER_MIN_PRICE_YES: "0.10" }).minPriceYes, 0.1);
    assert.equal(strategyFromEnv({ ISOBAR_PAPER_MIN_PRICE_YES: "9" }).minPriceYes, 0.5);
    assert.equal(strategyFromEnv({ ISOBAR_BLEND_DISABLED: "true" }).blend, null);
    assert.deepEqual(strategyFromEnv({ ISOBAR_STATION_BIAS_DISABLED: "1" }).stationBiasC, {});
    assert.deepEqual(
      strategyFromEnv({ ISOBAR_BLEND_AHEAD: "0.2", ISOBAR_BLEND_SAMEDAY: "9:0.1, 15:0.6" }).blend,
      {
        ahead: 0.2,
        sameDay: [
          [9, 0.1],
          [15, 0.6],
        ],
      },
    );
  });

  it("taker fee = 0.05·p·(1−p) per share (Polymarket weather schedule)", () => {
    assert.equal(takerFee(0.5), 0.0125);
    assert.ok(Math.abs(takerFee(0.1) - 0.0045) < 1e-12);
    assert.equal(takerFee(0), 0);
    assert.equal(takerFee(1), 0);
    // 100 shares at 30¢ → $1.05, the docs' weather table value.
    assert.ok(Math.abs(100 * takerFee(0.3) - 1.05) < 1e-9);
  });

  it("blend weight: one number for later dates, piecewise-linear by local hour on the live day", () => {
    _setStrategyParams({
      blend: {
        ahead: 0.1,
        sameDay: [
          [9, 0.2],
          [13, 0.4],
          [16, 0.6],
        ],
      },
    });
    const tz = "Asia/Shanghai"; // UTC+8
    assert.equal(blendWeight("2026-10-03", tz, new Date("2026-10-02T04:00:00Z")), 0.1); // tomorrow
    assert.equal(blendWeight("2026-10-02", tz, new Date("2026-10-01T23:00:00Z")), 0.2); // 07:00 local, flat before 9
    assert.ok(
      Math.abs(blendWeight("2026-10-02", tz, new Date("2026-10-02T03:00:00Z")) - 0.3) < 1e-9,
    ); // 11:00
    assert.equal(blendWeight("2026-10-02", tz, new Date("2026-10-02T11:00:00Z")), 0.6); // 19:00, flat after 16
    assert.equal(blendWeight("2026-10-02", tz, new Date(), null), 1); // blend off → model only
    assert.equal(blendProb(0.8, 0.4, 0.25), 0.5);
    assert.equal(blendProb(0.8, null, 0.25), 0.8);
    assert.equal(marketMid({ yesPrice: 0.5, bestBid: 0.3, bestAsk: 0.4 }), 0.35);
    assert.equal(marketMid({ yesPrice: 0.5, bestBid: null, bestAsk: 0.4 }), 0.5);
  });

  it("James–Stein shrink toward 0: more days and less noise → closer to the raw mean", () => {
    const noisy = [-3, 1, -2, 2, -3, 0];
    const tight = [-1.1, -0.9, -1, -1.05, -0.95, -1, -1, -1, -1, -1];
    const r = shrinkBiases({ a: tight, b: noisy, c: [0.5, 0.6, 0.4, 0.5, 0.5], few: [5, 5] });
    assert.ok(r.tau2 > 0);
    assert.equal(r.cities.few, undefined, "stations with < 5 days get no correction");
    assert.ok(r.cities.a.k > 0.9 && Math.abs(r.cities.a.correctionC + 1) < 0.1);
    assert.ok(r.cities.b.k < r.cities.a.k);
    assert.ok(Math.abs(r.cities.b.correctionC) < Math.abs(r.cities.b.meanC));
    assert.deepEqual(shrinkBiases({ z: [0.01, -0.01, 0.02, -0.02, 0] }).cities.z.correctionC, 0);
  });

  it("station bias shifts high members by −bias; lows untouched by default", () => {
    _setStrategyParams({ stationBiasC: { taipei: -1.5 } });
    assert.deepEqual(debiasMembers([20, 21], "taipei"), [21.5, 22.5]);
    assert.deepEqual(debiasMembers([20, 21], "taipei", "low"), [20, 21]);
    assert.deepEqual(debiasMembers([20, 21], "nowhere"), [20, 21]);
    const wx = {
      membersByDate: { "2099-01-01": [20, 21] },
      membersMinByDate: {},
      localDate: "2098-12-31",
    } as unknown as WeatherNow;
    assert.deepEqual(
      pricingModel(wx, { date: "2099-01-01", kind: "high", cityId: "taipei" }, "Asia/Taipei")
        .members,
      [21.5, 22.5],
    );
    assert.deepEqual(
      pricingModel(wx, { date: "2099-01-01", kind: "high" }, "Asia/Taipei").members,
      [20, 21],
    );
  });
});

describe("snapshot: blended, fee-net edges and the YES floor", () => {
  const city: CityMeta = {
    id: "x",
    name: "X",
    aliases: [],
    lat: 1,
    lon: 1,
    tz: "UTC",
    icao: "",
    country: "X",
  };
  const members = Array.from({ length: 40 }, (_, i) => 20 + (i - 20) * 0.02); // tight around 20°C
  const wx = {
    membersByDate: { "2099-01-02": members },
    membersMinByDate: {},
    localDate: "2099-01-01",
    hourly: [],
    source: "WeatherNext 3",
    observedMaxC: null,
    observedMinC: null,
  } as unknown as WeatherNow;
  const mk = (n: number, yes: number, ask: number) => ({
    id: `m${n}`,
    question: `Will the highest temperature in X be ${n}°C on Jan 2?`,
    bound: { lo: n - 0.5, hi: n + 0.5, kind: "exact" as const, label: `${n}°C` },
    yesPrice: yes,
    noPrice: 1 - yes,
    bestBid: yes - 0.01,
    bestAsk: ask,
    spread: 0.02,
    tokens: [`y${n}`, `n${n}`],
  });
  const ev = (yes20: number, ask20: number): ParsedEvent => ({
    eventId: "e",
    slug: "s",
    title: "Highest temperature in X on January 2?",
    city,
    cityRaw: "X",
    kind: "high",
    unit: "C",
    eventDate: "2099-01-02",
    endDate: "",
    volume: 0,
    volume24hr: 0,
    liquidity: 0,
    image: null,
    context: null,
    settlement: "round",
    markets: [
      mk(18, 0.05, 0.06),
      mk(19, 0.15, 0.16),
      mk(20, yes20, ask20),
      mk(21, 0.15, 0.16),
      mk(22, 0.05, 0.06),
    ] as unknown as ParsedEvent["markets"],
  });
  const now = new Date("2099-01-01T12:00:00Z");

  it("edge = blendP − ask − fee; blendP = w·model + (1−w)·mid; tokens exposed for the book walk", () => {
    _setStrategyParams({ blend: { ahead: 0.9, sameDay: [] }, stationBiasC: {}, minPriceYes: 0.12 });
    const s = assembleDeskSnapshot({ events: [ev(0.2, 0.22)], weather: { x: wx }, now });
    const b = s.events[0].buckets.find((x) => x.label === "20°C")!;
    assert.ok(b.modelP > 0.3, `modelP ${b.modelP}`);
    assert.ok(Math.abs(b.marketMid! - 0.205) < 1e-9);
    assert.equal(b.blendW, 0.9);
    assert.ok(Math.abs(b.blendP! - (0.9 * b.modelP + 0.1 * 0.205)) < 1e-9);
    assert.ok(Math.abs(b.edgeYes - (b.blendP! - 0.22 - takerFee(0.22))) < 1e-9);
    assert.equal(b.clobYes, "y20");
    assert.equal(b.clobNo, "n20");
    const y = s.signals.find((x) => x.side === "YES")!;
    assert.equal(y.marketId, "m20");
    assert.ok(Math.abs(y.modelP - b.blendP!) < 1e-12);
    assert.equal(y.rawModelP, b.modelP);
  });

  it("w = 0 (market only) never trades: the edge is −half-spread − fee", () => {
    _setStrategyParams({ blend: { ahead: 0, sameDay: [] }, stationBiasC: {} });
    const s = assembleDeskSnapshot({ events: [ev(0.4, 0.42)], weather: { x: wx }, now });
    assert.equal(s.signals.length, 0);
  });

  it("YES floor: a modal YES with an ask under the floor is not a signal", () => {
    _setStrategyParams({ blend: null, stationBiasC: {}, minPriceYes: 0.12 });
    assert.equal(
      assembleDeskSnapshot({ events: [ev(0.09, 0.1)], weather: { x: wx }, now }).signals.filter(
        (x) => x.side === "YES",
      ).length,
      0,
    );
    _setStrategyParams({ blend: null, stationBiasC: {}, minPriceYes: 0.03 });
    assert.equal(
      assembleDeskSnapshot({ events: [ev(0.09, 0.1)], weather: { x: wx }, now }).signals.filter(
        (x) => x.side === "YES",
      ).length,
      1,
    );
  });
});

describe("paper fills walk the real order book", () => {
  beforeEach(() =>
    _setStrategyParams({ ...LEGACY_STRATEGY, takerFeeRate: 0.05, minPriceYes: 0.12 }),
  );

  it("walkAsks: VWAP up to the limit, partial when the book runs out", () => {
    const w = walkAsks(
      [
        { price: 0.32, size: 1000 },
        { price: 0.3, size: 100 },
        { price: 0.4, size: 1000 },
      ],
      100,
      0.35,
    );
    assert.equal(w.levels, 2);
    assert.ok(Math.abs(w.shares - (100 + 70 / 0.32)) < 1e-9);
    assert.ok(Math.abs(w.cost - 100) < 1e-9);
    assert.equal(w.partial, false);
    const p = walkAsks(
      [
        { price: 0.3, size: 50 },
        { price: 0.5, size: 1000 },
      ],
      100,
      0.35,
    );
    assert.equal(p.partial, true);
    assert.ok(Math.abs(p.cost - 15) < 1e-9);
    assert.equal(p.vwap, 0.3);
  });

  it("limitPrice: highest price with p − x − fee(x) ≥ min edge", () => {
    const x = limitPrice(0.6, 0.06, 0.85, 0.05);
    assert.ok(0.6 - x - takerFee(x, 0.05) >= 0.06 - 1e-9);
    assert.ok(0.6 - (x + 0.002) - takerFee(x + 0.002, 0.05) < 0.06);
    assert.equal(limitPrice(0.99, 0.06, 0.85, 0.05), 0.85);
    assert.equal(limitPrice(0.05, 0.06, 0.85, 0.05), 0);
  });

  it("Kelly target caps the walk; thin book → depth-limited partial fill at the VWAP; fee recorded", () => {
    const book = { ...emptyBook(), fills: [] as PaperFill[] };
    const deep = paperTrade(sig(), book, { asks: [{ price: 0.3, size: 100000 }] })!;
    assert.ok(deep);
    const target = deep.cost;
    assert.ok(target > 50 && target <= 800 + 1e-9);
    assert.equal(deep.depthLimited, false);
    assert.ok(Math.abs(deep.fee! - deep.shares * takerFee(0.3)) < 1e-4);
    const thin = paperTrade(sig(), book, {
      asks: [
        { price: 0.3, size: 100 },
        { price: 0.33, size: 100 },
        { price: 0.7, size: 5000 },
      ],
    })!;
    assert.equal(thin.depthLimited, true);
    assert.equal(thin.requestedStake, target);
    assert.ok(Math.abs(thin.cost - 63) < 1e-9);
    assert.ok(Math.abs(thin.price - 63 / 200) < 1e-9);
    assert.equal(thin.bookLevels, 2);
    assert.ok(thin.limitPrice! < 0.7);
  });

  it("no fill when the best ask kills the net edge, or the walk can't reach $5", () => {
    const book = { ...emptyBook(), fills: [] as PaperFill[] };
    assert.equal(paperTrade(sig(), book, { asks: [{ price: 0.55, size: 1000 }] }), null);
    assert.equal(paperTrade(sig(), book, { asks: [{ price: 0.3, size: 10 }] }), null);
    assert.equal(paperTrade(sig(), book, { asks: [] }), null);
  });

  it("fees come out of realized and mark-to-market PnL", () => {
    const f: PaperFill = {
      id: "f",
      eventId: "e",
      marketId: "m",
      cityId: "c",
      cityName: "C",
      date: "d",
      question: "q",
      side: "YES",
      price: 0.5,
      shares: 100,
      cost: 50,
      modelP: 0.7,
      placedAt: "",
      status: "won",
      payout: 100,
      fee: 1.25,
    };
    assert.equal(realizedPnl([f]).closed, 48.75);
    assert.equal(fillMarkPnl(f), 48.75);
    assert.equal(fillMarkPnl({ ...f, status: "open", payout: 0 }), -1.25);
  });
});

describe("research log (append-only JSONL under /data/logs)", () => {
  let dir: string;
  const env = () => ({ ISOBAR_DATA_DIR: dir, ISOBAR_LOG_MAX_MB: "1" });
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "isobar-log-"));
    _resetForecastLog();
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("appends one JSON line per record into a per-UTC-day file", () => {
    assert.ok(appendLog([{ t: "a", x: 1 }, { t: "b" }], new Date("2026-10-02T01:00:00Z"), env()));
    assert.ok(appendLog([{ t: "c" }], new Date("2026-10-02T23:00:00Z"), env()));
    const lines = readFileSync(join(dir, "logs", "isobar-2026-10-02.jsonl"), "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
    assert.deepEqual(
      lines.map((l) => l.t),
      ["a", "b", "c"],
    );
    assert.equal(lines[0].at, "2026-10-02T01:00:00.000Z");
    assert.equal(
      appendLog([{ t: "x" }], new Date(), { ...env(), ISOBAR_LOG_DISABLED: "true" }),
      false,
    );
  });

  it("a new day gzips the previous files; the size cap drops the oldest archives, never today's file", () => {
    appendLog([{ t: "a", pad: "x".repeat(1000) }], new Date("2026-10-01T10:00:00Z"), env());
    appendLog([{ t: "b" }], new Date("2026-10-02T10:00:00Z"), env());
    const names = readdirSync(join(dir, "logs")).sort();
    assert.deepEqual(names, ["isobar-2026-10-01.jsonl.gz", "isobar-2026-10-02.jsonl"]);
    assert.equal(
      JSON.parse(gunzipSync(readFileSync(join(dir, "logs", names[0]))).toString()).t,
      "a",
    );
    // Cap: 3 archives of ~600 KB random data under a 1 MB cap → oldest removed first.
    const logs = join(dir, "logs");
    for (const d of ["2026-09-01", "2026-09-02"])
      writeFileSync(join(logs, `isobar-${d}.jsonl.gz`), Buffer.alloc(600_000, 1));
    const total = rotateLogs(logs, "2026-10-02", 1024 * 1024);
    assert.ok(total <= 1024 * 1024);
    assert.ok(!existsSync(join(logs, "isobar-2026-09-01.jsonl.gz")));
    assert.ok(existsSync(join(logs, "isobar-2026-10-02.jsonl")));
    assert.ok(statSync(join(logs, "isobar-2026-10-02.jsonl")).size > 0);
  });

  it("snapshot throttle and record shapes (wn_init quantiles + members, market buckets)", () => {
    assert.equal(snapshotDue(1_000_000, { ISOBAR_LOG_SNAPSHOT_MIN: "15" }), true);
    assert.equal(snapshotDue(1_000_000 + 60_000, { ISOBAR_LOG_SNAPSHOT_MIN: "15" }), false);
    assert.equal(snapshotDue(1_000_000 + 15 * 60_000, { ISOBAR_LOG_SNAPSHOT_MIN: "15" }), true);
    const city = {
      id: "nyc",
      name: "NYC",
      aliases: [],
      lat: 40.7,
      lon: -73.9,
      tz: "America/New_York",
      icao: "KLGA",
      country: "US",
    } as CityMeta;
    const rows = Array.from({ length: 40 }, (_, h) => ({
      i: 0,
      init_time: "2026-10-01 00:00:00",
      lon: -73.9,
      lat: 40.7,
      hours: h,
      p10: 290,
      p50: 292,
      p90: 294,
    }));
    const parsed = parseFetchRows(rows, [city]);
    const rec = wnInitRecords(rows, [city], parsed, Number) as Array<Record<string, unknown>>;
    assert.equal(rec.length, 1);
    assert.equal(rec[0].t, "wn_init");
    assert.equal(rec[0].init, "2026-10-01T00:00:00.000Z");
    assert.deepEqual((rec[0].q as number[][])[0], [0, 16.85, 18.85, 20.85]);
    assert.ok(Object.keys(rec[0].maxMembers as object).length >= 1);
    const m = marketRecord({
      fetchedAt: "t",
      weather: { nyc: { source: "WeatherNext 3 (init 10-01 00Z)" } },
      events: [
        {
          eventId: "e",
          cityId: "nyc",
          kind: "high",
          unit: "F",
          eventDate: "2026-10-02",
          observed: 70,
          buckets: [
            {
              marketId: "m",
              label: "70-71°F",
              lo: 69.5,
              hi: Infinity,
              yesPrice: 0.4,
              bestBid: 0.39,
              bestAsk: 0.41,
              modelP: 0.5123456,
              blendP: 0.45,
              blendW: 0.3,
              volume: 1234.4,
            },
          ],
        },
      ],
    });
    assert.deepEqual((m.events[0].b as unknown[][])[0], [
      "m",
      "70-71°F",
      69.5,
      null,
      0.4,
      0.39,
      0.41,
      0.5123,
      0.45,
      1234,
    ]);
    assert.equal(m.events[0].w, 0.3);
  });
});

// Sanity: the live default strategy object is consistent with model-params.ts.
describe("defaults", () => {
  it("strategy() mirrors model-params unless overridden", () => {
    _setStrategyParams(null);
    assert.equal(strategy().minPriceYes, MODEL_PARAMS.minPriceYes);
    assert.ok(PAPER_MIN_EDGE > 0);
  });
});
