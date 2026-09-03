import { createServerFn } from "@tanstack/react-start";
import { buildDeskSnapshot } from "./snapshot";
import type { DeskSnapshot } from "./types";

function emptySnapshot(warning: string): DeskSnapshot {
  return {
    fetchedAt: new Date().toISOString(),
    events: [],
    weather: {},
    signals: [],
    totals: { events: 0, cities: 0, volume24hr: 0, openSignals: 0 },
    sources: [],
    warning,
  };
}

export const fetchDeskSnapshot = createServerFn({ method: "GET" }).handler(async () => {
  try {
    return await buildDeskSnapshot();
  } catch (err) {
    const message = err instanceof Error ? err.message : "Desk feed failed";
    return emptySnapshot(message);
  }
});
