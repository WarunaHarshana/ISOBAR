import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  PAPER_MIN_EDGE,
  PAPER_MIN_PRICE,
  PAPER_MAX_PRICE,
  PAPER_MAX_OPEN,
  PAPER_MAX_OPEN_PER_EVENT,
  PAPER_MAX_OPEN_PER_CITY_DATE,
  PAPER_MIN_STAKE,
  _resetPaperBookCache,
  availableCash,
  conservativeFillPrice,
  emptyBook,
  liveTradingLocked,
  loadPaperBook,
  paperTrade,
  patchSettings,
  realizedPnl,
  savePaperBook,
  settleFills,
  truncateFills,
  type PaperBook,
} from "./paper-book.ts";
import type { PaperFill, Signal } from "./types.ts";

function signal(over: Partial<Signal> = {}): Signal {
  return {
    id: "m1-YES",
    eventId: "ev1",
    marketId: "m1",
    cityId: "nyc",
    cityName: "New York",
    date: "2026-09-04",
    kind: "high",
    unit: "F",
    question: "Will the highest temperature be 80°F?",
    label: "80°F",
    side: "YES",
    marketP: 0.4,
    modelP: 0.55,
    edge: 0.15,
    kelly: 0.5,
    volume24hr: 1000,
    ...over,
  };
}

function openFill(over: Partial<PaperFill> = {}): PaperFill {
  return {
    id: `f-${Math.random().toString(36).slice(2)}`,
    eventId: "ev1",
    marketId: "m1",
    cityId: "nyc",
    cityName: "New York",
    date: "2026-09-04",
    question: "q",
    side: "YES",
    price: 0.4,
    shares: 25,
    cost: 10,
    modelP: 0.55,
    placedAt: new Date().toISOString(),
    status: "open",
    payout: 0,
    ...over,
  };
}

let dataDir: string;
const savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), "isobar-paper-"));
  for (const k of ["ISOBAR_DATA_DIR", "ISOBAR_LIVE", "ISOBAR_PAPER_ARMED", "PRIVATE_KEY", "POLYMARKET_PRIVATE_KEY"]) {
    savedEnv[k] = process.env[k];
    delete process.env[k];
  }
  process.env.ISOBAR_DATA_DIR = dataDir;
  _resetPaperBookCache();
});

afterEach(() => {
  _resetPaperBookCache();
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  rmSync(dataDir, { recursive: true, force: true });
});

describe("live lock", () => {
  it("refuses arm when ISOBAR_LIVE is set", () => {
    process.env.ISOBAR_LIVE = "true";
    assert.match(liveTradingLocked() ?? "", /ISOBAR_LIVE/);
    assert.equal(patchSettings({ armed: true }).settings.armed, false);
  });

  it("refuses fills when PRIVATE_KEY is set", () => {
    process.env.PRIVATE_KEY = "0xabc";
    assert.equal(paperTrade(signal(), emptyBook()), null);
  });
});

describe("floors", () => {
  it("matches snapshot floors", () => {
    assert.equal(PAPER_MIN_EDGE, 0.06);
    assert.equal(PAPER_MIN_PRICE, 0.05);
    assert.equal(PAPER_MAX_PRICE, 0.85);
  });
});

describe("sizing", () => {
  it("cash = bankroll + closed - openCost", () => {
    const fills = [
      openFill({ cost: 800 }),
      openFill({ id: "w", marketId: "m2", eventId: "e2", status: "won", cost: 100, payout: 250 }),
    ];
    assert.equal(availableCash({ ...emptyBook(), fills }), 9350);
  });

  it("kelly 0.50 * 0.12 on 10k => stake 600", () => {
    const fill = paperTrade(signal({ kelly: 0.5 }), emptyBook(), { fillPrice: 0.4 });
    assert.ok(fill);
    assert.ok(Math.abs(fill!.cost - 600) < 1e-6);
    assert.ok(fill!.cost >= PAPER_MIN_STAKE);
  });

  it("skips stake under $5; YES ask / NO implied ask from yesBid", () => {
    assert.equal(conservativeFillPrice("YES", 0.4, 0.38, 0.45), 0.45);
    assert.equal(conservativeFillPrice("NO", 0.4, 0.5, null), 0.5);
    assert.equal(conservativeFillPrice("NO", 0.4, 0.7, null), 0.4);
    assert.equal(paperTrade(signal({ kelly: 0.001 }), emptyBook()), null);
  });

  it("open-cost reduces next cash", () => {
    const book: PaperBook = {
      ...emptyBook(),
      fills: [openFill({ cost: 800, marketId: "o1", eventId: "eo", cityId: "bos" })],
    };
    assert.equal(availableCash(book), 9200);
    const fill = paperTrade(signal({ marketId: "m2", eventId: "e2", cityId: "chi" }), book);
    assert.ok(fill);
    assert.ok(Math.abs(fill!.cost - 552) < 1e-6);
  });
});

describe("caps", () => {
  it("enforces open/event/city-date caps", () => {
    const fills = Array.from({ length: PAPER_MAX_OPEN }, (_, i) =>
      openFill({ id: `o${i}`, marketId: `mx${i}`, eventId: `evx${i}`, cityId: `c${i}` }),
    );
    assert.equal(paperTrade(signal({ marketId: "n", eventId: "n", cityId: "n" }), { ...emptyBook(), fills }), null);
    assert.equal(paperTrade(signal({ eventId: "ev1", marketId: "m2" }), { ...emptyBook(), fills: [openFill()] }), null);
    assert.equal(PAPER_MAX_OPEN_PER_EVENT, 1);
    assert.equal(PAPER_MAX_OPEN_PER_CITY_DATE, 2);
    const two = {
      ...emptyBook(),
      fills: [
        openFill({ id: "a", marketId: "a", eventId: "eA", cityId: "nyc", date: "2026-09-04" }),
        openFill({ id: "b", marketId: "b", eventId: "eB", cityId: "nyc", date: "2026-09-04" }),
      ],
    };
    assert.equal(paperTrade(signal({ marketId: "c", eventId: "eC" }), two), null);
  });
});

describe("settlement", () => {
  it("99c unclosed stays open; settleFills with winner pays shares", () => {
    const fills = [openFill({ marketId: "hot", price: 0.99 })];
    assert.equal(fills[0].status, "open");
    const settled = settleFills(fills, "hot", true);
    assert.equal(settled[0].status, "won");
    assert.equal(settled[0].payout, fills[0].shares);
  });
});

describe("truncateFills", () => {
  it("never drops open rows", () => {
    const opens = Array.from({ length: 5 }, (_, i) =>
      openFill({ id: `open-${i}`, marketId: `o${i}`, eventId: `e${i}`, cityId: `c${i}` }),
    );
    const closed = Array.from({ length: 100 }, (_, i) =>
      openFill({
        id: `closed-${i}`,
        marketId: `cl${i}`,
        eventId: `ce${i}`,
        cityId: `cc${i}`,
        status: "won",
        payout: 10,
      }),
    );
    const trimmed = truncateFills([...opens, ...closed]);
    assert.equal(trimmed.filter((f) => f.status === "open").length, 5);
    assert.ok(trimmed.length <= 80);
    assert.equal(realizedPnl([]).closed, 0);
  });
});

describe("persist", () => {
  it("loads under ISOBAR_DATA_DIR", () => {
    const b = loadPaperBook();
    b.settings.bankroll = 12345;
    savePaperBook(b);
    _resetPaperBookCache();
    assert.equal(loadPaperBook().settings.bankroll, 12345);
  });
});

describe("predictioner gate", () => {
  it("Helsinki 40°C winter YES with thin members returns null", () => {
    const hel = signal({
      cityId: "helsinki",
      cityName: "Helsinki",
      date: "2026-01-15",
      kind: "high",
      unit: "C",
      label: "40°C",
      question: "Will the highest temperature in Helsinki be 40°C?",
      side: "YES",
      marketP: 0.2,
      modelP: 0.25,
      edge: 0.15,
      kelly: 0.5,
    });
    assert.equal(paperTrade(hel, emptyBook(), { fillPrice: 0.2, members: [] }), null);
    assert.equal(
      paperTrade(hel, emptyBook(), { fillPrice: 0.2, members: [1, 2, 3] }),
      null,
    );
  });

  it("Helsinki 40°C Jan YES vetoes even with fat ensemble (climatology)", () => {
    const hel = signal({
      cityId: "helsinki",
      cityName: "Helsinki",
      date: "2026-01-15",
      kind: "high",
      unit: "C",
      label: "40°C",
      side: "YES",
      marketP: 0.2,
      modelP: 0.25,
      edge: 0.15,
      kelly: 0.5,
    });
    const members = Array.from({ length: 31 }, () => -2);
    assert.equal(paperTrade(hel, emptyBook(), { fillPrice: 0.2, members }), null);
  });
});
