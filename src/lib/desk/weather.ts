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

function asList<T>(raw: T | T[]): T[] {
  return Array.isArray(raw) ? raw : [raw];
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

function dayIndexFor(dates: string[] | undefined, eventDate: string) {
  if (!dates?.length) return 0;
  const i = dates.indexOf(eventDate);
  return i >= 0 ? i : 0;
}

export async function loadWeather(cities: CityMeta[]): Promise<Record<string, WeatherNow>> {
  const unique = [...new Map(cities.filter((c) => c.lat !== 0 || c.lon !== 0).map((c) => [c.id, c])).values()];
  if (!unique.length) return {};

  const [ensemble, previous, metars] = await Promise.all([
    loadEnsemble(unique).catch(() => null),
    loadPrevious(unique).catch(() => null),
    loadMetars(unique).catch(() => null),
  ]);

  const out: Record<string, WeatherNow> = {};
  const now = Date.now();

  for (const city of unique) {
    const ens = ensemble?.get(city.id);
    const prev = previous?.get(city.id);
    const metar = metars?.get(city.icao);
    const hourly = prev?.hourly ?? [];
    const pastHours = hourly.filter((h) => Date.parse(h.time) <= now);
    const observedFromHourly = pastHours.length ? Math.max(...pastHours.map((h) => h.tempC)) : null;
    const metarC = metar?.temp ?? null;
    const currentC = metarC ?? prev?.currentC ?? (hourly[0]?.tempC ?? null);
    const observedMaxC = [observedFromHourly, metarC, currentC].filter((n): n is number => n != null).reduce((a, b) => Math.max(a, b), -Infinity);
    const membersByDate: Record<string, number[]> = {};
    if (ensemble) {
      for (const [key, val] of ensemble.entries()) {
        if (key === city.id) continue;
        if (key.startsWith(`${city.id}:`)) {
          membersByDate[key.slice(city.id.length + 1)] = val.members;
        }
      }
    }
    const localDate = new Intl.DateTimeFormat("en-CA", { timeZone: city.tz }).format(new Date());
    // Quant: never fall back to ens.members (API dates[0] can be the wrong event day).
    const members = membersByDate[localDate] ?? [];
    const sources = [
      ens ? "Open-Meteo ensemble" : null,
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

async function loadEnsemble(cities: CityMeta[]) {
  const lats = cities.map((c) => c.lat.toFixed(4)).join(",");
  const lons = cities.map((c) => c.lon.toFixed(4)).join(",");
  const url = `https://ensemble-api.open-meteo.com/v1/ensemble?latitude=${lats}&longitude=${lons}&daily=temperature_2m_max,temperature_2m_min&forecast_days=4&timezone=auto`;
  const raw = await cached(`ens:${lats}`, 8 * 60_000, () => fetchJson<EnsembleResult | EnsembleResult[]>(url));
  const list = asList(raw);
  const map = new Map<string, { members: number[]; dates: string[] }>();
  for (let i = 0; i < list.length && i < cities.length; i++) {
    const row = list[i];
    const city = cities[i];
    if (!row.daily) continue;
    const dates = (row.daily.time ?? []).map(String);
    const today = dates[0] ?? new Date().toISOString().slice(0, 10);
    map.set(city.id, { members: memberValues(row.daily, dayIndexFor(dates, today)), dates });
    for (let d = 0; d < dates.length; d++) {
      map.set(`${city.id}:${dates[d]}`, { members: memberValues(row.daily, d), dates });
    }
  }
  return map;
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
