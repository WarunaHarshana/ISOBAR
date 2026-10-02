# WeatherNext backtest (paper desk)

Replays a checkout's own `assembleDeskSnapshot` + `paperTrade` over closed Polymarket temperature events.
Data lives in `BT_DIR` (default `/workspace/diag-isobar`). Python 3 + Node 22 (`--experimental-strip-types`).

1. `bt_fetch.py` (closed Gamma events) → `bt_prices.py` (bucket bounds, winners, 30-min history) →
   `bt_hist5.py` (5-min history, `bt_rows5.json`).
2. `bt_need.py` → `bt_need.json`: (init, city) pairs actually used at the decision points (latest 00Z/12Z init
   published ≥ 7 h before D-1 18:00 / D 09:00 / 13:00 / 16:00 local).
3. `bt_wn_fetch.ts`: one BigQuery job per init with the repo's `buildFetchSql` + `parseFetchRows`
   (`bq` CLI, user account, label `app:isobar-backtest`, job ids `isobar_bt_*`), cached to `wn/`, ledger of billed
   bytes, stops at `STOP_GIB` (280). ~100–190 MiB per city per init. Verify with
   `INFORMATION_SCHEMA.JOBS_BY_PROJECT WHERE job_id LIKE 'isobar_bt_%'`.
4. METAR history: IEM `asos.py` (US stations by 3-letter id) → `metar_hist.csv`; live books: `bt_books.py`.
5. `bt_sim.ts`: `ROOT=<checkout> VARIANT=<name> [PARAMS=<json>] [DEPTH=p25|median] [PXMODE=last|next]
   [METAR_DELAY_MS=600000] node --experimental-strip-types --import <repo>/scripts/ts-test-resolve.mjs bt_sim.ts`.
   `PARAMS` is passed to `strategy._setStrategyParams` (plus `cvBiasByDate` for leave-one-date-out bias).
6. Scoring: `bt_eval.py` (Brier/log-loss/calibration), `bt_blendcv.py` (blend w, leave-one-date-out),
   `bt_bias.py` (per-station bias), `grid.py` / `final.py` (strategy variants).
