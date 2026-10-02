// Backtest fetch: the repo's own buildFetchSql/parseFetchRows, one job per init (user account via bq CLI).
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { buildFetchSql, parseFetchRows, type WeatherNextConfig } from "../../src/lib/desk/weathernext.ts";
import { CITIES } from "../../src/lib/desk/cities.ts";
const DIR = `${process.env.BT_DIR ?? "/workspace/diag-isobar"}/wn`;
const BQ = "/home/box/google-cloud-sdk/google-cloud-sdk/bin/bq";
const STOP_GIB = Number(process.env.STOP_GIB ?? 280);
const ONLY = process.env.ONLY ? Number(process.env.ONLY) : Infinity;
const cfg = { projectId: "polym-509212", datasetProject: "polym-509212", dataset: "weathernext_3", table: "weathernext_3_0_0_0p05deg", location: "US", maxHours: 120 } as WeatherNextConfig;
const need: Record<string, string[]> = JSON.parse(readFileSync(`${process.env.BT_DIR ?? "/workspace/diag-isobar"}/bt_need.json`, "utf8"));
const ledgerFile = `${DIR}/ledger.json`;
const ledger: { init: string; job: string; cities: number; billed: number }[] = existsSync(ledgerFile) ? JSON.parse(readFileSync(ledgerFile, "utf8")) : [];
let total = ledger.reduce((a, x) => a + x.billed, 0);
let n = 0;
for (const init of Object.keys(need).sort()) {
  const file = `${DIR}/${init.slice(0, 13)}.json`;
  if (existsSync(file)) continue;
  if (n++ >= ONLY) break;
  const cities = need[init].map((id) => CITIES.find((c) => c.id === id)!).filter(Boolean);
  const est = cities.length * 200 * 1024 ** 2;
  if (total + est > STOP_GIB * 1024 ** 3) { console.log("STOP budget", (total / 1024 ** 3).toFixed(1)); break; }
  const sql = buildFetchSql(cfg, cities, init);
  const job = `isobar_bt_${init.slice(0, 13).replace(/[-:T]/g, "")}_${Date.now()}`;
  const out = execFileSync(BQ, ["--project_id=polym-509212", "--location=US", "query", "--use_legacy_sql=false", "--format=json", "--max_rows=1000000", `--job_id=${job}`, "--label=app:isobar-backtest", sql], { maxBuffer: 1 << 30, encoding: "utf8" });
  const rows = JSON.parse(out.slice(out.indexOf("[")));
  const meta = JSON.parse(execFileSync(BQ, ["--project_id=polym-509212", "--location=US", "show", "--format=json", "-j", job], { encoding: "utf8" }));
  const billed = Number(meta.statistics?.query?.totalBytesBilled ?? meta.statistics?.totalBytesBilled ?? 0);
  total += billed;
  const parsed = parseFetchRows(rows, cities);
  writeFileSync(file, JSON.stringify({ init, cities: Object.fromEntries(parsed), rawRows: rows.length }));
  ledger.push({ init, job, cities: cities.length, billed });
  writeFileSync(ledgerFile, JSON.stringify(ledger, null, 1));
  console.log(init, cities.length, "cities", parsed.size, "parsed", (billed / 1024 ** 2).toFixed(0), "MiB", "total", (total / 1024 ** 3).toFixed(2), "GiB");
}
