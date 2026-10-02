# ISOBAR paper worker

Paper-only Polymarket weather desk. **No live CLOB orders.**

## 24/7 Arm

Production builds use Nitro **`node-server`** (see `vite.config.ts`) so `setInterval` survives on Railway.

The Node process boots `server/plugins/paper-worker.ts`, which runs `startPaperWorker()` on a 25s tick:

1. Build desk snapshot (WeatherNext 3 primary, Open-Meteo ECMWF ensemble fallback, METAR + Gamma)
2. Settle open fills only from Gamma `closed` + winner (never from 98¢ prints)
3. If armed, Kelly paper fills with Quant caps
4. Persist to `${ISOBAR_DATA_DIR}/paper-book.json`

The desk UI polls `getPaperBookFn` on a short interval (see `usePaperBookQuery` in `desk-app.tsx`). Closing the browser does **not** stop the bot.

## Env

| Var | Purpose |
| --- | --- |
| `ISOBAR_DATA_DIR` | Persistence dir. **Set to `/data` on Railway** (volume mount). Code default is `/data`. |
| `ISOBAR_PAPER_ARMED` | Headless arm on empty book (`true`/`false`) |
| `VITE_AUTH_ENABLED` | Keep `false` for the desk |
| `ISOBAR_LIVE` / private keys | If set, worker **refuses to arm** |

### WeatherNext 3 (primary forecast, optional)

Unset → the desk uses the Open-Meteo ensemble exactly as before.

| Var | Purpose |
| --- | --- |
| `ISOBAR_WEATHERNEXT_PROJECT` | GCP project that runs/pays for query jobs (e.g. `polym-509212`). Required. |
| `ISOBAR_WEATHERNEXT_DATASET` | Linked WeatherNext dataset, `weathernext_3` or `otherproject.weathernext_3`. Required. |
| `ISOBAR_WEATHERNEXT_CREDENTIALS_JSON` | Service-account key JSON (raw or base64). Read from env, never written to disk. Omit to use ADC / `GOOGLE_APPLICATION_CREDENTIALS`. |
| `ISOBAR_WEATHERNEXT_TABLE` | Default `weathernext_3_0_0_0p05deg` (station-head 2 m temp). |
| `ISOBAR_WEATHERNEXT_LOCATION` | Default `US`. |
| `ISOBAR_WEATHERNEXT_INIT_HOURS` | UTC inits to use, default `0,12` (subset of `0,6,12,18`). |
| `ISOBAR_WEATHERNEXT_PROBE_MIN` | Min minutes between "new init yet?" probes, default `30`. Probes only run while a due init is missing. |
| `ISOBAR_WEATHERNEXT_MAX_HOURS` | Lead hours kept, default `120`. |
| `ISOBAR_WEATHERNEXT_DAILY_GIB` / `ISOBAR_WEATHERNEXT_MONTHLY_GIB` | Hard byte caps (billed bytes), default `40` / `1200` GiB. Counter persisted (atomically) to `${ISOBAR_DATA_DIR}/weathernext-usage.json`, so caps survive restarts. Over cap → keep last init (≤30 h) or fall back to Open-Meteo. |
| `ISOBAR_WEATHERNEXT_MAX_ESTIMATE_GIB` | Pre-run limit, default `28`. Every billed job is dry-run first; if BigQuery's estimate is above this the job is not started (back off 1 h, Open-Meteo fallback). Keep it below the project's `QueryUsagePerDay` custom quota. |
| `ISOBAR_WEATHERNEXT_DISABLED` | `true` = kill switch. |

GCP setup (one time):

1. Create a service account in the billing project, e.g. `isobar-weathernext@<project>.iam.gserviceaccount.com`.
2. Grant **BigQuery Job User** (`roles/bigquery.jobUser`) on the project.
3. Grant **BigQuery Data Viewer** (`roles/bigquery.dataViewer`) on the `weathernext_3` dataset
   (`bq add-iam-policy-binding --member=serviceAccount:<sa> --role=roles/bigquery.dataViewer <project>:weathernext_3`, or dataset → Share in the console).
4. Create a JSON key and paste it into Railway as `ISOBAR_WEATHERNEXT_CREDENTIALS_JSON`; set `ISOBAR_WEATHERNEXT_PROJECT` and `ISOBAR_WEATHERNEXT_DATASET`.

How members are built: one batched query per init returns hourly p10/p50/p90 at the nearest 0.05° cell for every city.
50 synthetic members use fixed normal-score ranks; each member takes the same rank every hour (comonotonic), and its
daily max is the max over that city-local date. Under that assumption this is exactly the quantile of the daily max;
real hour-to-hour correlation is slightly below 1, so it is a small low bias on the mean max. A local date is only
emitted when the init covers local 11:00–23:00; otherwise that date has no members and is not traded.

Cost: point lookups are pruned by geography clustering, so the bill ≈ 196 MiB per city per init (4 columns; measured in
production: ~9.2 GiB per full 48-city init). The
"new init?" probe is a dry run (`SELECT init_time … WHERE init_time = <init>`; estimate > 0 ⇔ published), so it is free.
Fetches run in batches of 8 cities. `0,12` inits × 48 cities ≈ 19 GiB/day ≈ 580 GiB/month, capped at
40 GiB/day and 1200 GiB/month (2× headroom; above the 1 TiB/month free tier only in a worst case, paid from GCP credit).
The caps count **billed** bytes (`totalBytesBilled`, min 10 MiB/job); every batch is pre-flight checked at
200 MiB/city against both the daily and monthly cap, so a batch never starts if it could cross either cap.

Init cache (restarts/deploys do not re-bill): the loaded init's per-city rows (50 daily-max members per local date,
hourly p50, grid cell, requested lat/lon) plus the init time and metadata (dataset/table, `maxHours`, savedAt, cities
with no cell) are written atomically (tmp + rename) to `${ISOBAR_DATA_DIR}/weathernext-cache.json` after every fetched
batch, and loaded on startup when its version/table/`maxHours` match. Only inits newer than the cached one are fetched;
a city whose coordinates changed is refetched. Look for `WeatherNext init … loaded from cache … (no BigQuery job)` in
the logs.

Switching inits: a newer init is fetched only if the **full pass** for every city (200 MiB × cities, ~9.4 GiB for 48)
fits the remaining daily *and* monthly budget; otherwise the older cached init keeps serving (log: `keeping cached
init`) until budget frees up (next UTC day) or it goes stale (>30 h). Only when there is no usable older init is a
partial load allowed: then the cities fetched before a cap are kept and the rest are filled from the same init once
budget frees up; uncovered cities use Open-Meteo meanwhile.

**Estimate ≠ bill.** BigQuery's pre-run estimate ignores clustering: it is the whole init_time partition for every
selected column (0.05° view, measured 2026-10-01: init_time only ≈ 1.2–5 GB, init_time+geography ≈ 21 GB, the 4
forecast columns ≈ 1.47 TB per init regardless of city count). A project `QueryUsagePerDay` custom quota and
`maximumBytesBilled` are both checked against that estimate *before* running, so with a custom quota below ~1.5 TiB
the fetch is rejected ("Custom quota exceeded") even though it would bill ~196 MiB/city. The desk detects this with
the free dry run and skips the job (see `ISOBAR_WEATHERNEXT_MAX_ESTIMATE_GIB`). To actually run WeatherNext with a
custom quota in place, either raise the quota above the estimate (and the env var with it; the in-code billed-byte
caps still bound real spend), or run jobs from a billing project without that quota.

Smoke test: `scripts/weathernext-smoke.ts` (one dry-run probe + one fetch).

### Open-Meteo fallback (quiet)

Open-Meteo free tier: 600 / min, 5 000 / h, 10 000 / day **weighted** calls. An ensemble request weighs
(variables × members) / 10 per location, so `ecmwf_ifs025` (51 members) with `daily=temperature_2m_max` is 5.1 calls
per city (the old max+min request was 10.2 → ~490 per 48-city pass; at the old 8-min cache that was ~3 700/h and
blew the daily limit within hours, after which every request 429'd).

- **Ensemble**: requested only for cities WeatherNext does not cover with a fresh init (none / stale / cap / error).
  Cached per city; a city is re-requested at most every `ensembleRefreshMs(n)` = max(30 min, interval keeping the
  ensemble under 6 000 weighted calls/day) → 30 min for a few cities, ~59 min for all 48. Last good members serve for
  up to 12 h.
- **Forecast** (dashboard hourly/current, `previous-runs-api`): cached per city, refreshed every 30 min (~1 weighted
  call/city), last good kept 6 h.
- **429 / 403**: the endpoint (ensemble or forecast, separately) goes on cooldown: Retry-After if sent (+≤10 % jitter),
  else exponential backoff 60 s × 2^(n-1) with ±25 % jitter, capped at 1 h (Open-Meteo's reason text raises the
  floor: "Hourly" → next UTC hour, "Daily" → ≥30 min, cap 6 h). No requests during cooldown; last good data keeps
  serving. One log line per cooldown (`Open-Meteo ensemble HTTP 429 …: cooling down …`) and one on recovery; other
  failures are logged on change, not per tick, and retried at most every 2 min.

Never attach Polymarket/CLOB secrets to this service. Do not wire this to poly5m / poly15m live services.

## Health

`GET /health` → `{ ok, worker: { running, armed, lastTickAt, openFills, … }, openFills }`

## Settlement model

- Forecast points and METAR observations use the **settlement station** from the market rules (`cities.ts`), e.g. NYC = LaGuardia (KLGA), London = London City (EGLC), Paris = Le Bourget (LFPB), Hong Kong = HK Observatory (no METAR).
- NOAA/Weather Underground markets settle on whole degrees (nearest), so a bucket "72°F" is the true max in [71.5, 72.5). HKO markets ("one decimal place") truncate: "28°C" = [28.0, 29.0). The rule is read from each event description.
- Observed max = max METAR temperature at the settlement station since local midnight, at or before now (aviationweather `hours=` history). Forecast hours never count as observed, and it only conditions today's (local) HIGH markets.
- "Lowest temperature" events are shown but never priced (members are daily maxima).

## Caps (Quant freeze)

- Min edge 6¢, price 5–85¢
- 0.12 Kelly, max 8% cash per fill
- Max 4 fills/tick, 8 open, 1/event, 2/city-date
- Fill price = worse of mid vs ask
- Skip stake under $5 (no round-up)
- Cash = bankroll + closed − openCost
- Truncate fills log without dropping open rows
