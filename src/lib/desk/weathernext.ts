/**
 * Google WeatherNext 3 provider (BigQuery, station-head 2 m temperature @ 0.05°).
 *
 * Paper-desk only. Produces per-local-date daily-max "members" in °C so the
 * existing bucket / Kelly math (snapshot.ts, plausibility.ts) keeps working.
 *
 * Daily-max method (documented in PAPER.md):
 *   BigQuery only exposes per-hour marginal quantiles (p10/p50/p90 used here),
 *   and max-of-percentiles != percentile-of-max. We build N synthetic members
 *   at fixed normal-score ranks z_i = Φ⁻¹((i + 0.5) / N). For every hour the
 *   member's temperature is the hour's quantile function evaluated at z_i
 *   (piecewise-linear in z through p10/p50/p90, linear extrapolation in the
 *   tails = split-normal). The member's daily max is the max over that local
 *   date's hours. Using the same rank for every hour is the comonotonic
 *   (rank-correlation = 1) assumption: under it, max_t Q_t(u) is *exactly*
 *   the u-quantile of the daily max. Real hour-to-hour forecast errors are
 *   highly but not perfectly correlated, so this is a slight low bias on the
 *   mean daily max / slight over-concentration; the KDE bandwidth floor in
 *   bucketProbability already widens it.
 *
 * Cost (on-demand BigQuery, table is partitioned by init_time and clustered by
 * geography): a point lookup reads whole clustered blocks, so the bill is
 * ~22 MiB per selected column per city per init regardless of how many
 * forecast hours we keep. We select 4 columns (hours, p10, p50, p90) → measured
 * ~196 MiB per city per init in production (~9 GiB for a full 47-city init).
 * We only fetch 00Z/12Z inits by default (2 × ~9 GiB ≈ 18 GiB/day, ≈ 540
 * GiB/month worst case, inside the 1 TiB/month free tier), probe for a new
 * init only after it is due, and enforce daily + monthly byte caps (default
 * 20 GiB/day, 600 GiB/month; persisted
 * to ISOBAR_DATA_DIR). When capped / unconfigured / failing we keep the last
 * good init (≤30 h old) or return nothing so weather.ts falls back to
 * Open-Meteo.
 *
 * Estimates vs bills: BigQuery's pre-run estimate ignores clustering, so it is
 * the whole init_time partition for every selected column (measured on the
 * 0.05° view, 2026-10-01 12Z: init_time+geography ≈ 21 GB, 4 forecast columns
 * ≈ 1.47 TB) even though the bill is ~196 MiB/city. Project custom quotas
 * (QueryUsagePerDay) and maximumBytesBilled are both enforced against that
 * estimate *before* the job runs. So:
 *   - the "is a new init out?" probe is a free dry run (estimate > 0 ⇔ the
 *     partition exists), never a billed query;
 *   - every fetch is preceded by a free dry run; if its estimate exceeds
 *     maxEstimateBytes (default 28 GiB, under a 30 GiB custom quota) we skip
 *     the job instead of letting BigQuery reject it, and back off;
 *   - the in-code daily/monthly caps count *billed* bytes (the real cost,
 *     min 10 MiB/job); every batch is pre-flight checked with
 *     EST_BYTES_PER_CITY (200 MiB, above the measured ~196 MiB) against both
 *     the daily and the monthly cap, so we never start a batch that could
 *     cross a cap. A pass that hits the cap mid-way keeps the cities already
 *     fetched (partial load) and fills the rest once budget frees up.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { CityMeta, HourPoint } from "./types";

export const WEATHERNEXT_LABEL = "WeatherNext 3";
export const WEATHERNEXT_MEMBERS = 50;
const KELVIN = 273.15;
const GIB = 1024 ** 3;
const MIB = 1024 ** 2;
/** Normal scores of p10 / p50 / p90. */
const Z_KNOTS = [-1.2815515655446004, 0, 1.2815515655446004] as const;
/** Local hours that must be covered for a date to be emitted (afternoon peak → midnight). */
const REQUIRED_FIRST_LOCAL_HOUR = 11;
const SEARCH_RADIUS_M = 4000;
const STALE_INIT_MS = 30 * 3600_000;
const ERROR_BACKOFF_MS = 10 * 60_000;
/** Back-off after a quota / estimate rejection (retrying sooner cannot succeed). */
const QUOTA_BACKOFF_MS = 60 * 60_000;
/** Cities per fetch job (bill is per city; small batches bound a failed job's blast radius). */
export const FETCH_BATCH_SIZE = 8;
/** Typical WeatherNext publish latency after init_time (observed ~6–7 h). */
const PUBLISH_LATENCY_MS = 5 * 3600_000;
/** Conservative per-city bill used for the pre-flight budget check (measured ~196 MiB/city/init). */
export const EST_BYTES_PER_CITY = 200 * MIB;

export type WeatherNextConfig = {
  /** Project that runs (and pays for) the query jobs. */
  projectId: string;
  datasetProject: string;
  dataset: string;
  table: string;
  location: string;
  /** Min gap between "is a new init out yet?" probes. */
  probeMs: number;
  maxHours: number;
  /** UTC init hours to use (subset of 0/6/12/18; those reach 360 h). */
  initHours: number[];
  dailyCapBytes: number;
  monthlyCapBytes: number;
  /** Skip any job whose dry-run estimate exceeds this (BigQuery custom quotas reject on the estimate). */
  maxEstimateBytes: number;
  /** Where to persist the byte counter; null = in-memory only. */
  usageFile: string | null;
  credentials?: Record<string, unknown>;
};

export type WeatherNextRow = Record<string, unknown>;
export type WeatherNextResult = {
  rows: WeatherNextRow[];
  bytesBilled: number | null;
  /** Dry run: BigQuery's pre-run estimate (totalBytesProcessed). */
  bytesEstimated?: number | null;
};
export type WeatherNextRunOpts = { dryRun?: boolean };
export type WeatherNextRunner = (sql: string, cfg: WeatherNextConfig, opts?: WeatherNextRunOpts) => Promise<WeatherNextResult>;

export type WeatherNextCity = {
  init: string;
  gridLat: number;
  gridLon: number;
  /** Per local date (city tz) → synthetic daily-max members, °C. */
  membersByDate: Record<string, number[]>;
  /** Hourly p50, ISO UTC times. */
  hourly: HourPoint[];
};

export type WeatherNextLoad = {
  configured: boolean;
  init: string | null;
  byCity: Map<string, WeatherNextCity>;
  error: string | null;
};

type Usage = { day: string; dayBytes: number; month: string; monthBytes: number };

type WnState = {
  init: string | null;
  cities: Map<string, WeatherNextCity>;
  /** City ids already queried for `init` that returned no grid cell. */
  empty: Set<string>;
  lastProbeAt: number;
  backoffUntil: number;
  lastError: string | null;
  inflight: Promise<WeatherNextLoad> | null;
  usage: Usage | null;
};

type WnGlobals = {
  __isobarWn?: WnState;
  __isobarWnRunner?: WeatherNextRunner | null;
  __isobarWnConfig?: WeatherNextConfig | null | undefined;
  __isobarWnClient?: { key: string; client: unknown } | null;
};

function g(): WnGlobals {
  return globalThis as WnGlobals;
}

function state(): WnState {
  const glob = g();
  if (!glob.__isobarWn) {
    glob.__isobarWn = {
      init: null,
      cities: new Map(),
      empty: new Set(),
      lastProbeAt: 0,
      backoffUntil: 0,
      lastError: null,
      inflight: null,
      usage: null,
    };
  }
  return glob.__isobarWn;
}

/* ------------------------------------------------------------------ config */

const IDENT = /^[A-Za-z0-9_-]+$/;

function num(raw: string | undefined, fallback: number, lo: number, hi: number) {
  const n = raw == null || raw === "" ? NaN : Number(raw);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(hi, Math.max(lo, n));
}

function parseCredentials(raw: string | undefined): Record<string, unknown> | undefined | null {
  if (!raw || !raw.trim()) return undefined;
  const text = raw.trim().startsWith("{") ? raw.trim() : Buffer.from(raw.trim(), "base64").toString("utf8");
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** Returns null when WeatherNext is not configured (→ Open-Meteo only). */
export function weatherNextConfig(env: Record<string, string | undefined> = process.env): WeatherNextConfig | null {
  if (/^(1|true|yes)$/i.test(env.ISOBAR_WEATHERNEXT_DISABLED ?? "")) return null;
  const projectId = env.ISOBAR_WEATHERNEXT_PROJECT?.trim();
  const datasetRaw = env.ISOBAR_WEATHERNEXT_DATASET?.trim();
  if (!projectId || !datasetRaw) return null;
  const [datasetProject, dataset] = datasetRaw.includes(".")
    ? (datasetRaw.split(".", 2) as [string, string])
    : [projectId, datasetRaw];
  const table = env.ISOBAR_WEATHERNEXT_TABLE?.trim() || "weathernext_3_0_0_0p05deg";
  if (![projectId, datasetProject, dataset, table].every((s) => IDENT.test(s))) {
    console.error("[isobar] WeatherNext config has invalid identifiers; disabled");
    return null;
  }
  const credentials = parseCredentials(env.ISOBAR_WEATHERNEXT_CREDENTIALS_JSON);
  if (credentials === null) {
    console.error("[isobar] ISOBAR_WEATHERNEXT_CREDENTIALS_JSON is not valid JSON/base64 JSON; WeatherNext disabled");
    return null;
  }
  const initHours = (env.ISOBAR_WEATHERNEXT_INIT_HOURS ?? "0,12")
    .split(",")
    .map((s) => Number(s.trim()))
    .filter((h) => [0, 6, 12, 18].includes(h));
  const dataDir = env.ISOBAR_DATA_DIR || "/data";
  return {
    projectId,
    datasetProject,
    dataset,
    table,
    location: env.ISOBAR_WEATHERNEXT_LOCATION?.trim() || "US",
    probeMs: num(env.ISOBAR_WEATHERNEXT_PROBE_MIN, 30, 10, 360) * 60_000,
    maxHours: Math.round(num(env.ISOBAR_WEATHERNEXT_MAX_HOURS, 120, 24, 360)),
    initHours: initHours.length ? [...new Set(initHours)].sort((a, b) => a - b) : [0, 12],
    dailyCapBytes: num(env.ISOBAR_WEATHERNEXT_DAILY_GIB, 20, 0, 1024) * GIB,
    monthlyCapBytes: num(env.ISOBAR_WEATHERNEXT_MONTHLY_GIB, 600, 0, 1024) * GIB,
    maxEstimateBytes: num(env.ISOBAR_WEATHERNEXT_MAX_ESTIMATE_GIB, 28, 0, 1024 * 1024) * GIB,
    usageFile: join(dataDir, "weathernext-usage.json"),
    ...(credentials ? { credentials } : {}),
  };
}

/* ------------------------------------------------------------------- SQL */

function tableRef(cfg: WeatherNextConfig) {
  return `\`${cfg.datasetProject}.${cfg.dataset}.${cfg.table}\``;
}

function coord(n: number) {
  if (!Number.isFinite(n)) throw new Error("non-finite coordinate");
  return n.toFixed(4);
}

function tsLiteral(d: Date) {
  return `TIMESTAMP('${d.toISOString().replace("T", " ").replace(/\.\d+Z$/, "+00")}')`;
}

/** Init times that should already be published, newest first (configured UTC hours only). */
export function dueInitCandidates(nowMs: number, initHours: number[], lookbackH = 48): Date[] {
  const out: Date[] = [];
  const latestDue = nowMs - PUBLISH_LATENCY_MS;
  const start = new Date(latestDue);
  start.setUTCMinutes(0, 0, 0);
  for (let h = 0; h <= lookbackH; h++) {
    const t = new Date(start.getTime() - h * 3600_000);
    if (initHours.includes(t.getUTCHours())) out.push(t);
  }
  return out;
}

/**
 * Existence probe for ONE init. Only ever run as a dry run (free, not billed,
 * not counted against quota): the estimate is the size of that init_time
 * partition's init_time column, 0 when the partition does not exist.
 */
export function buildProbeSql(cfg: WeatherNextConfig, init: Date) {
  return `SELECT init_time FROM ${tableRef(cfg)} WHERE init_time = ${tsLiteral(init)}`;
}

/**
 * One query for all cities. The constant MULTIPOINT filter lets BigQuery prune
 * clustered blocks; the join then keeps the nearest 0.05° cell per city.
 * Only hours + p10/p50/p90 are read (bytes scale with columns selected).
 */
export function buildFetchSql(cfg: WeatherNextConfig, cities: CityMeta[], init: string) {
  const pts = cities
    .map((c, i) => `STRUCT(${i} AS i, ST_GEOGPOINT(${coord(c.lon)}, ${coord(c.lat)}) AS p)`)
    .join(",\n    ");
  const multipoint = `MULTIPOINT(${cities.map((c) => `(${coord(c.lon)} ${coord(c.lat)})`).join(",")})`;
  return `WITH pts AS (
  SELECT * FROM UNNEST([
    ${pts}
  ])
),
cells AS (
  SELECT t.init_time, t.geography, t.forecast
  FROM ${tableRef(cfg)} t
  WHERE t.init_time = ${tsLiteral(new Date(init))}
    AND ST_DWITHIN(t.geography, ST_GEOGFROMTEXT('${multipoint}'), ${SEARCH_RADIUS_M})
),
nearest AS (
  SELECT pts.i, ARRAY_AGG(STRUCT(c.init_time, c.geography, c.forecast) ORDER BY ST_DISTANCE(c.geography, pts.p) LIMIT 1)[OFFSET(0)] AS c
  FROM cells c JOIN pts ON ST_DWITHIN(c.geography, pts.p, ${SEARCH_RADIUS_M})
  GROUP BY pts.i
)
SELECT n.i AS i, n.c.init_time AS init_time, ST_X(n.c.geography) AS lon, ST_Y(n.c.geography) AS lat, f.hours AS hours,
  f.station_head_temperature_2m_p10 AS p10,
  f.station_head_temperature_2m_p50 AS p50,
  f.station_head_temperature_2m_p90 AS p90
FROM nearest n, UNNEST(n.c.forecast) f
WHERE f.hours <= ${cfg.maxHours}
ORDER BY i, hours`;
}

/* ------------------------------------------------------------ distribution */

/** Acklam's inverse normal CDF (|err| < 1.2e-9). */
export function probit(p: number): number {
  if (p <= 0) return -Infinity;
  if (p >= 1) return Infinity;
  const a = [-39.69683028665376, 220.9460984245205, -275.9285104469687, 138.357751867269, -30.66479806614716, 2.506628277459239];
  const b = [-54.47609879822406, 161.5858368580409, -155.6989798598866, 66.80131188771972, -13.28068155288572];
  const c = [-0.007784894002430293, -0.3223964580411365, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783];
  const d = [0.007784695709041462, 0.3224671290700398, 2.445134137142996, 3.754408661907416];
  const pl = 0.02425;
  if (p < pl) {
    const q = Math.sqrt(-2 * Math.log(p));
    return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  }
  if (p > 1 - pl) {
    const q = Math.sqrt(-2 * Math.log(1 - p));
    return -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  }
  const q = p - 0.5;
  const r = q * q;
  return ((((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q) / (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
}

export function memberRanks(n = WEATHERNEXT_MEMBERS): number[] {
  return Array.from({ length: n }, (_, i) => probit((i + 0.5) / n));
}

/**
 * Quantile function through (z, q) knots: piecewise-linear in normal score,
 * linear extrapolation in the tails (split normal). Knots are sorted first
 * (monotone rearrangement) so crossing quantiles cannot invert members.
 */
export function quantileAtZ(q: readonly number[], z: number): number {
  const v = [...q].sort((x, y) => x - y);
  const zs = Z_KNOTS;
  let k = 0;
  if (z <= zs[0]) k = 0;
  else if (z >= zs[zs.length - 1]) k = zs.length - 2;
  else while (k < zs.length - 2 && z > zs[k + 1]) k++;
  const slope = (v[k + 1] - v[k]) / (zs[k + 1] - zs[k]);
  return v[k] + slope * (z - zs[k]);
}

export type WnHour = { validMs: number; q: [number, number, number] };

const fmtCache = new Map<string, Intl.DateTimeFormat>();

function localParts(ms: number, tz: string): { date: string; hour: number } {
  let fmt = fmtCache.get(tz);
  if (!fmt) {
    fmt = new Intl.DateTimeFormat("en-CA", {
      timeZone: tz,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      hourCycle: "h23",
    });
    fmtCache.set(tz, fmt);
  }
  const parts = Object.fromEntries(fmt.formatToParts(new Date(ms)).map((p) => [p.type, p.value]));
  return { date: `${parts.year}-${parts.month}-${parts.day}`, hour: Number(parts.hour) % 24 };
}

/**
 * Daily-max members per local date. A date is emitted only when the forecast
 * covers every local hour from REQUIRED_FIRST_LOCAL_HOUR through 23 (so the
 * afternoon peak is inside the window); earlier hours present are included.
 * Partially covered dates are dropped (fail closed → no trade that date).
 */
export function dailyMaxMembers(hours: WnHour[], tz: string, n = WEATHERNEXT_MEMBERS): Record<string, number[]> {
  const byDate = new Map<string, { hours: Set<number>; rows: WnHour[] }>();
  for (const h of hours) {
    if (!h.q.every(Number.isFinite)) continue;
    const { date, hour } = localParts(h.validMs, tz);
    let slot = byDate.get(date);
    if (!slot) {
      slot = { hours: new Set(), rows: [] };
      byDate.set(date, slot);
    }
    slot.hours.add(hour);
    slot.rows.push(h);
  }
  const ranks = memberRanks(n);
  const out: Record<string, number[]> = {};
  for (const [date, slot] of byDate) {
    let covered = true;
    for (let hr = REQUIRED_FIRST_LOCAL_HOUR; hr <= 23; hr++) {
      if (!slot.hours.has(hr)) {
        covered = false;
        break;
      }
    }
    if (!covered) continue;
    out[date] = ranks.map((z) => {
      let best = -Infinity;
      for (const row of slot.rows) best = Math.max(best, quantileAtZ(row.q, z));
      return Math.round(best * 100) / 100;
    });
  }
  return out;
}

/* ------------------------------------------------------------- row parsing */

function toNum(v: unknown): number {
  if (typeof v === "number") return v;
  if (typeof v === "string" && v.trim()) return Number(v);
  if (v && typeof v === "object" && "value" in v) return Number((v as { value: unknown }).value);
  return NaN;
}

export function toIso(v: unknown): string | null {
  const raw = v && typeof v === "object" && "value" in v ? (v as { value: unknown }).value : v;
  if (raw instanceof Date) return raw.toISOString();
  if (typeof raw !== "string" && typeof raw !== "number") return null;
  const s = typeof raw === "string" && /^\d{4}-\d{2}-\d{2} /.test(raw) ? raw.replace(" ", "T") : raw;
  const ms = typeof s === "number" ? s : Date.parse(/[zZ]|[+-]\d\d:?\d\d$/.test(s) ? s : `${s}Z`);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

export function parseFetchRows(rows: WeatherNextRow[], cities: CityMeta[]): Map<string, WeatherNextCity> {
  const grouped = new Map<number, { init: string; lat: number; lon: number; hours: WnHour[] }>();
  for (const row of rows) {
    const i = toNum(row.i);
    const init = toIso(row.init_time);
    const hrs = toNum(row.hours);
    if (!Number.isInteger(i) || !cities[i] || !init || !Number.isFinite(hrs)) continue;
    let slot = grouped.get(i);
    if (!slot) {
      slot = { init, lat: toNum(row.lat), lon: toNum(row.lon), hours: [] };
      grouped.set(i, slot);
    }
    slot.hours.push({
      validMs: Date.parse(init) + hrs * 3600_000,
      q: [toNum(row.p10) - KELVIN, toNum(row.p50) - KELVIN, toNum(row.p90) - KELVIN],
    });
  }
  const out = new Map<string, WeatherNextCity>();
  for (const [i, slot] of grouped) {
    const city = cities[i];
    slot.hours.sort((a, b) => a.validMs - b.validMs);
    out.set(city.id, {
      init: slot.init,
      gridLat: slot.lat,
      gridLon: slot.lon,
      membersByDate: dailyMaxMembers(slot.hours, city.tz || "UTC"),
      hourly: slot.hours
        .filter((h) => Number.isFinite(h.q[1]))
        .map((h) => ({ time: new Date(h.validMs).toISOString(), tempC: Math.round(h.q[1] * 10) / 10 })),
    });
  }
  return out;
}

/* ------------------------------------------------------------------ runner */

async function defaultRunner(sql: string, cfg: WeatherNextConfig, opts: WeatherNextRunOpts = {}): Promise<WeatherNextResult> {
  const glob = g();
  const key = `${cfg.projectId}:${cfg.credentials ? "json" : "adc"}`;
  if (!glob.__isobarWnClient || glob.__isobarWnClient.key !== key) {
    const { BigQuery } = await import("@google-cloud/bigquery");
    glob.__isobarWnClient = {
      key,
      client: new BigQuery({ projectId: cfg.projectId, ...(cfg.credentials ? { credentials: cfg.credentials } : {}) }),
    };
  }
  const client = glob.__isobarWnClient.client as import("@google-cloud/bigquery").BigQuery;
  if (opts.dryRun) {
    const [job] = await client.createQueryJob({ query: sql, location: cfg.location, useLegacySql: false, dryRun: true });
    const est = Number(job.metadata?.statistics?.totalBytesProcessed ?? job.metadata?.statistics?.query?.totalBytesProcessed);
    return { rows: [], bytesBilled: 0, bytesEstimated: Number.isFinite(est) ? est : null };
  }
  const [job] = await client.createQueryJob({
    query: sql,
    location: cfg.location,
    useLegacySql: false,
    jobTimeoutMs: 120_000,
    labels: { app: "isobar", component: "weathernext" },
  });
  const [rows] = await job.getQueryResults({ timeoutMs: 120_000 });
  const [meta] = await job.getMetadata();
  const billed = Number(meta?.statistics?.query?.totalBytesBilled);
  return { rows: rows as WeatherNextRow[], bytesBilled: Number.isFinite(billed) ? billed : null };
}

/* ------------------------------------------------------------------ budget */

function utcDay(ms: number) {
  return new Date(ms).toISOString().slice(0, 10);
}

function loadUsage(cfg: WeatherNextConfig, nowMs: number): Usage {
  const st = state();
  const day = utcDay(nowMs);
  const month = day.slice(0, 7);
  if (!st.usage && cfg.usageFile) {
    try {
      st.usage = JSON.parse(readFileSync(cfg.usageFile, "utf8")) as Usage;
    } catch {
      st.usage = null;
    }
  }
  let u = st.usage ?? { day, dayBytes: 0, month, monthBytes: 0 };
  if (u.month !== month) u = { day, dayBytes: 0, month, monthBytes: 0 };
  else if (u.day !== day) u = { ...u, day, dayBytes: 0 };
  st.usage = u;
  return u;
}

function recordUsage(cfg: WeatherNextConfig, nowMs: number, bytes: number) {
  const u = loadUsage(cfg, nowMs);
  u.dayBytes += bytes;
  u.monthBytes += bytes;
  if (!cfg.usageFile) return;
  try {
    mkdirSync(dirname(cfg.usageFile), { recursive: true });
    writeFileSync(cfg.usageFile, JSON.stringify(u));
  } catch (err) {
    console.warn("[isobar] WeatherNext usage persist failed", err instanceof Error ? err.message : err);
  }
}

function withinBudget(cfg: WeatherNextConfig, nowMs: number, estBytes: number) {
  const u = loadUsage(cfg, nowMs);
  return u.dayBytes + estBytes <= cfg.dailyCapBytes && u.monthBytes + estBytes <= cfg.monthlyCapBytes;
}

/**
 * Bytes charged to the in-code caps: BigQuery's totalBytesBilled (the real
 * cost; it bills ≥10 MiB per query). Falls back to the conservative pre-flight
 * estimate only if the job did not report billed bytes.
 */
function billed(res: WeatherNextResult, est: number) {
  return Math.max(res.bytesBilled ?? est, 10 * MIB);
}

export function weatherNextUsage(): Usage | null {
  return state().usage ? { ...state().usage! } : null;
}

/* ------------------------------------------------------------------- load */

export function _setWeatherNextRunner(fn: WeatherNextRunner | null) {
  g().__isobarWnRunner = fn;
}

/** undefined = read env; null = force unconfigured. */
export function _setWeatherNextConfig(cfg: WeatherNextConfig | null | undefined) {
  g().__isobarWnConfig = cfg;
}

export function _resetWeatherNext() {
  delete g().__isobarWn;
  g().__isobarWnClient = null;
}

function activeConfig(): WeatherNextConfig | null {
  const forced = g().__isobarWnConfig;
  return forced === undefined ? weatherNextConfig() : forced;
}

function pick(cities: CityMeta[], err: string | null): WeatherNextLoad {
  const st = state();
  const byCity = new Map<string, WeatherNextCity>();
  if (st.init && Date.now() - Date.parse(st.init) <= STALE_INIT_MS) {
    for (const c of cities) {
      const hit = st.cities.get(c.id);
      if (hit) byCity.set(c.id, hit);
    }
  }
  return { configured: true, init: byCity.size ? st.init : null, byCity, error: err };
}

export async function loadWeatherNext(cities: CityMeta[]): Promise<WeatherNextLoad> {
  const cfg = activeConfig();
  if (!cfg) return { configured: false, init: null, byCity: new Map(), error: null };
  const usable = cities.filter((c) => Number.isFinite(c.lat) && Number.isFinite(c.lon) && (c.lat !== 0 || c.lon !== 0));
  if (!usable.length) return { configured: true, init: null, byCity: new Map(), error: null };
  const st = state();
  if (st.inflight) return st.inflight;
  st.inflight = refresh(cfg, usable).finally(() => {
    st.inflight = null;
  });
  return st.inflight;
}

/** Thrown when BigQuery's pre-run estimate is above maxEstimateBytes (job not started). */
export class WeatherNextEstimateError extends Error {}

function isQuotaError(msg: string) {
  return /custom quota|quotaExceeded|usageQuotaExceeded|exceeded limit for bytes billed|bytesBilledLimitExceeded/i.test(msg);
}

const fmtGiB = (b: number) => (b / GIB).toFixed(b < 10 * GIB ? 2 : 0);

/**
 * Newest due init (newer than `after`) whose partition exists. Dry runs only →
 * free and not counted against any quota; estimate > 0 ⇔ the init_time
 * partition has data. (Partition sizes vary 1.2–5 GB between inits, so the
 * size is not used as a completeness signal; PUBLISH_LATENCY_MS plus the
 * per-date coverage rule in dailyMaxMembers guard against partial inits.)
 */
export async function probeLatestInit(
  cfg: WeatherNextConfig,
  run: WeatherNextRunner,
  candidates: Date[],
  after: string | null,
): Promise<string | null> {
  for (const d of candidates) {
    if (after && d.getTime() <= Date.parse(after)) break;
    const r = await run(buildProbeSql(cfg, d), cfg, { dryRun: true });
    if (Number.isFinite(r.bytesEstimated) && (r.bytesEstimated as number) > 0) return d.toISOString();
  }
  return null;
}

type FetchOutcome = { parsed: Map<string, WeatherNextCity>; empty: Set<string>; error: unknown };

/**
 * Fetch `cities` for one init in batches of FETCH_BATCH_SIZE. A free dry run
 * of the first batch gates the whole pass on maxEstimateBytes (every batch hits
 * the same partition + columns, so the estimate is identical). Each batch is
 * budget-checked with EST_BYTES_PER_CITY and charged its billed bytes.
 * Returns whatever succeeded plus the first error, so a later failure does not
 * throw away bytes already paid for.
 */
async function fetchCities(
  cfg: WeatherNextConfig,
  run: WeatherNextRunner,
  cities: CityMeta[],
  init: string,
  now: number,
): Promise<FetchOutcome> {
  const parsed = new Map<string, WeatherNextCity>();
  const empty = new Set<string>();
  try {
    for (let k = 0; k < cities.length; k += FETCH_BATCH_SIZE) {
      const batch = cities.slice(k, k + FETCH_BATCH_SIZE);
      const sql = buildFetchSql(cfg, batch, init);
      if (k === 0) {
        const dry = await run(sql, cfg, { dryRun: true });
        const estimate = dry.bytesEstimated;
        if (Number.isFinite(estimate) && (estimate as number) > cfg.maxEstimateBytes) {
          throw new WeatherNextEstimateError(
            `fetch estimate ${fmtGiB(estimate as number)} GiB > ${fmtGiB(cfg.maxEstimateBytes)} GiB pre-run limit ` +
              `(BigQuery quotas check the clustering-blind estimate; bill would be ~${Math.round((EST_BYTES_PER_CITY * batch.length) / MIB)} MiB); job not started`,
          );
        }
      }
      const est = EST_BYTES_PER_CITY * batch.length;
      if (!withinBudget(cfg, now, est)) {
        throw new Error("WeatherNext byte budget reached");
      }
      const res = await run(sql, cfg);
      recordUsage(cfg, now, billed(res, est));
      const got = parseFetchRows(res.rows, batch);
      for (const [id, v] of got) parsed.set(id, v);
      for (const c of batch) if (!got.has(c.id)) empty.add(c.id);
    }
    return { parsed, empty, error: null };
  } catch (error) {
    return { parsed, empty, error };
  }
}

function fail(cities: CityMeta[], now: number, err: unknown): WeatherNextLoad {
  const st = state();
  const msg = err instanceof Error ? err.message : String(err);
  const budget = /byte budget reached/.test(msg);
  const quota = err instanceof WeatherNextEstimateError || isQuotaError(msg);
  st.lastError = budget ? msg : `WeatherNext failed: ${msg.slice(0, 240)}`;
  st.backoffUntil = now + (quota || budget ? QUOTA_BACKOFF_MS : ERROR_BACKOFF_MS);
  if (budget) console.warn("[isobar] WeatherNext budget reached: serving init", st.init, `(${st.cities.size} cities)`);
  else console.error("[isobar]", st.lastError);
  return pick(cities, budget && st.init ? null : st.lastError);
}

async function refresh(cfg: WeatherNextConfig, cities: CityMeta[]): Promise<WeatherNextLoad> {
  const st = state();
  const now = Date.now();
  if (now < st.backoffUntil) return pick(cities, st.lastError);
  const run = g().__isobarWnRunner ?? defaultRunner;

  try {
    // 1) Is a newer init due and not loaded yet? Free dry-run probe, at most every probeMs.
    const candidates = dueInitCandidates(now, cfg.initHours);
    const newestDue = candidates[0]?.toISOString() ?? null;
    const behind = !st.init || (newestDue != null && Date.parse(newestDue) > Date.parse(st.init));
    if (behind && now - st.lastProbeAt >= cfg.probeMs && candidates.length) {
      st.lastProbeAt = now;
      const latest = await probeLatestInit(cfg, run, candidates, st.init);
      if (latest) {
        // Gate on the first batch only: fetchCities checks every batch against
        // both caps before starting it, and keeps a partial load if it stops.
        if (!withinBudget(cfg, now, EST_BYTES_PER_CITY * Math.min(cities.length, FETCH_BATCH_SIZE))) {
          console.warn("[isobar] WeatherNext budget: keeping previous init", st.init);
          return pick(cities, st.init ? null : "WeatherNext byte budget reached");
        }
        const out = await fetchCities(cfg, run, cities, latest, now);
        if (out.parsed.size) {
          st.init = latest;
          st.cities = out.parsed;
          st.empty = out.empty;
          st.lastError = null;
          console.log(
            `[isobar] WeatherNext init ${latest} loaded for ${out.parsed.size}/${cities.length} cities` +
              ` (usage today ${Math.round((st.usage?.dayBytes ?? 0) / MIB)} MiB billed)`,
          );
        }
        if (out.error) {
          if (out.parsed.size) console.warn(`[isobar] WeatherNext partial load: ${out.parsed.size}/${cities.length} cities kept`);
          return fail(cities, now, out.error);
        }
        if (!out.parsed.size) throw new Error(`WeatherNext init ${latest} returned no cells`);
        return pick(cities, null);
      }
    }

    // 2) Same init, new cities appeared (e.g. a new Polymarket event).
    if (st.init) {
      const missing = cities.filter((c) => !st.cities.has(c.id) && !st.empty.has(c.id));
      if (missing.length && withinBudget(cfg, now, EST_BYTES_PER_CITY * Math.min(missing.length, FETCH_BATCH_SIZE))) {
        const out = await fetchCities(cfg, run, missing, st.init, now);
        for (const [id, v] of out.parsed) st.cities.set(id, v);
        for (const id of out.empty) st.empty.add(id);
        if (out.error) return fail(cities, now, out.error);
      }
    }
    return pick(cities, st.init ? null : "WeatherNext: no init loaded yet");
  } catch (err) {
    return fail(cities, now, err);
  }
}

/** Short label for WeatherNow.source, e.g. "WeatherNext 3 (init 10-01 12Z)". */
export function weatherNextSourceLabel(init: string) {
  const d = new Date(init);
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(d.getUTCDate()).padStart(2, "0");
  const hh = String(d.getUTCHours()).padStart(2, "0");
  return `${WEATHERNEXT_LABEL} (init ${mm}-${dd} ${hh}Z)`;
}
