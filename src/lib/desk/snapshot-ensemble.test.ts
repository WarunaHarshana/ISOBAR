import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ensembleOk } from "./ensemble.ts";

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
