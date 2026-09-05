# ISOBAR paper worker

Paper-only Polymarket weather desk. **No live CLOB orders.**

## 24/7 Arm

Production builds use Nitro **`node-server`** (see `vite.config.ts`) so `setInterval` survives on Railway.

The Node process boots `server/plugins/paper-worker.ts`, which runs `startPaperWorker()` on a 25s tick:

1. Build desk snapshot (Open-Meteo + Gamma)
2. Settle open fills only from Gamma `closed` + winner (never from 98¢ prints)
3. If armed, Kelly paper fills with Quant caps
4. Persist to `${ISOBAR_DATA_DIR}/paper-book.json`

The desk UI polls `getPaperBookFn` on a short interval (see `usePaperBookQuery` in `desk-app.tsx`). Closing the browser does **not** stop the bot.

## Env

| Var | Purpose |
| --- | --- |
| `ISOBAR_DATA_DIR` | Persistence dir. **Set to `/data` on Railway** (volume mount). Code default is `/data`. |
| `ISOBAR_PAPER_ARMED` | `true` re-arms the worker each tick (24/7). `false` leaves the book/UI Arm state |
| `VITE_AUTH_ENABLED` | Keep `false` for the desk |
| `ISOBAR_LIVE` / private keys | If set, worker **refuses to arm** |
| `OPEN_METEO_API_KEY` | Paid Open-Meteo key. Routes ensemble to `customer-ensemble-api`. Optional — on 429 the desk falls back to 8 global models on `api.open-meteo.com` |

Never attach Polymarket/CLOB secrets to this service. Do not wire this to poly5m / poly15m live services.

## Health

`GET /health` → `{ ok, worker: { running, armed, lastTickAt, openFills, … }, openFills }`

## Caps (Quant freeze)

- Min edge 6¢; NO 5–85¢; YES 3–85¢
- 0.12 Kelly, max 8% cash per fill
- Max 4 fills/tick, 8 open, **1/event, 1/city-date**
- YES only on the modal bucket (highest modelP ≥ 20%, members near). Live high: lo ≤ obs + 2.5°C / 4.5°F
- NO only if bucket mid is ≥ 5°C / 9°F from model mean and from observed; never in-bucket or crowd YES ≥ 80¢
- Fill price = worse of mid vs ask
- Skip stake under $5 (no round-up)
- Cash = bankroll + closed − openCost
- Truncate fills log without dropping open rows
- Daily-high uses `membersByDate`; daily-low uses `membersMinByDate`
- Dedicated ensemble-api 429 → 8-model forecast fallback. Paper-only. No live CLOB.
