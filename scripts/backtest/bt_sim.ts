/* eslint-disable @typescript-eslint/no-explicit-any */
// ISOBAR backtest harness: runs a repo checkout's own assembleDeskSnapshot + paperTrade over historical
// Polymarket prices (CLOB prices-history), WeatherNext inits (cached BigQuery pulls) and METAR history.
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
const ROOT = process.env.ROOT ?? "/workspace/ISOBAR";
const VARIANT = process.env.VARIANT ?? "current";
const OUT = process.env.OUT ?? `${process.env.BT_DIR ?? "/workspace/diag-isobar"}/sim_${VARIANT}.json`;
const DEPTH = process.env.DEPTH ?? "p25";
const PARAMS = process.env.PARAMS ? JSON.parse(process.env.PARAMS) : null;
const LAT_H = 7;
const D = process.env.BT_DIR ?? "/workspace/diag-isobar";

// ---- fake clock (old code reads new Date() internally)
const RealDate = Date;
let simNow = RealDate.now();
class FakeDate extends RealDate {
  constructor(...a: any[]) { if (a.length === 0) super(simNow); else super(...(a as [any])); }
  static now() { return simNow; }
}
(globalThis as any).Date = FakeDate;
process.env.ISOBAR_DATA_DIR = "/tmp/isobar-bt-data";

const snapMod = await import(`${ROOT}/src/lib/desk/snapshot.ts`);
const book = await import(`${ROOT}/src/lib/desk/paper-book.ts`);
const parse = await import(`${ROOT}/src/lib/desk/parse.ts`);
const citiesMod = await import(`${ROOT}/src/lib/desk/cities.ts`);
let strategy: any = null;
try { strategy = await import(`${ROOT}/src/lib/desk/strategy.ts`); } catch {}
if (strategy && PARAMS) strategy._setStrategyParams(PARAMS);

// ---- data
const events: any[] = JSON.parse(readFileSync(`${D}/bt_events.json`, "utf8"));
const rows: any[] = JSON.parse(readFileSync(`${D}/${process.env.ROWS ?? "bt_rows5.json"}`, "utf8"));
const PXMODE = process.env.PXMODE ?? "last";
const histByTok = new Map<string, { t: number; p: number }[]>();
for (const r of rows) for (const b of r.buckets) if (b.hist?.length) histByTok.set(b.tok, b.hist);
const wn: { init: string; ms: number; cities: Record<string, any> }[] = [];
for (const f of readdirSync(`${D}/wn`)) {
  if (!/^\d{4}-.*T\d\d\.json$/.test(f)) continue;
  const j = JSON.parse(readFileSync(`${D}/wn/${f}`, "utf8"));
  wn.push({ init: j.init, ms: RealDate.parse(j.init), cities: j.cities });
}
wn.sort((a, b) => a.ms - b.ms);
const metar = new Map<string, { ms: number; t: number }[]>();
for (const line of readFileSync(`${D}/metar_hist.csv`, "utf8").split("\n").slice(1)) {
  const [st, valid, tc] = line.split(",");
  if (!st || !valid || tc === "M" || tc == null) continue;
  const t = Number(tc);
  if (!Number.isFinite(t)) continue;
  (metar.get(st) ?? metar.set(st, []).get(st)!).push({ ms: RealDate.parse(valid.replace(" ", "T") + ":00Z"), t });
}
for (const v of metar.values()) v.sort((a, b) => a.ms - b.ms);

// ---- live-book calibration (Oct 2 snapshot of 248 weather books): spread p75, ask depth ($) p25/median
function spreadFor(p: number) { return p < 0.1 ? 0.03 : p < 0.2 ? 0.04 : p < 0.6 ? 0.04 : 0.1; }
function depthFor(p: number) {
  const t = DEPTH === "median"
    ? (p < 0.1 ? [3, 11] : p < 0.2 ? [30, 68] : p < 0.4 ? [70, 132] : p < 0.6 ? [107, 330] : [136, 283])
    : (p < 0.1 ? [2, 6] : p < 0.2 ? [12, 44] : p < 0.4 ? [28, 75] : p < 0.6 ? [20, 133] : [17, 66]);
  return t;
}
const r3 = (x: number) => Math.round(x * 1000) / 1000;
function quote(p: number) {
  const hs = spreadFor(p) / 2;
  return { bid: r3(Math.max(0.001, p - hs)), ask: r3(Math.min(0.999, p + hs)), spread: r3(Math.min(0.999, p + hs) - Math.max(0.001, p - hs)) };
}
/** Synthetic ask ladder for a side bought at price `ask` (dollar depth → shares). */
function ladder(ask: number) {
  const [d1, d3] = depthFor(ask);
  const l2 = r3(Math.min(0.999, ask + 0.02));
  return [{ price: ask, size: d1 / ask }, { price: l2, size: Math.max(0, d3 - d1) / l2 }];
}
function pxAt(tok: string, t: number) {
  const h = histByTok.get(tok);
  if (!h) return null;
  // Conservative vs. staleness: the first print at/after the decision time (≤45 min later), i.e. a price
  // that has already seen every observation the model used; else the last print before it.
  let best: number | null = null;
  for (const x of h) { if (x.t <= t) best = x.p; else { if (PXMODE === "next" && x.t - t <= 2700) best = x.p; break; } }
  return best;
}

// ---- helpers
const fmtCache = new Map<string, Intl.DateTimeFormat>();
function parts(ms: number, tz: string) {
  let f = fmtCache.get(tz);
  if (!f) { f = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }); fmtCache.set(tz, f); }
  const p = Object.fromEntries(f.formatToParts(new RealDate(ms)).map((x) => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, hm: `${p.hour}:${p.minute}`, hour: Number(p.hour) % 24 };
}
function localToUtc(date: string, hour: number, tz: string) {
  let guess = RealDate.parse(`${date}T${String(hour).padStart(2, "0")}:00:00Z`);
  for (let i = 0; i < 3; i++) {
    const p = parts(guess, tz);
    const asUtc = RealDate.parse(`${p.date}T${p.hm}:00Z`);
    guess -= asUtc - RealDate.parse(`${date}T${String(hour).padStart(2, "0")}:00:00Z`);
  }
  return guess;
}
function addDays(date: string, n: number) { return new RealDate(RealDate.parse(`${date}T00:00:00Z`) + n * 86400_000).toISOString().slice(0, 10); }
function wnFor(cityId: string, t: number) {
  for (let i = wn.length - 1; i >= 0; i--) if (wn[i].ms + LAT_H * 3600_000 <= t && wn[i].cities[cityId]) return wn[i].cities[cityId];
  return null;
}
function localHourly(points: { time: string; tempC: number }[], tz: string, now: number) {
  return points.filter((h) => RealDate.parse(h.time) > now - 3600_000).slice(0, 48).map((h) => {
    const p = parts(RealDate.parse(h.time), tz);
    return { time: `${p.date}T${p.hm}`, tempC: h.tempC };
  });
}
function weatherAt(city: any, t: number) {
  const w = wnFor(city.id, t);
  if (!w) return null;
  const local = parts(t, city.tz).date;
  // METARs reach the bot ~10 min after obs time.
  const reps = (metar.get(city.icao) ?? []).filter((r) => r.ms <= t - Number(process.env.METAR_DELAY_MS ?? 600000) && parts(r.ms, city.tz).date === local);
  const obsMax = city.icao && reps.length ? Math.max(...reps.map((r) => r.t)) : null;
  const obsMin = city.icao && reps.length ? Math.min(...reps.map((r) => r.t)) : null;
  const last = city.icao && reps.length ? reps[reps.length - 1] : null;
  return {
    init: w.init,
    wx: {
      tempC: last?.t ?? null, humidity: null, windMs: null, weatherCode: null, cover: null, station: city.icao || null,
      observedAt: last ? new RealDate(last.ms).toISOString() : null,
      observedMaxC: obsMax, observedMinC: obsMin,
      latestObsC: last?.t ?? null, latestObsAt: last ? new RealDate(last.ms).toISOString() : null,
      modelMeanC: null, modelStdC: null, modelMinC: null, modelMaxC: null, membersC: [],
      membersByDate: w.membersByDate ?? {}, membersMinByDate: w.membersMinByDate ?? {}, minSource: "WeatherNext 3",
      localDate: local, hourly: localHourly(w.hourly ?? [], city.tz, t), source: "WeatherNext 3",
    },
  };
}

// ---- parsed events (repo parser)
type Ev = { parsed: any; winner: string; date: string; city: any; vol: Record<string, number> };
const evs: Ev[] = [];
for (const e of events) {
  const E = e.event;
  const pt = parse.parseEventTitle(E.title ?? "");
  if (!pt) continue;
  const city = citiesMod.resolveCity(pt.cityRaw);
  if (!city) continue;
  const markets: any[] = [];
  let unit = "C";
  let winner: string | null = null; let nWin = 0;
  for (const m of E.markets ?? []) {
    const bound = parse.parseBucket(m.question ?? "", m.groupItemTitle, parse.settlementRule(m.description || E.description));
    if (!bound) continue;
    unit = parse.detectUnit(m.question ?? "");
    const op = parse.parseJsonArray(m.outcomePrices).map(Number);
    if (op[0] >= 0.99) { winner = String(m.id); nWin++; } else if (!(op[0] <= 0.01)) { nWin = 99; }
    markets.push({ ...m, closed: false, bound, tokens: parse.parseJsonArray(m.clobTokenIds) });
  }
  if (nWin !== 1 || markets.length < 3 || !winner) continue;
  const eventDate = (E.eventDate || E.endDate || "").slice(0, 10);
  evs.push({
    parsed: { eventId: String(E.id), slug: E.slug, title: E.title, city, cityRaw: pt.cityRaw, kind: pt.kind, unit, eventDate, endDate: E.endDate ?? "", volume: Number(E.volume) || 0, volume24hr: 0, liquidity: 0, image: null, context: null, settlement: parse.settlementRule(E.description), markets },
    winner, date: eventDate, city, vol: Object.fromEntries(markets.map((m) => [String(m.id), Number(m.volume) || 0])),
  });
}

const POINTS: [string, number, number][] = [["D-1 18:00", -1, 18], ["D 09:00", 0, 9], ["D 13:00", 0, 13], ["D 16:00", 0, 16]];
type Tick = { ev: Ev; point: string; t: number };
const ticks: Tick[] = [];
for (const ev of evs) for (const [name, dd, hh] of POINTS) ticks.push({ ev, point: name, t: localToUtc(addDays(ev.date, dd), hh, ev.city.tz) });
ticks.sort((a, b) => a.t - b.t);

// ---- sim
let pb: any = { ...book.emptyBook(), settings: { ...book.emptyBook().settings, armed: true } };
const settleAt = (ev: Ev) => localToUtc(addDays(ev.date, 1), 12, ev.city.tz);
const pending: { fill: any; ev: Ev; at: number }[] = [];
const evalRows: any[] = [];
const fillsOut: any[] = [];
const FEE = 0.05;
for (const tk of ticks) {
  simNow = tk.t;
  if (strategy && PARAMS?.cvBiasByDate) { const { cvBiasByDate, ...rest } = PARAMS; strategy._setStrategyParams({ ...rest, stationBiasC: cvBiasByDate[tk.ev.date] ?? {} }); }
  // settle anything due
  for (let i = pending.length - 1; i >= 0; i--) {
    if (pending[i].at > tk.t) continue;
    const { fill, ev } = pending[i];
    pb = { ...pb, fills: book.settleFills(pb.fills, fill.marketId, ev.winner === fill.marketId) };
    pending.splice(i, 1);
  }
  const ev = tk.ev;
  const W = weatherAt(ev.city, tk.t);
  if (!W) continue;
  let allPx = true;
  const markets = ev.parsed.markets.map((m: any) => {
    const p = pxAt(m.tokens[0], Math.floor(tk.t / 1000));
    if (p == null) { allPx = false; return { ...m, yesPrice: 0, noPrice: 1, bestBid: null, bestAsk: null, spread: null }; }
    const q = quote(p);
    return { ...m, yesPrice: p, noPrice: 1 - p, bestBid: q.bid, bestAsk: q.ask, spread: q.spread, volume: ev.vol[String(m.id)] };
  });
  const parsedEv = { ...ev.parsed, markets };
  const snap = snapMod.assembleDeskSnapshot({ events: [parsedEv], weather: { [ev.city.id]: W.wx }, warning: null, now: new FakeDate(tk.t) });
  const de = snap.events[0];
  evalRows.push({
    cityId: ev.city.id, date: ev.date, kind: ev.parsed.kind, unit: ev.parsed.unit, point: tk.point, init: W.init, allPx,
    obs: ev.parsed.kind === "low" ? W.wx.observedMinC : W.wx.observedMaxC,
    members: ev.parsed.kind === "low" ? W.wx.membersMinByDate[ev.date]?.length ?? 0 : W.wx.membersByDate[ev.date]?.length ?? 0,
    meanC: (() => { const m = (ev.parsed.kind === "low" ? W.wx.membersMinByDate : W.wx.membersByDate)[ev.date]; return m?.length ? m.reduce((a: number, b: number) => a + b, 0) / m.length : null; })(),
    b: de.buckets.map((b: any) => ({ id: b.marketId, lo: b.lo, hi: b.hi, px: b.yesPrice, ask: b.bestAsk, mp: b.modelP, bp: b.blendP ?? null, won: b.marketId === ev.winner })),
    sig: snap.signals.map((s: any) => ({ id: s.marketId, side: s.side, edge: s.edge, mp: s.modelP, px: s.marketP })),
  });
  if (!allPx) continue; // never trade an event with unknown bucket prices
  for (const sig of snap.signals) {
    const b = de.buckets.find((x: any) => x.marketId === sig.marketId);
    const m = markets.find((x: any) => String(x.id) === sig.marketId);
    const sideAsk = sig.side === "YES" ? b.bestAsk : r3(1 - b.bestBid);
    const pm = snapMod.pricingModel ? snapMod.pricingModel(W.wx, sig, ev.city.tz, new FakeDate(tk.t)) : { supportMembers: snapMod.membersForEvent(W.wx, sig.date, sig.kind) };
    const opts: any = { bestBid: b.bestBid, bestAsk: b.bestAsk, members: pm.supportMembers, observedC: snapMod.observedForSignal(W.wx, sig), tz: ev.city.tz, lo: b.lo, hi: b.hi, now: new FakeDate(tk.t) };
    if (strategy) opts.asks = ladder(sideAsk);
    const fill = book.paperTrade(sig, pb, opts);
    if (!fill) continue;
    // depth-capped version of fills that ignored the book (old/current): walk the same synthetic ladder up to fill price + 2c
    let capShares = fill.shares, capCost = fill.cost;
    if (!strategy) {
      let need = fill.cost, sh = 0, cost = 0;
      for (const lv of ladder(sideAsk)) { if (need <= 1e-9) break; const take = Math.min(lv.size, need / lv.price); sh += take; cost += take * lv.price; need -= take * lv.price; }
      capShares = sh; capCost = cost;
    }
    const won = sig.side === "YES" ? ev.winner === sig.marketId : ev.winner !== sig.marketId;
    const px = fill.price;
    const fee = (sh: number, p: number) => FEE * sh * p * (1 - p);
    fillsOut.push({
      cityId: ev.city.id, date: ev.date, kind: ev.parsed.kind, point: tk.point, side: sig.side, label: b.label, price: px, shares: fill.shares, cost: fill.cost,
      modelP: sig.modelP, rawModelP: b.modelP, edge: sig.edge, won,
      pnl: (won ? fill.shares : 0) - fill.cost - fee(fill.shares, px),
      capCost, capPnl: (won ? capShares : 0) - capCost - fee(capShares, capShares ? capCost / capShares : px),
      volume: ev.vol[sig.marketId],
    });
    pb = { ...pb, fills: [fill, ...pb.fills] };
    pending.push({ fill, ev, at: settleAt(ev) });
  }
}
writeFileSync(OUT, JSON.stringify({ variant: VARIANT, depth: DEPTH, params: PARAMS, evalRows, fills: fillsOut }));
const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
console.log(VARIANT, DEPTH, "ticks", evalRows.length, "fills", fillsOut.length, "won", fillsOut.filter((f) => f.won).length,
  "cost", sum(fillsOut.map((f) => f.cost)).toFixed(0), "pnl", sum(fillsOut.map((f) => f.pnl)).toFixed(0), "capCost", sum(fillsOut.map((f) => f.capCost)).toFixed(0), "capPnl", sum(fillsOut.map((f) => f.capPnl)).toFixed(0));
