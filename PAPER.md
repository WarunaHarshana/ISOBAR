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

- Min edge 6¢; NO 5–85¢; YES 3–85¢ (member-supported winning bucket)
- 0.12 Kelly, max 8% cash per fill
- Max 4 fills/tick, 12 open, 2/event, 2/city-date
- Fill YES (near-bucket) before NO so the book is not all tail shorts
- Fill price = worse of mid vs ask
- Skip stake under $5 (no round-up)
- Cash = bankroll + closed − openCost
- Truncate fills log without dropping open rows
- Daily-high uses `membersByDate`; daily-low uses `membersMinByDate`
- YES needs at least one ensemble member within KDE bandwidth of the bucket (no KDE-tail fills)
- Dedicated ensemble-api 429 → 8-model forecast fallback (ECMWF/GFS/ICON/GEM/JMA/Météo-France/UKMO/CMA). Paper-only. No live CLOB.
