import type { CityMeta, HourPoint, WeatherNow } from "./types";
import { HttpError, cached, fetchJson } from "./cache";
import { _resetCooldowns, clearCooldown, coolingDown, isRateLimitError, tripCooldown } from "./cooldown";
import { mean, stdev } from "./math";
import { ensembleOk } from "./ensemble";
import { loadWeatherNext, weatherNextSourceLabel, type WeatherNextLoad } from "./weathernext";

type EnsembleResult = {
  latitude: number;
  longitude: number;
  timezone?: string;
  daily?: Record<string, Array<number | string | null>>;
};

type PrevResult = {
  latitude: number;
  longitude: number;
  timezone?: string;
  current?: {
    time?: string;
    temperature_2m?: number;
    relative_humidity_2m?: number;
    wind_speed_10m?: number;
    weather_code?: number;
  };
  hourly?: {
    time: string[];
    temperature_2m: Array<number | null>;
  };
  daily?: {
    time: string[];
    temperature_2m_max?: Array<number | null>;
    temperature_2m_min?: Array<number | null>;
  };
};

type Metar = {
  icaoId?: string;
  obsTime?: number;
  temp?: number;
  dewp?: number;
  wspd?: number;
  cover?: string;
  reportTime?: string;
  name?: string;
};

type EnsembleEntry = { members: number[]; dates: string[] };

type EnsembleLoad = {
  map: Map<string, EnsembleEntry>;
  error: string | null;
};

type EnsembleFetch = EnsembleLoad & { rateLimited: unknown };

/** Last good Open-Meteo data per city (kept through cooldowns / failed refreshes). */
type CityEnsemble = { at: number; entries: Map<string, EnsembleEntry> };
type CityForecast = { at: number; value: ForecastCity };

type EnsembleGlobals = {
  /** Single-flight per exact city set (never hand one list's result to another). */
  __isobarEnsInflight?: Map<string, Promise<EnsembleFetch>> | null;
  __isobarEnsCity?: Map<string, CityEnsemble>;
  __isobarFcInflight?: Map<string, Promise<void>> | null;
  __isobarFcCity?: Map<string, CityForecast>;
  /** Last request attempt per "endpoint:city" (a failed refresh is not retried every tick). */
  __isobarOmTried?: Map<string, number>;
  /** Error of the last ensemble fetch that returned nothing (reused while it is held off). */
  __isobarEnsLastErr?: string | null;
  /** Last message per log key (log on change only, not on every 25 s tick). */
  __isobarOmLog?: Map<string, string>;
};

/**
 * Open-Meteo's ensemble API now rejects requests without `models=`
 * ("Model 'best_match' is not supported by the Ensemble API", HTTP 400), which
 * the chunking logic below misread as URI-too-long. ECMWF IFS 0.25° ENS = 51 members.
 */
const ENSEMBLE_MODEL = "ecmwf_ifs025";
const ENSEMBLE_MEMBERS = 51;
/** Only daily max is used (members are daily-MAX distributions). */
const ENSEMBLE_DAILY = "temperature_2m_max";
const ENSEMBLE_FORECAST_DAYS = 4;
const ENSEMBLE_CHUNK = 8;
const ENSEMBLE_TIMEOUT_MS = 20_000;
const ENSEMBLE_TZ_GAP_MS = 250;
const ENSEMBLE_TRANSIENT_RETRY_MS = 1_000;
/**
 * Fallback cadence. Open-Meteo's free tier is 600/min, 5 000/h, 10 000/day
 * *weighted* calls, and an ensemble call weighs (variables × members) / 10 per
 * location: 1 daily var × 51 members = 5.1 calls per city (the old max+min
 * request was 10.2). ECMWF ENS only updates every 6 h, so we refresh a city at
 * most every 30 min and stretch the interval so the ensemble alone stays under
 * ENSEMBLE_DAILY_BUDGET weighted calls/day (48 fallback cities → ~59 min).
 * Cities with a fresh WeatherNext init are never requested.
 */
export const ENSEMBLE_MIN_REFRESH_MS = 30 * 60_000;
export const ENSEMBLE_DAILY_BUDGET = 6_000;
/** A city's last good members keep serving this long while refreshes fail / cool down. */
const ENSEMBLE_LAST_GOOD_MS = 12 * 3600_000;
/** Dashboard forecast (display only; ~1 weighted call per city). */
export const FORECAST_REFRESH_MS = 30 * 60_000;
const FORECAST_LAST_GOOD_MS = 6 * 3600_000;
/** Min gap between attempts for a city whose last refresh failed (non-429). */
const RETRY_FAILED_MS = 2 * 60_000;
export const ENSEMBLE_ENDPOINT = "Open-Meteo ensemble";
export const FORECAST_ENDPOINT = "Open-Meteo forecast";

function g(): EnsembleGlobals {
  return globalThis as EnsembleGlobals;
}

function ensStore() {
  return (g().__isobarEnsCity ??= new Map());
}

function fcStore() {
  return (g().__isobarFcCity ??= new Map());
}

/** Log `msg` under `key` only when it differs from the last one (null clears). */
function triedRecently(endpoint: string, cityId: string, now: number) {
  const at = g().__isobarOmTried?.get(`${endpoint}:${cityId}`);
  return at != null && now - at < RETRY_FAILED_MS;
}

function markTried(endpoint: string, cities: CityMeta[], now: number) {
  const tried = (g().__isobarOmTried ??= new Map());
  for (const c of cities) tried.set(`${endpoint}:${c.id}`, now);
}

function logChange(key: string, msg: string | null, level: "error" | "warn" = "error") {
  const seen = (g().__isobarOmLog ??= new Map());
  if (msg == null) {
    seen.delete(key);
    return;
  }
  if (seen.get(key) === msg) return;
  seen.set(key, msg);
  console[level]("[isobar]", msg);
}

/** Open-Meteo weighted-call cost of one ensemble request (their published formula). */
export function ensembleCallWeight(locations: number) {
  const variablesModels = 1 * ENSEMBLE_MEMBERS;
  const variablesWeight = variablesModels / 10;
  const timeWeight = ENSEMBLE_FORECAST_DAYS / 14;
  return Math.max(1, Math.max(variablesWeight, timeWeight * variablesWeight)) * locations;
}

/** Per-city refresh interval for `n` fallback cities (see ENSEMBLE_DAILY_BUDGET). */
export function ensembleRefreshMs(n: number) {
  return Math.max(ENSEMBLE_MIN_REFRESH_MS, Math.ceil((86_400_000 * ensembleCallWeight(Math.max(1, n))) / ENSEMBLE_DAILY_BUDGET));
}

function asList<T>(raw: T | T[]): T[] {
  return Array.isArray(raw) ? raw : [raw];
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function errMsg(err: unknown) {
  return err instanceof Error ? err.message : String(err);
}

function memberValues(daily: Record<string, Array<number | string | null>>, dayIndex: number) {
  const out: number[] = [];
  for (const [key, series] of Object.entries(daily)) {
    if (!key.startsWith("temperature_2m_max")) continue;
    const v = series[dayIndex];
    if (typeof v === "number" && Number.isFinite(v)) out.push(v);
  }
  return out;
}

/** Quant: never batch mixed timezones with timezone=auto. */
export function groupCitiesByTimezone(cities: CityMeta[]): Map<string, CityMeta[]> {
  const groups = new Map<string, CityMeta[]>();
  for (const city of cities) {
    const tz = city.tz || "UTC";
    const list = groups.get(tz);
    if (list) list.push(city);
    else groups.set(tz, [city]);
  }
  return groups;
}

function parseEnsemble(raw: EnsembleResult | EnsembleResult[], cities: CityMeta[]) {
  const list = asList(raw);
  const map = new Map<string, EnsembleEntry>();
  for (let i = 0; i < list.length && i < cities.length; i++) {
    const row = list[i];
    const city = cities[i];
    if (!row.daily) continue;
    const dates = (row.daily.time ?? []).map(String);
    for (let d = 0; d < dates.length; d++) {
      map.set(`${city.id}:${dates[d]}`, { members: memberValues(row.daily, d), dates });
    }
  }
  return map;
}

async function fetchEnsembleBatch(cities: CityMeta[], timezone: string) {
  if (!cities.length) return new Map<string, EnsembleEntry>();
  const lats = cities.map((c) => c.lat.toFixed(4)).join(",");
  const lons = cities.map((c) => c.lon.toFixed(4)).join(",");
  const tz = encodeURIComponent(timezone);
  const url = `https://ensemble-api.open-meteo.com/v1/ensemble?latitude=${lats}&longitude=${lons}&daily=${ENSEMBLE_DAILY}&forecast_days=${ENSEMBLE_FORECAST_DAYS}&timezone=${tz}&models=${ENSEMBLE_MODEL}`;
  const raw = await fetchJson<EnsembleResult | EnsembleResult[]>(url, {}, ENSEMBLE_TIMEOUT_MS);
  return parseEnsemble(raw, cities);
}

function mergeEnsemble(into: Map<string, EnsembleEntry>, from: Map<string, EnsembleEntry>) {
  for (const [k, v] of from) into.set(k, v);
}

function cityInMap(map: Map<string, EnsembleEntry>, cityId: string) {
  const prefix = `${cityId}:`;
  for (const key of map.keys()) {
    if (key.startsWith(prefix)) return true;
  }
  return false;
}

function isUriTooLong(err: unknown) {
  if (err instanceof HttpError) return err.status === 400 || err.status === 414;
  const msg = err == null ? "" : errMsg(err);
  return /URI Too Long/i.test(msg);
}

function isTransient(err: unknown) {
  if (err == null) return false;
  if (err instanceof HttpError) return err.status >= 500;
  return /timeout|aborted|fetch failed/i.test(errMsg(err));
}

/** Test helper — drop 429 cooldowns, single-flight and last-good Open-Meteo data between cases. */
export function _resetEnsembleGuards() {
  const glob = g();
  glob.__isobarEnsInflight = new Map();
  glob.__isobarEnsCity = new Map();
  glob.__isobarFcInflight = new Map();
  glob.__isobarFcCity = new Map();
  glob.__isobarOmLog = new Map();
  glob.__isobarOmTried = new Map();
  glob.__isobarEnsLastErr = null;
  _resetCooldowns();
  _resetMetarState(0);
}

export function ensembleKey(cities: CityMeta[]) {
  return [...new Set(cities.map((c) => c.id))].sort().join(",");
}

function servingNote(store: Map<string, { at: number }>, cities: CityMeta[], lastGoodMs: number, now: number) {
  const kept = cities.filter((c) => {
    const hit = store.get(c.id);
    return hit && now - hit.at < lastGoodMs;
  }).length;
  return `serving last good data for ${kept}/${cities.length} cities`;
}

/**
 * Members for `cities` (the ones WeatherNext does not cover). Each city is only
 * re-requested once its last good data is older than ensembleRefreshMs(n);
 * during a 429 cooldown nothing is requested and last good data is served.
 */
async function loadEnsemble(cities: CityMeta[], now = Date.now()): Promise<EnsembleLoad> {
  if (!cities.length) return { map: new Map(), error: null };
  const store = ensStore();
  const refreshMs = ensembleRefreshMs(cities.length);
  // Let in-flight refreshes land first so a concurrent caller reuses them instead of re-requesting.
  const pending = [...(g().__isobarEnsInflight?.values() ?? [])];
  if (pending.length) {
    await Promise.all(pending);
    now = Date.now();
  }
  const due = cities.filter((c) => {
    const hit = store.get(c.id);
    return (!hit || now - hit.at >= refreshMs) && !triedRecently(ENSEMBLE_ENDPOINT, c.id, now);
  });
  if (due.length && !coolingDown(ENSEMBLE_ENDPOINT, now)) {
    const key = ensembleKey(due);
    const inflight = (g().__isobarEnsInflight ??= new Map());
    let p = inflight.get(key);
    if (!p) {
      markTried(ENSEMBLE_ENDPOINT, due, now);
      p = loadEnsembleOnce(due).finally(() => {
        inflight.delete(key);
      });
      inflight.set(key, p);
    }
    const res = await p;
    const at = Date.now();
    for (const c of due) {
      const prefix = `${c.id}:`;
      const entries = new Map<string, EnsembleEntry>();
      for (const [k, v] of res.map) if (k.startsWith(prefix)) entries.set(k.slice(prefix.length), v);
      if (entries.size) store.set(c.id, { at, entries });
    }
    if (res.rateLimited) {
      // One line per cooldown (the in-flight owner trips it; sharers see it already set).
      if (!coolingDown(ENSEMBLE_ENDPOINT)) {
        tripCooldown(ENSEMBLE_ENDPOINT, res.rateLimited, servingNote(store, cities, ENSEMBLE_LAST_GOOD_MS, Date.now()));
      }
    } else if (res.map.size) {
      clearCooldown(ENSEMBLE_ENDPOINT);
    }
    g().__isobarEnsLastErr = res.error;
  }
  const fetchError = g().__isobarEnsLastErr ?? null;

  const map = new Map<string, EnsembleEntry>();
  const nowAfter = Date.now();
  for (const c of cities) {
    const hit = store.get(c.id);
    if (!hit || nowAfter - hit.at >= ENSEMBLE_LAST_GOOD_MS) continue;
    for (const [date, entry] of hit.entries) map.set(`${c.id}:${date}`, entry);
  }
  const missing = cities.filter((c) => !cityInMap(map, c.id)).map((c) => c.id);
  let error: string | null = null;
  if (missing.length === cities.length) {
    error = coolingDown(ENSEMBLE_ENDPOINT, nowAfter)
      ? "ensemble rate-limited (cooling down, no last good data)"
      : (fetchError ?? `ensemble unavailable (${missing.join(", ")})`);
  }
  logChange("ensemble-missing", missing.length && missing.length < cities.length ? `ensemble missing ${missing.join(", ")}` : null);
  return { map, error };
}

async function loadEnsembleOnce(cities: CityMeta[]): Promise<EnsembleFetch> {
  const map = new Map<string, EnsembleEntry>();

  const tryBatch = async (batch: CityMeta[], timezone: string, label: string) => {
    try {
      mergeEnsemble(map, await fetchEnsembleBatch(batch, timezone));
      return null as unknown;
    } catch (err) {
      // 429s are logged once per cooldown by the caller, not per request.
      if (!isRateLimitError(err)) logChange(`ensemble-fail:${label}`, `ensemble ${label} failed ${errMsg(err)}`);
      return err ?? new Error("unknown");
    }
  };

  const tryBatchOnceRetry = async (batch: CityMeta[], timezone: string, label: string) => {
    const err = await tryBatch(batch, timezone, label);
    if (!isTransient(err) || isRateLimitError(err)) return err;
    await sleep(ENSEMBLE_TRANSIENT_RETRY_MS);
    return tryBatch(batch, timezone, `${label} retry`);
  };

  let rateLimited: unknown = null;
  let lastErr: unknown = null;
  let tzIndex = 0;
  for (const [tz, group] of groupCitiesByTimezone(cities)) {
    if (rateLimited) break;
    if (tzIndex > 0) await sleep(ENSEMBLE_TZ_GAP_MS);
    tzIndex += 1;
    const err = await tryBatchOnceRetry(group, tz, `tz ${tz}`);
    if (err) lastErr = err;
    if (!err && group.every((c) => cityInMap(map, c.id))) {
      logChange(`ensemble-fail:tz ${tz}`, null);
      continue;
    }
    if (isRateLimitError(err)) {
      rateLimited = err;
      break;
    }
    if (!isUriTooLong(err)) continue;
    for (let i = 0; i < group.length; i += ENSEMBLE_CHUNK) {
      if (rateLimited) break;
      const chunk = group.slice(i, i + ENSEMBLE_CHUNK);
      const missing = chunk.filter((c) => !cityInMap(map, c.id));
      if (!missing.length) continue;
      const chunkErr = await tryBatchOnceRetry(missing, tz, `tz ${tz} chunk`);
      if (isRateLimitError(chunkErr)) {
        rateLimited = chunkErr;
        break;
      }
      if (!isUriTooLong(chunkErr)) continue;
      for (const city of missing) {
        if (cityInMap(map, city.id)) continue;
        const cityErr = await tryBatchOnceRetry([city], tz, city.id);
        if (isRateLimitError(cityErr)) {
          rateLimited = cityErr;
          break;
        }
      }
    }
  }

  const failed = cities.filter((c) => !cityInMap(map, c.id));
  const error =
    failed.length === cities.length ? (rateLimited ? "ensemble rate-limited" : `ensemble unavailable (${lastErr ? errMsg(lastErr).slice(0, 160) : failed.map((c) => c.id).join(", ")})`) : null;
  return { map, error, rateLimited };
}

export async function loadWeather(cities: CityMeta[]): Promise<Record<string, WeatherNow>> {
  const unique = [...new Map(cities.filter((c) => c.lat !== 0 || c.lon !== 0).map((c) => [c.id, c])).values()];
  if (!unique.length) return {};

  // Primary: WeatherNext 3 (BigQuery). Unconfigured / failing → empty map.
  const wnP: Promise<WeatherNextLoad> = loadWeatherNext(unique).catch((err) => {
    const error = err instanceof Error ? err.message : String(err);
    console.error("[isobar] WeatherNext load failed", error);
    return { configured: true, init: null, byCity: new Map(), error };
  });
  const previousP = loadPrevious(unique).catch((err) => {
    logChange("forecast-fail", `forecast fetch failed ${errMsg(err)}`);
    return null;
  });
  const metarsP = loadMetarHistory(unique).catch((err) => {
    console.error("[isobar] METAR fetch failed", err);
    return null;
  });

  const wn = await wnP;
  const wnCovers = (cityId: string) => {
    const hit = wn.byCity.get(cityId);
    return Boolean(hit && Object.values(hit.membersByDate).some((m) => ensembleOk(m)));
  };
  // Fallback: Open-Meteo ensemble only for cities WeatherNext did not cover.
  const omCities = unique.filter((c) => !wnCovers(c.id));
  const ensembleP = loadEnsemble(omCities).then(
    (r) => r,
    (err) => {
      const error = errMsg(err);
      logChange("ensemble-fetch", `ensemble fetch failed ${error}`);
      return { map: new Map<string, EnsembleEntry>(), error } satisfies EnsembleLoad;
    },
  );

  const [ensemble, previous, metars] = await Promise.all([ensembleP, previousP, metarsP]);

  // Logged once per state change, not on every paper-worker tick.
  logChange(
    "ensemble-unavailable",
    ensemble.error ? (/^ensemble /.test(ensemble.error) ? ensemble.error : `ensemble unavailable ${ensemble.error}`) : null,
  );

  const out: Record<string, WeatherNow> = {};
  const now = Date.now();

  for (const city of unique) {
    const prev = previous?.get(city.id);
    const wnCity = wnCovers(city.id) ? wn.byCity.get(city.id) : undefined;
    // UI hourly: Open-Meteo forecast when present, else WeatherNext p50 (local wall-clock strings, same shape).
    const hourly = prev?.hourly ?? (wnCity ? localHourly(wnCity.hourly, city.tz, now) : []);
    const metar = metars?.latest.get(city.icao);
    const metarC = metar?.temp ?? null;
    // Display only — never used as an observation.
    const currentC = metarC ?? prev?.currentC ?? (hourly[0]?.tempC ?? null);
    // Observed max = real METAR reports at the settlement station, obsTime <= now,
    // inside the city's current local day. Forecast hours are never "observed".
    const observedMaxC = metars ? observedMaxForLocalDay(metars.reports.get(city.icao) ?? [], city.tz, now) : null;
    // One provider per city (never mix members across providers for a date).
    const membersByDate: Record<string, number[]> = wnCity ? { ...wnCity.membersByDate } : {};
    if (!wnCity) {
      const prefix = `${city.id}:`;
      for (const [key, val] of ensemble.map.entries()) {
        if (key.startsWith(prefix)) {
          membersByDate[key.slice(prefix.length)] = val.members;
        }
      }
    }
    const localDate = new Intl.DateTimeFormat("en-CA", { timeZone: city.tz }).format(new Date());
    // Quant: never ens.members / dates[0] fallback.
    const members = membersByDate[localDate] ?? [];
    const hasEnsemble = !wnCity && Object.values(membersByDate).some((m) => m.length >= 8);
    const sources = [
      wnCity ? weatherNextSourceLabel(wnCity.init) : null,
      hasEnsemble ? "Open-Meteo ensemble" : null,
      prev ? "Open-Meteo forecast" : null,
      metar ? `METAR ${city.icao}` : null,
    ].filter(Boolean) as string[];

    out[city.id] = {
      tempC: currentC,
      humidity: prev?.humidity ?? null,
      windMs: metar?.wspd != null ? metar.wspd * 0.5144 : (prev?.windMs ?? null),
      weatherCode: prev?.weatherCode ?? null,
      cover: metar?.cover ?? null,
      station: city.station ?? metar?.name ?? (city.icao || null),
      observedAt: metar?.reportTime ?? prev?.currentTime ?? null,
      observedMaxC,
      modelMeanC: members.length ? mean(members) : (prev?.dailyMax ?? null),
      modelStdC: members.length ? stdev(members) : null,
      modelMinC: members.length ? Math.min(...members) : null,
      modelMaxC: members.length ? Math.max(...members) : null,
      membersC: members,
      membersByDate,
      localDate,
      hourly,
      source: sources.join(" · ") || "unavailable",
    };
  }

  return out;
}

function localHourly(points: HourPoint[], tz: string, now: number): HourPoint[] {
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz || "UTC",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  });
  return points
    .filter((h) => Date.parse(h.time) > now - 3600_000)
    .slice(0, 48)
    .map((h) => {
      const p = Object.fromEntries(fmt.formatToParts(new Date(h.time)).map((x) => [x.type, x.value]));
      return { time: `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}`, tempC: h.tempC };
    });
}

type ForecastCity = {
  currentC: number | null;
  humidity: number | null;
  windMs: number | null;
  weatherCode: number | null;
  currentTime: string | null;
  hourly: HourPoint[];
  dailyMax: number | null;
};

function parseForecast(raw: PrevResult | PrevResult[], cities: CityMeta[]) {
  const list = asList(raw);
  const map = new Map<string, ForecastCity>();
  for (let i = 0; i < list.length && i < cities.length; i++) {
    const row = list[i];
    const city = cities[i];
    const times = row.hourly?.time ?? [];
    const temps = row.hourly?.temperature_2m ?? [];
    const hourly: HourPoint[] = [];
    for (let h = 0; h < times.length && h < 48; h++) {
      const t = temps[h];
      if (typeof t === "number") hourly.push({ time: times[h], tempC: t });
    }
    map.set(city.id, {
      currentC: row.current?.temperature_2m ?? hourly[0]?.tempC ?? null,
      humidity: row.current?.relative_humidity_2m ?? null,
      windMs: row.current?.wind_speed_10m ?? null,
      weatherCode: row.current?.weather_code ?? null,
      currentTime: row.current?.time ?? null,
      hourly,
      dailyMax: row.daily?.temperature_2m_max?.[0] ?? null,
    });
  }
  return map;
}

async function fetchForecast(cities: CityMeta[]) {
  const lats = cities.map((c) => c.lat.toFixed(4)).join(",");
  const lons = cities.map((c) => c.lon.toFixed(4)).join(",");
  const urls = [
    `https://previous-runs-api.open-meteo.com/v1/forecast?latitude=${lats}&longitude=${lons}&current=temperature_2m,relative_humidity_2m,wind_speed_10m,weather_code&hourly=temperature_2m&daily=temperature_2m_max,temperature_2m_min&forecast_days=4&timezone=auto&wind_speed_unit=ms`,
    `https://previous-runs-api.open-meteo.com/v1/forecast?latitude=${lats}&longitude=${lons}&hourly=temperature_2m&daily=temperature_2m_max,temperature_2m_min&forecast_days=4&timezone=auto`,
  ];
  let lastErr: unknown;
  for (const url of urls) {
    try {
      return await fetchJson<PrevResult | PrevResult[]>(url);
    } catch (err) {
      lastErr = err;
      // A rate limit applies to the whole endpoint: never fire the second URL into it.
      if (isRateLimitError(err)) break;
    }
  }
  throw lastErr ?? new Error("forecast unavailable");
}

/**
 * Dashboard forecast (display only). Cached per city for FORECAST_REFRESH_MS;
 * only cities past that age are requested (one batched call), and during a 429
 * cooldown nothing is requested and last good data (≤ 6 h) is served.
 */
async function loadPrevious(cities: CityMeta[], now = Date.now()) {
  const store = fcStore();
  const pending = [...(g().__isobarFcInflight?.values() ?? [])];
  if (pending.length) {
    await Promise.all(pending);
    now = Date.now();
  }
  const due = cities.filter((c) => {
    const hit = store.get(c.id);
    return (!hit || now - hit.at >= FORECAST_REFRESH_MS) && !triedRecently(FORECAST_ENDPOINT, c.id, now);
  });
  if (due.length && !coolingDown(FORECAST_ENDPOINT, now)) {
    const key = ensembleKey(due);
    const inflight = (g().__isobarFcInflight ??= new Map());
    let p = inflight.get(key);
    if (!p) {
      markTried(FORECAST_ENDPOINT, due, now);
      p = (async () => {
        try {
          const parsed = parseForecast(await fetchForecast(due), due);
          const at = Date.now();
          for (const [id, v] of parsed) store.set(id, { at, value: v });
          clearCooldown(FORECAST_ENDPOINT);
          logChange("forecast-fail", null);
        } catch (err) {
          if (isRateLimitError(err)) {
            tripCooldown(FORECAST_ENDPOINT, err, servingNote(store, cities, FORECAST_LAST_GOOD_MS, Date.now()));
          } else {
            logChange("forecast-fail", `forecast fetch failed ${errMsg(err).slice(0, 240)}`);
          }
        }
      })().finally(() => {
        inflight.delete(key);
      });
      inflight.set(key, p);
    }
    await p;
  }
  const map = new Map<string, ForecastCity>();
  const nowAfter = Date.now();
  for (const c of cities) {
    const hit = store.get(c.id);
    if (hit && nowAfter - hit.at < FORECAST_LAST_GOOD_MS) map.set(c.id, hit.value);
  }
  return map;
}

type MetarHistory = { latest: Map<string, Metar>; reports: Map<string, Metar[]> };

/** aviationweather.gov caps a response at 400 rows; keep batches well under it. */
const METAR_ROW_CAP = 400;
const METAR_BATCH = 6;
const METAR_TTL = 5 * 60_000;
/**
 * Per-attempt timeout. Healthy replies take < 1 s; the production aborts were
 * responses that stalled mid-transfer and never finished, so fail fast and retry
 * on a fresh request instead of waiting longer.
 */
const METAR_TIMEOUT_MS = 8_000;
const METAR_ATTEMPTS = 3;
/** In-flight aviationweather requests (their limit is 100 req/min; stay polite). */
const METAR_CONCURRENCY = 3;
/** A station's last good reports stand in for a failed refresh this long. */
const METAR_LAST_GOOD_MS = 3 * 3600_000;
/** aviationweather.gov asks for a custom User-Agent so automated filtering does not block us. */
const METAR_UA = "IsobarDesk/1.0 (+https://isobar-production.up.railway.app; paper-only weather desk)";

let metarBackoffMs = 1_000;
let metarLastGood = new Map<string, { at: number; reports: Metar[] }>();

/** Test helper — clear last-good METAR reports and set retry backoff. */
export function _resetMetarState(backoffMs = 1_000) {
  metarBackoffMs = backoffMs;
  metarLastGood = new Map();
}

function limiter(n: number) {
  let active = 0;
  const queue: Array<() => void> = [];
  return async <T>(fn: () => Promise<T>): Promise<T> => {
    if (active >= n) await new Promise<void>((r) => queue.push(r));
    else active++;
    try {
      return await fn();
    } finally {
      const next = queue.shift();
      if (next) next();
      else active--;
    }
  };
}
const metarSlot = limiter(METAR_CONCURRENCY);

/** Timeouts, network errors, 429 and 5xx are worth another try; 4xx / bad JSON are not. */
export function metarRetryable(err: unknown) {
  if (!(err instanceof Error)) return false;
  if (err.name === "AbortError" || err.name === "TimeoutError") return true;
  if (err.name === "TypeError" && /fetch failed/i.test(err.message)) return true;
  return /^(429|5\d\d) /.test(err.message);
}

async function fetchMetarRows(ids: string[], hours: number): Promise<Metar[]> {
  const url = `https://aviationweather.gov/api/data/metar?ids=${ids.join(",")}&format=json&hours=${hours}`;
  for (let attempt = 1; ; attempt++) {
    try {
      return await metarSlot(() => fetchJson<Metar[]>(url, { headers: { "user-agent": METAR_UA } }, METAR_TIMEOUT_MS));
    } catch (err) {
      if (attempt >= METAR_ATTEMPTS || !metarRetryable(err)) throw err;
      // Exponential backoff with jitter, outside the concurrency slot.
      const base = metarBackoffMs * 2 ** (attempt - 1);
      await new Promise((r) => setTimeout(r, base / 2 + Math.random() * base));
    }
  }
}

function localDateOf(ms: number, tz: string) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: tz || "UTC" }).format(new Date(ms));
}

/** Hours since local midnight in tz (+1 h slack), for the METAR `hours=` window. */
export function hoursSinceLocalMidnight(tz: string, now: number) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", { timeZone: tz || "UTC", hour: "2-digit", minute: "2-digit", hourCycle: "h23" })
      .formatToParts(new Date(now))
      .map((p) => [p.type, p.value]),
  );
  return Math.min(30, Math.ceil(Number(parts.hour) + Number(parts.minute) / 60) + 1);
}

function metarMs(m: Metar) {
  if (typeof m.obsTime === "number") return m.obsTime * 1000;
  const t = Date.parse(m.reportTime ?? "");
  return Number.isFinite(t) ? t : NaN;
}

/** Max METAR temp (°C) observed at or before now on the city's current local date. */
export function observedMaxForLocalDay(reports: Metar[], tz: string, now: number): number | null {
  const today = localDateOf(now, tz);
  let best: number | null = null;
  for (const r of reports) {
    const ms = metarMs(r);
    if (!Number.isFinite(ms) || ms > now || typeof r.temp !== "number" || !Number.isFinite(r.temp)) continue;
    if (localDateOf(ms, tz) !== today) continue;
    best = best == null ? r.temp : Math.max(best, r.temp);
  }
  return best;
}

async function fetchMetarBatch(ids: string[], hours: number): Promise<Metar[]> {
  const rows = await cached(`metarh:${ids.join(",")}:${hours}`, METAR_TTL, () => fetchMetarRows(ids, hours));
  const list = Array.isArray(rows) ? rows : [];
  // Possibly truncated → split and retry so no station loses its early-day reports.
  if (list.length >= METAR_ROW_CAP && ids.length > 1) {
    const mid = Math.ceil(ids.length / 2);
    const [a, b] = await Promise.all([fetchMetarBatch(ids.slice(0, mid), hours), fetchMetarBatch(ids.slice(mid), hours)]);
    return [...a, ...b];
  }
  return list;
}

/** Today's METAR history per station (all reports since local midnight). */
async function loadMetarHistory(cities: CityMeta[], now = Date.now()): Promise<MetarHistory> {
  const withIcao = cities.filter((c) => c.icao);
  const need = new Map<string, number>();
  for (const c of withIcao) need.set(c.icao, Math.max(need.get(c.icao) ?? 0, hoursSinceLocalMidnight(c.tz, now)));
  const ids = [...need.keys()].sort((a, b) => need.get(a)! - need.get(b)!);
  const batches: Array<{ ids: string[]; hours: number }> = [];
  for (let i = 0; i < ids.length; i += METAR_BATCH) {
    const chunk = ids.slice(i, i + METAR_BATCH);
    batches.push({ ids: chunk, hours: Math.max(...chunk.map((id) => need.get(id)!)) });
  }
  const results = await Promise.all(
    batches.map(async (b) => {
      try {
        const rows = await fetchMetarBatch(b.ids, b.hours);
        const at = Date.now();
        for (const id of b.ids) metarLastGood.set(id, { at, reports: rows.filter((r) => r.icaoId === id) });
        return rows;
      } catch (err) {
        // Keep each station's last good reports so one failed refresh does not blank its observed max
        // (observedMaxForLocalDay still drops anything from a previous local day).
        const kept = b.ids.flatMap((id) => {
          const hit = metarLastGood.get(id);
          return hit && Date.now() - hit.at < METAR_LAST_GOOD_MS ? [hit] : [];
        });
        console.error(
          "[isobar] METAR history batch failed",
          b.ids.join(","),
          `${err instanceof Error ? err.message : String(err)}; kept last good for ${kept.length}/${b.ids.length}`,
        );
        return kept.flatMap((k) => k.reports);
      }
    }),
  );
  const reports = new Map<string, Metar[]>();
  const latest = new Map<string, Metar>();
  for (const row of results.flat()) {
    if (!row.icaoId) continue;
    const list = reports.get(row.icaoId);
    if (list) list.push(row);
    else reports.set(row.icaoId, [row]);
    const prev = latest.get(row.icaoId);
    if (!prev || metarMs(row) > metarMs(prev)) latest.set(row.icaoId, row);
  }
  return { latest, reports };
}
