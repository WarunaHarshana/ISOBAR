import type { CityMeta, HourPoint, WeatherNow } from "./types";
import { cached, fetchJson } from "./cache";
import { mean, stdev } from "./math";

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

type EnsembleGlobals = {
  __isobarEnsInflight?: Promise<EnsembleLoad> | null;
  __isobarEnsNegUntil?: number;
  __isobarEnsNeg?: EnsembleLoad | null;
};

const ENSEMBLE_CHUNK = 8;
const ENSEMBLE_TTL = 8 * 60_000;
const ENSEMBLE_TIMEOUT_MS = 20_000;
const ENSEMBLE_NEG_MS = 120_000;
const ENSEMBLE_TZ_GAP_MS = 250;
const ENSEMBLE_TRANSIENT_RETRY_MS = 1_000;

function g(): EnsembleGlobals {
  return globalThis as EnsembleGlobals;
}

function asList<T>(raw: T | T[]): T[] {
  return Array.isArray(raw) ? raw : [raw];
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
  const url = `https://ensemble-api.open-meteo.com/v1/ensemble?latitude=${lats}&longitude=${lons}&daily=temperature_2m_max,temperature_2m_min&forecast_days=4&timezone=${tz}`;
  const cacheKey = `ens:tz:${timezone}:${cities.map((c) => c.id).join(",")}`;
  const raw = await cached(cacheKey, ENSEMBLE_TTL, () =>
    fetchJson<EnsembleResult | EnsembleResult[]>(url, {}, ENSEMBLE_TIMEOUT_MS),
  );
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

function isRateLimited(msg: string | null | undefined) {
  return Boolean(msg && (/\b429\b/.test(msg) || /\b403\b/.test(msg)));
}

function isUriTooLong(msg: string | null | undefined) {
  return Boolean(msg && (/\b400\b/.test(msg) || /URI Too Long/i.test(msg)));
}

function isTransient(msg: string | null | undefined) {
  return Boolean(msg && (/\b5\d\d\b/.test(msg) || /timeout|aborted/i.test(msg)));
}

function retryAfterMs(msg: string | null | undefined) {
  const m = msg ? /retry-after=(\S+)/i.exec(msg) : null;
  if (!m) return ENSEMBLE_NEG_MS;
  const raw = m[1].replace(/[;,].*$/, "");
  const sec = Number(raw);
  if (Number.isFinite(sec) && sec >= 0) return Math.min(Math.max(sec * 1000, 1_000), 15 * 60_000);
  const date = Date.parse(raw);
  if (Number.isFinite(date)) return Math.min(Math.max(date - Date.now(), 1_000), 15 * 60_000);
  return ENSEMBLE_NEG_MS;
}

function setNegativeCache(msg: string | null | undefined): EnsembleLoad {
  const neg: EnsembleLoad = { map: new Map(), error: "ensemble rate-limited" };
  g().__isobarEnsNeg = neg;
  g().__isobarEnsNegUntil = Date.now() + retryAfterMs(msg);
  console.error("[isobar] ensemble 429/403 negative cache", retryAfterMs(msg), "ms");
  return neg;
}

/** Test helper — drop 429 cooldown + single-flight between cases. */
export function _resetEnsembleGuards() {
  const glob = g();
  glob.__isobarEnsInflight = null;
  glob.__isobarEnsNegUntil = 0;
  glob.__isobarEnsNeg = null;
}

async function loadEnsemble(cities: CityMeta[]): Promise<EnsembleLoad> {
  if (!cities.length) return { map: new Map(), error: null };
  const glob = g();
  const now = Date.now();
  if (glob.__isobarEnsNegUntil && now < glob.__isobarEnsNegUntil) {
    return glob.__isobarEnsNeg ?? { map: new Map(), error: "ensemble rate-limited" };
  }
  if (glob.__isobarEnsInflight) return glob.__isobarEnsInflight;
  glob.__isobarEnsInflight = loadEnsembleOnce(cities).finally(() => {
    glob.__isobarEnsInflight = null;
  });
  return glob.__isobarEnsInflight;
}

async function loadEnsembleOnce(cities: CityMeta[]): Promise<EnsembleLoad> {
  const map = new Map<string, EnsembleEntry>();

  const tryBatch = async (batch: CityMeta[], timezone: string, label: string) => {
    try {
      mergeEnsemble(map, await fetchEnsembleBatch(batch, timezone));
      return null as string | null;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[isobar] ensemble ${label} failed`, msg);
      return msg;
    }
  };

  const tryBatchOnceRetry = async (batch: CityMeta[], timezone: string, label: string) => {
    const err = await tryBatch(batch, timezone, label);
    if (!isTransient(err) || isRateLimited(err)) return err;
    await sleep(ENSEMBLE_TRANSIENT_RETRY_MS);
    return tryBatch(batch, timezone, `${label} retry`);
  };

  let rateLimitedMsg: string | null = null;
  let tzIndex = 0;
  for (const [tz, group] of groupCitiesByTimezone(cities)) {
    if (rateLimitedMsg) break;
    if (tzIndex > 0) await sleep(ENSEMBLE_TZ_GAP_MS);
    tzIndex += 1;
    const err = await tryBatchOnceRetry(group, tz, `tz ${tz}`);
    if (!err && group.every((c) => cityInMap(map, c.id))) continue;
    if (isRateLimited(err)) {
      rateLimitedMsg = err;
      break;
    }
    if (!isUriTooLong(err)) continue;
    for (let i = 0; i < group.length; i += ENSEMBLE_CHUNK) {
      if (rateLimitedMsg) break;
      const chunk = group.slice(i, i + ENSEMBLE_CHUNK);
      const missing = chunk.filter((c) => !cityInMap(map, c.id));
      if (!missing.length) continue;
      const chunkErr = await tryBatchOnceRetry(missing, tz, `tz ${tz} chunk`);
      if (isRateLimited(chunkErr)) {
        rateLimitedMsg = chunkErr;
        break;
      }
      if (!isUriTooLong(chunkErr)) continue;
      for (const city of missing) {
        if (cityInMap(map, city.id)) continue;
        const cityErr = await tryBatchOnceRetry([city], tz, city.id);
        if (isRateLimited(cityErr)) {
          rateLimitedMsg = cityErr;
          break;
        }
      }
    }
  }

  if (rateLimitedMsg) return setNegativeCache(rateLimitedMsg);

  const failed = cities.filter((c) => !cityInMap(map, c.id)).map((c) => c.id);
  let error: string | null = null;
  if (failed.length) {
    error =
      failed.length === cities.length
        ? `ensemble unavailable (${failed.join(", ")})`
        : `ensemble missing ${failed.join(", ")}`;
    console.error("[isobar]", error);
    if (failed.length !== cities.length) error = null;
  }
  return { map, error };
}

export async function loadWeather(cities: CityMeta[]): Promise<Record<string, WeatherNow>> {
  const unique = [...new Map(cities.filter((c) => c.lat !== 0 || c.lon !== 0).map((c) => [c.id, c])).values()];
  if (!unique.length) return {};

  const ensembleP = loadEnsemble(unique).then(
    (r) => r,
    (err) => {
      const error = err instanceof Error ? err.message : String(err);
      console.error("[isobar] ensemble fetch failed", err);
      return { map: new Map<string, EnsembleEntry>(), error } satisfies EnsembleLoad;
    },
  );

  const [ensemble, previous, metars] = await Promise.all([
    ensembleP,
    loadPrevious(unique).catch((err) => {
      console.error("[isobar] forecast fetch failed", err);
      return null;
    }),
    loadMetars(unique).catch((err) => {
      console.error("[isobar] METAR fetch failed", err);
      return null;
    }),
  ]);

  if (ensemble.error) {
    console.error("[isobar] ensemble unavailable", ensemble.error);
  }

  const out: Record<string, WeatherNow> = {};
  const now = Date.now();

  for (const city of unique) {
    const prev = previous?.get(city.id);
    const metar = metars?.get(city.icao);
    const hourly = prev?.hourly ?? [];
    const pastHours = hourly.filter((h) => Date.parse(h.time) <= now);
    const observedFromHourly = pastHours.length ? Math.max(...pastHours.map((h) => h.tempC)) : null;
    const metarC = metar?.temp ?? null;
    const currentC = metarC ?? prev?.currentC ?? (hourly[0]?.tempC ?? null);
    const observedMaxC = [observedFromHourly, metarC, currentC]
      .filter((n): n is number => n != null)
      .reduce((a, b) => Math.max(a, b), -Infinity);
    const membersByDate: Record<string, number[]> = {};
    const prefix = `${city.id}:`;
    for (const [key, val] of ensemble.map.entries()) {
      if (key.startsWith(prefix)) {
        membersByDate[key.slice(prefix.length)] = val.members;
      }
    }
    const localDate = new Intl.DateTimeFormat("en-CA", { timeZone: city.tz }).format(new Date());
    // Quant: never ens.members / dates[0] fallback.
    const members = membersByDate[localDate] ?? [];
    const hasEnsemble = Object.values(membersByDate).some((m) => m.length >= 8);
    const sources = [
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
      station: metar?.name ?? (city.icao || null),
      observedAt: metar?.reportTime ?? prev?.currentTime ?? null,
      observedMaxC: Number.isFinite(observedMaxC) ? observedMaxC : null,
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

async function loadPrevious(cities: CityMeta[]) {
  const lats = cities.map((c) => c.lat.toFixed(4)).join(",");
  const lons = cities.map((c) => c.lon.toFixed(4)).join(",");
  const urls = [
    `https://previous-runs-api.open-meteo.com/v1/forecast?latitude=${lats}&longitude=${lons}&current=temperature_2m,relative_humidity_2m,wind_speed_10m,weather_code&hourly=temperature_2m&daily=temperature_2m_max,temperature_2m_min&forecast_days=4&timezone=auto&wind_speed_unit=ms`,
    `https://previous-runs-api.open-meteo.com/v1/forecast?latitude=${lats}&longitude=${lons}&hourly=temperature_2m&daily=temperature_2m_max,temperature_2m_min&forecast_days=4&timezone=auto`,
  ];
  let raw: PrevResult | PrevResult[] | null = null;
  let lastErr: unknown;
  for (const url of urls) {
    try {
      raw = await cached(`prev:${url.slice(0, 80)}`, 8 * 60_000, () => fetchJson<PrevResult | PrevResult[]>(url));
      break;
    } catch (err) {
      lastErr = err;
    }
  }
  if (!raw) throw lastErr ?? new Error("forecast unavailable");
  const list = asList(raw);
  const map = new Map<
    string,
    {
      currentC: number | null;
      humidity: number | null;
      windMs: number | null;
      weatherCode: number | null;
      currentTime: string | null;
      hourly: HourPoint[];
      dailyMax: number | null;
    }
  >();
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

async function loadMetars(cities: CityMeta[]) {
  const ids = cities.map((c) => c.icao).filter(Boolean).join(",");
  if (!ids) return new Map<string, Metar>();
  const url = `https://aviationweather.gov/api/data/metar?ids=${ids}&format=json`;
  const raw = await cached(`metar:${ids}`, 3 * 60_000, () =>
    fetchJson<Metar[]>(url, { headers: { "user-agent": "IsobarDesk/1.0" } }),
  );
  const map = new Map<string, Metar>();
  for (const row of raw ?? []) {
    if (row.icaoId) map.set(row.icaoId, row);
  }
  return map;
}
