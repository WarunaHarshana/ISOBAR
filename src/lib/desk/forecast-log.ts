/**
 * Append-only research log under ISOBAR_DATA_DIR/logs (default /data/logs), so future
 * backtests replay WeatherNext inits and market snapshots without BigQuery.
 *
 * Files: one JSONL per UTC day, `isobar-YYYY-MM-DD.jsonl`. On the first write of a new day
 * every older .jsonl is gzipped to .jsonl.gz (and the plain file removed). Size awareness:
 * the logs dir is kept under ISOBAR_LOG_MAX_MB (default 150 MB of the 500 MB volume) by
 * deleting the oldest .gz files, and nothing is written while the volume has less than
 * ISOBAR_LOG_MIN_FREE_MB (default 64 MB) free. ISOBAR_LOG_DISABLED=true turns it off.
 *
 * Record types (one JSON object per line, `t` = record type, `at` = ISO write time):
 *  - "wn_init":  one per city per fetched WeatherNext init: init, cityId, grid cell,
 *                hourly quantiles [hoursAfterInit, p10, p50, p90] (°C), daily-max and
 *                daily-min synthetic members by local date.
 *  - "market":   throttled desk snapshot (every ISOBAR_LOG_SNAPSHOT_MIN, default 15 min):
 *                per event the buckets' YES price / bid / ask / raw model / blend / weight.
 *  - "fill":     every paper fill with its decision-time context (bucket quotes, ladder).
 */
import {
  appendFileSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  statfsSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { gzipSync } from "node:zlib";

const MB = 1024 * 1024;

type LogState = { day: string | null; lastSnapshotAt: number; warned: boolean };
type G = { __isobarLog?: LogState };
function st(): LogState {
  const g = globalThis as G;
  if (!g.__isobarLog) g.__isobarLog = { day: null, lastSnapshotAt: 0, warned: false };
  return g.__isobarLog;
}
export function _resetForecastLog() {
  delete (globalThis as G).__isobarLog;
}

const num = (raw: string | undefined, fb: number) => {
  const n = raw == null || raw === "" ? NaN : Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : fb;
};

export function logDir(env: Record<string, string | undefined> = process.env) {
  return join(env.ISOBAR_DATA_DIR || "/data", "logs");
}
export function logEnabled(env: Record<string, string | undefined> = process.env) {
  return !/^(1|true|yes)$/i.test(env.ISOBAR_LOG_DISABLED ?? "");
}
const fileFor = (dir: string, day: string) => join(dir, `isobar-${day}.jsonl`);

/** Gzip finished days and trim the oldest archives to the size cap. Returns bytes in the dir after. */
export function rotateLogs(dir: string, today: string, maxBytes: number) {
  let names: string[] = [];
  try {
    names = readdirSync(dir);
  } catch {
    return 0;
  }
  for (const n of names) {
    const m = n.match(/^isobar-(\d{4}-\d{2}-\d{2})\.jsonl$/);
    if (!m || m[1] >= today) continue;
    const src = join(dir, n);
    try {
      writeFileSync(`${src}.gz`, gzipSync(readFileSync(src)));
      unlinkSync(src);
    } catch (err) {
      console.warn("[isobar] log rotate failed", n, err instanceof Error ? err.message : err);
    }
  }
  const files = readdirSync(dir)
    .filter((n) => /^isobar-\d{4}-\d{2}-\d{2}\.jsonl(\.gz)?$/.test(n))
    .sort()
    .map((n) => ({ n, size: statSync(join(dir, n)).size }));
  let total = files.reduce((a, f) => a + f.size, 0);
  for (const f of files) {
    if (total <= maxBytes) break;
    if (!f.n.endsWith(".gz")) continue; // never drop today's live file
    unlinkSync(join(dir, f.n));
    total -= f.size;
    console.warn(`[isobar] log cap: removed ${f.n} (${(f.size / MB).toFixed(1)} MB)`);
  }
  return total;
}

function freeBytes(dir: string) {
  try {
    const s = statfsSync(dir);
    return Number(s.bavail) * Number(s.bsize);
  } catch {
    return Infinity;
  }
}

/** Append records (one line each). Never throws; logging must not break the desk. */
export function appendLog(
  records: Record<string, unknown>[],
  now = new Date(),
  env: Record<string, string | undefined> = process.env,
) {
  if (!records.length || !logEnabled(env)) return false;
  const s = st();
  const dir = logDir(env);
  try {
    mkdirSync(dir, { recursive: true });
    const day = now.toISOString().slice(0, 10);
    if (s.day !== day) {
      rotateLogs(dir, day, num(env.ISOBAR_LOG_MAX_MB, 150) * MB);
      s.day = day;
    }
    if (freeBytes(dir) < num(env.ISOBAR_LOG_MIN_FREE_MB, 64) * MB) {
      if (!s.warned) console.warn("[isobar] log skipped: volume nearly full");
      s.warned = true;
      return false;
    }
    const at = now.toISOString();
    appendFileSync(
      fileFor(dir, day),
      records.map((r) => JSON.stringify({ at, ...r })).join("\n") + "\n",
    );
    return true;
  } catch (err) {
    if (!s.warned)
      console.warn("[isobar] log write failed", err instanceof Error ? err.message : err);
    s.warned = true;
    return false;
  }
}

/** True when a market snapshot is due (throttle), and marks it taken. */
export function snapshotDue(
  now = Date.now(),
  env: Record<string, string | undefined> = process.env,
) {
  const s = st();
  const every = num(env.ISOBAR_LOG_SNAPSHOT_MIN, 15) * 60_000;
  if (now - s.lastSnapshotAt < every) return false;
  s.lastSnapshotAt = now;
  return true;
}

const r2 = (x: number) => Math.round(x * 100) / 100;
const r4 = (x: number | null | undefined) =>
  x == null || !Number.isFinite(x) ? null : Math.round(x * 1e4) / 1e4;

/** Compact "market" record from a desk snapshot. */
export function marketRecord(snapshot: {
  fetchedAt: string;
  events: Array<{
    eventId: string;
    cityId: string;
    kind: string;
    unit: string;
    eventDate: string;
    observed: number | null;
    buckets: Array<{
      marketId: string;
      label: string;
      lo: number;
      hi: number;
      yesPrice: number;
      bestBid: number | null;
      bestAsk: number | null;
      modelP: number;
      blendP?: number;
      blendW?: number;
      volume: number;
    }>;
  }>;
  weather: Record<string, { source: string }>;
}) {
  return {
    t: "market",
    fetchedAt: snapshot.fetchedAt,
    events: snapshot.events.map((e) => ({
      id: e.eventId,
      city: e.cityId,
      kind: e.kind,
      unit: e.unit,
      date: e.eventDate,
      obs: e.observed,
      src: snapshot.weather[e.cityId]?.source ?? null,
      w: e.buckets[0]?.blendW ?? null,
      b: e.buckets.map((b) => [
        b.marketId,
        b.label,
        Number.isFinite(b.lo) ? b.lo : null,
        Number.isFinite(b.hi) ? b.hi : null,
        r4(b.yesPrice),
        r4(b.bestBid),
        r4(b.bestAsk),
        r4(b.modelP),
        r4(b.blendP),
        Math.round(b.volume),
      ]),
    })),
    cols: ["marketId", "label", "lo", "hi", "yes", "bid", "ask", "modelP", "blendP", "volume"],
  };
}

/** "wn_init" records for one fetched batch (raw BigQuery rows → per-city quantiles + members). */
export function wnInitRecords(
  rows: Record<string, unknown>[],
  cities: { id: string }[],
  parsed: Map<
    string,
    {
      init: string;
      gridLat: number;
      gridLon: number;
      membersByDate: Record<string, number[]>;
      membersMinByDate?: Record<string, number[]>;
    }
  >,
  toNum: (v: unknown) => number,
) {
  const K = 273.15;
  const byIdx = new Map<number, [number, number, number, number][]>();
  for (const row of rows) {
    const i = toNum(row.i);
    const h = toNum(row.hours);
    if (!Number.isInteger(i) || !Number.isFinite(h)) continue;
    const list = byIdx.get(i) ?? byIdx.set(i, []).get(i)!;
    list.push([h, r2(toNum(row.p10) - K), r2(toNum(row.p50) - K), r2(toNum(row.p90) - K)]);
  }
  const out: Record<string, unknown>[] = [];
  cities.forEach((c, i) => {
    const p = parsed.get(c.id);
    if (!p) return;
    out.push({
      t: "wn_init",
      init: p.init,
      cityId: c.id,
      gridLat: p.gridLat,
      gridLon: p.gridLon,
      q: (byIdx.get(i) ?? []).sort((a, b) => a[0] - b[0]),
      qCols: ["hours", "p10C", "p50C", "p90C"],
      maxMembers: p.membersByDate,
      minMembers: p.membersMinByDate ?? {},
    });
  });
  return out;
}
