import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { MIN_ENSEMBLE_MEMBERS, ensembleOk } from "./ensemble.ts";

describe("ensemble gate", () => {
  it("members=[] is not tradeable", () => {
    assert.equal(MIN_ENSEMBLE_MEMBERS, 8);
    assert.equal(ensembleOk([]), false);
  });

  it("requires at least 8 members", () => {
    assert.equal(ensembleOk(Array.from({ length: 7 }, () => 20)), false);
    assert.equal(ensembleOk(Array.from({ length: 8 }, () => 20)), true);
  });
});
