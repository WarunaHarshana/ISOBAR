// Manual smoke test (not part of npm test): runs ONE dry-run probe + ONE batched fetch
// through the real provider using Application Default Credentials, then prints
// WeatherNext vs Open-Meteo ensemble daily-max means.
//
//   ISOBAR_WEATHERNEXT_PROJECT=... ISOBAR_WEATHERNEXT_DATASET=weathernext_3 \
//   ISOBAR_DATA_DIR=/tmp/isobar-smoke \
//   node --experimental-strip-types --import ./scripts/ts-test-resolve.mjs scripts/weathernext-smoke.ts nyc london tokyo
//
// Cost: probe is a free dry run; ~90 MiB per city billed (fetch is dry-run first and skipped if the
// estimate exceeds ISOBAR_WEATHERNEXT_MAX_ESTIMATE_GIB).
import { CITIES } from "../src/lib/desk/cities.ts";
import { loadWeatherNext, weatherNextUsage } from "../src/lib/desk/weathernext.ts";

const ids = process.argv.slice(2);
const cities = CITIES.filter((c) => ids.includes(c.id));
if (!cities.length) throw new Error("pass city ids, e.g. nyc london tokyo");

const wn = await loadWeatherNext(cities);
if (wn.error) console.error("WeatherNext error:", wn.error);
console.log("init:", wn.init, "usage:", weatherNextUsage());

const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
const q = (xs: number[], p: number) => [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor(p * xs.length))];

console.log("| City | Local date | WN3 mean °C | WN3 p10–p90 °C | Open-Meteo ens mean °C | OM members | Δ (WN−OM) |");
console.log("| --- | --- | --- | --- | --- | --- | --- |");
for (const city of cities) {
  const url = `https://ensemble-api.open-meteo.com/v1/ensemble?latitude=${city.lat}&longitude=${city.lon}&daily=temperature_2m_max&forecast_days=4&timezone=${encodeURIComponent(city.tz)}&models=ecmwf_ifs025`;
  const om = (await (await fetch(url)).json()) as { daily?: Record<string, Array<number | string | null>> };
  const dates = (om.daily?.time ?? []).map(String);
  const wnCity = wn.byCity.get(city.id);
  for (let d = 0; d < dates.length; d++) {
    const date = dates[d];
    const omMembers = Object.entries(om.daily ?? {})
      .filter(([k]) => k.startsWith("temperature_2m_max"))
      .map(([, v]) => v[d])
      .filter((v): v is number => typeof v === "number");
    const m = wnCity?.membersByDate[date];
    const omMean = omMembers.length ? mean(omMembers) : NaN;
    const wnMean = m?.length ? mean(m) : NaN;
    console.log(
      `| ${city.name} | ${date} | ${Number.isFinite(wnMean) ? wnMean.toFixed(1) : "—"} | ${m?.length ? `${q(m, 0.1).toFixed(1)}–${q(m, 0.9).toFixed(1)}` : "—"} | ${Number.isFinite(omMean) ? omMean.toFixed(1) : "—"} | ${omMembers.length} | ${Number.isFinite(wnMean - omMean) ? (wnMean - omMean).toFixed(1) : "—"} |`,
    );
  }
}
