import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { plausibilityVeto, parseLabelTemp } from "./plausibility.ts";
import type { Signal } from "./types.ts";

function signal(over: Partial<Signal> = {}): Signal {
  return {
    id: "m1-YES",
    eventId: "ev1",
    marketId: "m1",
    cityId: "nyc",
    cityName: "New York",
    date: "2026-07-15",
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

describe("plausibilityVeto Predictioner v1", () => {
  it("Helsinki winter YES ~40°C → impossible vs season/climatology", () => {
    const r = plausibilityVeto(
      signal({
        cityId: "helsinki",
        cityName: "Helsinki",
        date: "2026-01-15",
        kind: "high",
        unit: "C",
        label: "40°C",
        question: "Will the highest temperature in Helsinki be 40°C?",
        side: "YES",
        modelP: 0.2,
      }),
      { members: Array.from({ length: 31 }, (_, i) => -5 + i * 0.1) },
    );
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.reason, "impossible vs season/climatology");
  });

  it("normal mid-range with 31 members → ok:true", () => {
    const members = Array.from({ length: 31 }, (_, i) => 78 + (i - 15) * 0.2);
    const r = plausibilityVeto(
      signal({
        cityId: "nyc",
        cityName: "New York",
        date: "2026-07-15",
        unit: "F",
        label: "80°F",
        side: "YES",
        modelP: 0.4,
      }),
      { members, observedC: 22 },
    );
    assert.equal(r.ok, true);
  });

  it("members=[] → thin ensemble (<8)", () => {
    const r = plausibilityVeto(signal(), { members: [] });
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.reason, "thin ensemble (<8)");
  });

  it("members length 7 → thin ensemble (<8)", () => {
    const r = plausibilityVeto(signal(), { members: [1, 2, 3, 4, 5, 6, 7] });
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.reason, "thin ensemble (<8)");
  });

  it("obs already past bucket for YES high", () => {
    const r = plausibilityVeto(
      signal({
        unit: "C",
        label: "30°C",
        side: "YES",
        kind: "high",
      }),
      {
        members: Array.from({ length: 31 }, () => 28),
        observedC: 31, // already past [30, 31)
      },
    );
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.reason, "obs already past bucket");
  });

  it("modelP≈0 with no members in bucket → veto (does not mutate modelP)", () => {
    const sig = signal({
      unit: "C",
      label: "40°C",
      side: "YES",
      modelP: 0,
    });
    const before = sig.modelP;
    const members = Array.from({ length: 31 }, () => 20); // none in [40,41)
    const r = plausibilityVeto(sig, { members });
    assert.equal(r.ok, false);
    if (!r.ok) assert.match(r.reason, /modelP/);
    assert.equal(sig.modelP, before);
  });

  it("YES with explicit lo far from members → no ensemble support near bucket", () => {
    const r = plausibilityVeto(
      signal({
        unit: "C",
        label: "40°C",
        side: "YES",
        modelP: 0.12,
      }),
      {
        members: Array.from({ length: 31 }, () => 20),
        lo: 40,
        hi: 41,
      },
    );
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.reason, "no ensemble support near bucket");
  });

  it("YES with members near explicit bucket still ok", () => {
    const r = plausibilityVeto(
      signal({
        unit: "C",
        label: "20°C",
        side: "YES",
        modelP: 0.4,
      }),
      {
        members: Array.from({ length: 31 }, () => 20),
        lo: 20,
        hi: 21,
      },
    );
    assert.equal(r.ok, true);
  });

  it("parseLabelTemp reads 40°C and 95°F", () => {
    assert.deepEqual(parseLabelTemp("40°C"), { value: 40, unit: "C" });
    assert.deepEqual(parseLabelTemp("95°F"), { value: 95, unit: "F" });
  });
});
