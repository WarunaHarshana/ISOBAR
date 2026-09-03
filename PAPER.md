# ISOBAR paper worker

Paper-only Polymarket weather desk. **No live CLOB orders.**

## 24/7 Arm

The Railway Node process boots `server/plugins/paper-worker.ts`, which runs `startPaperWorker()` on a 25s tick:

1. Build desk snapshot (Open-Meteo + Gamma)
2. Settle open fills only from Gamma `closed` + winner (never from 98¢ prints)
3. If armed, Kelly paper fills with Quant caps
4. Persist to `${ISOBAR_DATA_DIR}/paper-book.json`

## Env

| Var | Purpose |
| --- | --- |
| `ISOBAR_DATA_DIR` | Persistence dir (Railway volume `/data`) |
| `ISOBAR_PAPER_ARMED` | Headless arm on empty book (`true`/`false`) |
| `VITE_AUTH_ENABLED` | Keep `false` for the desk |
| `ISOBAR_LIVE` / private keys | If set, worker **refuses to arm** |

Never attach Polymarket/CLOB secrets to this service.

## Health

`GET /health` → `{ ok, worker, openFills }`

## Caps (Quant freeze)

- Min edge 6¢, price 5–85¢
- 0.12 Kelly, max 8% cash per fill
- Max 4 fills/tick, 8 open, 1/event, 2/city
- Skip stake under $5 (no round-up)
- Cash = bankroll + closed − openCost
