import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { groupCitiesByTimezone } from "./weather.ts";
import type { CityMeta } from "./types.ts";

function city(id: string, tz: string): CityMeta {
  return { id, name: id, aliases: [], lat: 1, lon: 1, tz, icao: "", country: "" };
}

describe("groupCitiesByTimezone", () => {
  it("does not put Toronto and Hong Kong in one auto batch", () => {
    const groups = groupCitiesByTimezone([
      city("toronto", "America/Toronto"),
      city("hong-kong", "Asia/Hong_Kong"),
      city("nyc", "America/New_York"),
    ]);
    assert.equal(groups.size, 3);
    assert.deepEqual(groups.get("America/Toronto")?.map((c) => c.id), ["toronto"]);
    assert.deepEqual(groups.get("Asia/Hong_Kong")?.map((c) => c.id), ["hong-kong"]);
  });
});
