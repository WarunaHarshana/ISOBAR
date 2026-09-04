import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { kdeBandwidth, membersNearBucket } from "./math.ts";

describe("membersNearBucket", () => {
  it("empty members is no support", () => {
    assert.equal(membersNearBucket([], 80, 81, "F", "2026-09-04"), false);
  });

  it("27C members are near 80F and not near 110F", () => {
    const members = Array.from({ length: 8 }, () => 27);
    assert.equal(membersNearBucket(members, 80, 81, "F", "2026-09-04"), true);
    assert.equal(membersNearBucket(members, 110, 111, "F", "2026-09-04"), false);
  });

  it("kdeBandwidth is at least the unit floor", () => {
    assert.ok(kdeBandwidth([20, 20, 20, 20], "C", "2026-09-04") >= 0.65);
    assert.ok(kdeBandwidth([68, 68, 68, 68], "F", "2026-09-04") >= 1.1);
  });
});
