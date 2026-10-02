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
| `ISOBAR_PAPER_ARMED` | `true` re-arms the paper worker every tick (headless, 24/7). `false` (Railway default) leaves the book/UI Arm state alone. `ISOBAR_LIVE` / keys always win and disarm. |
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
- **Ensemble daily min** (low markets): requested only for cities with a live "Lowest temperature" market whose
  WeatherNext daily-min members do not cover every live low date. Separate `daily=temperature_2m_min` request
  (5.1 calls/city), same per-city cache, same 429 cooldown as the max (sent after the max, never into a cooldown),
  and counted in the same 6 000/day budget (`ensembleRefreshMs(maxCities + minCities)`).
- **Multi-model** (tertiary, `api.open-meteo.com/v1/forecast`, 8 global deterministic models → 8 members): only for
  cities with no WeatherNext and no Open-Meteo ensemble members, not even last good (ensemble cooling down / failing).
  ~1–2 weighted calls/city, at most every 30 min per city, own 429 cooldown, last good kept 12 h.
- **Forecast** (dashboard hourly/current, `previous-runs-api`): cached per city, refreshed every 30 min (~1 weighted
  call/city), last good kept 6 h.
- **429 / 403**: the endpoint (ensemble or forecast, separately) goes on cooldown: Retry-After if sent (+≤10 % jitter),
  else exponential backoff 60 s × 2^(n-1) with ±25 % jitter, capped at 1 h (Open-Meteo's reason text raises the
  floor: "Hourly" → next UTC hour, "Daily" → ≥30 min, cap 6 h). No requests during cooldown; last good data keeps
  serving. One log line per cooldown (`Open-Meteo ensemble HTTP 429 …: cooling down …`) and one on recovery; other
  failures are logged on change, not per tick, and retried at most every 2 min.

Never attach Polymarket/CLOB secrets to this service. Do not wire this to poly5m / poly15m live services.

## Health

`GET /health` → `{ ok, worker: { running, armed, lastTickAt, openFills, liveLocked, ticks, lastError, filledLastTick, cash }, openFills, fills, cash, pnl, marks, markPnl, cities, tickets }`

- **Mark-to-market** (never the model probability): an open ticket is worth shares × the exit price of the held
  side — the YES best bid for YES, 1 − YES best ask for NO, the mid when that side has no quote — minus cost. Quotes
  come from the Gamma read of each open market every tick (`book.marks`, fills themselves are never edited); a ticket
  with no quote yet is valued at cost (PnL 0). Settled tickets: payout − cost from the resolution.
- `markPnl`: total mark-to-market PnL of open tickets.
- `cities`: per-city ledger (`cityLedger`) — YES/NO/open/won/lost counts, cost, closed PnL and mark-to-market PnL,
  ranked by closed PnL then mark. Same field on the desk's paper API (the desk ledger).
- `tickets`: one row per fill (city, side, date, question, status, price, cost, `mark` exit price, `markSource`
  bid / mid / none / settled, mark PnL).

## Settlement model

- Forecast points and METAR observations use the **settlement station** from the market rules (`cities.ts`), e.g. NYC = LaGuardia (KLGA), London = London City (EGLC), Paris = Le Bourget (LFPB), Hong Kong = HK Observatory (no METAR).
- NOAA/Weather Underground markets settle on whole degrees (nearest), so a bucket "72°F" is the true max in [71.5, 72.5). HKO markets ("one decimal place") truncate: "28°C" = [28.0, 29.0). The rule is read from each event description.
- Observed max = max METAR temperature at the settlement station since local midnight, at or before now (aviationweather `hours=` history). Forecast hours never count as observed, and it only conditions today's (local) HIGH markets.
- Observed min mirrors it: min METAR temperature at the settlement station since local midnight, at or before now; it only conditions today's (local) LOW markets (members capped at the observed min, buckets wholly above it → 0).
- "Lowest temperature" events are priced from **daily-MIN** members only (`membersMinByDate`, never the max members): WeatherNext daily min (comonotonic min of the hourly quantiles, a date only when all 24 local hours are covered) when it covers every live low date, else the Open-Meteo ensemble daily min. WeatherNext min members are computed from the same rows as the max (no extra BigQuery bytes); cache entries written before this change simply lack them until the next scheduled init. Same settlement rounding (bucket bounds) as highs. On its live local day a low market without an observed min (no METAR at the settlement station, e.g. HKO, or METAR unavailable) is priced for display but never traded — the low is usually already set by morning.

## Live-day (intraday) model

On the city's current local date, with an observed extreme at the settlement station, the daily max (min) is
priced from the time of day, not just floored by the observation:

- f = fraction of the warming window still ahead: 1 before 06:00 local, 0 two hours after the hourly forecast's own
  peak (clamped 13–18 h; 17 h without an hourly forecast). Lows: 0 one hour after the forecast pre-noon trough (4–10 h).
- Forecast bias = mean of (latest METAR − forecast for that hour, ≤ 3 h old) and (observed extreme − forecast
  extreme over the elapsed hours), clamped ±4 °C. Target = bias-corrected max (min) of the hours still ahead.
- Samples X_i = f·mean + (1−f)·target + (m_i − mean)·√f, Gaussian σ = max(0.5 °C, KDE bandwidth·√f).
- P(bucket) = (1−f)·P(max(obs, X) ∈ bucket) + f·P(X ∈ bucket | X ≥ obs) (mirror for lows). Early in the day this
  is the old floor/renormalization; after the peak the mass collapses onto the observed bucket with only the upside
  the remaining hours' forecast supports. The member-support test uses the conditioned finals max(obs, X_i).
- A live-day high without an observed max (no METAR, e.g. HKO) is not traded from 12:00 local (lows: all day).

## Caps (Quant freeze)

- Min edge 6¢; NO 5–85¢; YES 3–85¢
- 0.12 Kelly, max 8% cash per fill
- Max 4 fills/tick, 8 open, 1/event, **1/city-date**
- Near-certainty gate: YES only on the modal bucket (highest modelP ≥ 20 %) with a raw ensemble member within one
  KDE bandwidth (KDE tail mass is not support). Live day: YES bucket at most 2.5 °C / 4.5 °F past the observed
  extreme. NO only if no member is near the bucket, the observation is not in it, its mid is ≥ 5 °C / 9 °F from the
  model mean and the observation, and crowd YES < 80¢. YES signals fill before NO. modelP is never mutated.
- Edges are against the executable price: YES ask, NO = 1 − YES bid (never better than the mid). paperTrade
  re-checks modelP − fill price ≥ 6¢ and re-sizes Kelly at the fill price.
- Market-sanity guard: when one bucket of an event trades ≥ 85¢, no YES on any other bucket of that event. Exception
  on the live day: the observed extreme already sits in the bucket bought (stale market). Other days: the model gives
  the favorite < 50 %.
- Live-day deference: on the city's live local day, once the warming (cooling) window has started (f < 1), YES only
  on the market's favorite bucket (the crowd has higher-frequency observations than our METAR; our live-day edge is
  sharpness on the same favorite). `PAPER_LIVE_DAY_DEFER`.
- Open-ended tail buckets ("X or below / or higher"): YES only if the ensemble median is inside the bucket.
- Fill price = worse of mid vs ask
- Skip stake under $5 (no round-up)
- Cash = bankroll + closed − openCost
- Truncate fills log without dropping open rows
