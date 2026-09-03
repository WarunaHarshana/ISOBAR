import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  Activity,
  ArrowUpRight,
  CloudSun,
  Crosshair,
  Droplets,
  RefreshCw,
  Thermometer,
  Wind,
} from "lucide-react";
import { toast } from "sonner";
import { Area, AreaChart, ResponsiveContainer, Tooltip as RTooltip, XAxis, YAxis } from "recharts";
import { fetchDeskSnapshot } from "@/lib/desk/server";
import { realizedPnl, useDeskStore } from "@/lib/desk/store";
import { weatherLabel } from "@/lib/desk/parse";
import type { DeskEvent, DeskSnapshot, MarketBucket, Signal, WeatherNow } from "@/lib/desk/types";
import { cn, convertTemp, formatPct, formatTemp, formatUsd } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Skeleton } from "@/components/ui/skeleton";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function fmtDate(iso: string) {
  const [, m, d] = (iso || "").split("-");
  if (!m || !d) return iso;
  return `${Number(d)} ${MONTHS[Number(m) - 1]}`;
}

function fmtTime(iso: string | null) {
  if (!iso) return "—";
  const t = iso.slice(11, 16);
  return t || iso;
}

export function DeskApp({ initial }: { initial: DeskSnapshot }) {
  const query = useQuery({
    queryKey: ["desk"],
    queryFn: () => fetchDeskSnapshot(),
    initialData: initial,
    refetchInterval: 25_000,
    staleTime: 12_000,
  });
  const snapshot = query.data ?? initial;
  const selectedId = useDeskStore((s) => s.selectedEventId);
  const setSelected = useDeskStore((s) => s.setSelected);
  const settings = useDeskStore((s) => s.settings);
  const paperTrade = useDeskStore((s) => s.paperTrade);
  const settle = useDeskStore((s) => s.settle);
  const fills = useDeskStore((s) => s.fills);

  const selected =
    snapshot.events.find((e) => e.eventId === selectedId) ?? snapshot.events[0] ?? null;

  useEffect(() => {
    void useDeskStore.persist.rehydrate();
  }, []);

  useEffect(() => {
    if (!selectedId && snapshot.events[0]) setSelected(snapshot.events[0].eventId);
  }, [selectedId, snapshot.events, setSelected]);

  useEffect(() => {
    for (const ev of snapshot.events) {
      for (const b of ev.buckets) {
        if (b.yesPrice >= 0.98) settle(b.marketId, true);
        else if (b.yesPrice <= 0.02 && b.noPrice >= 0.98) settle(b.marketId, false);
      }
    }
  }, [snapshot.events, settle]);

  useEffect(() => {
    if (!settings.armed) return;
    const { closed } = realizedPnl(fills);
    const bankroll = settings.bankroll + closed;
    let n = 0;
    for (const sig of snapshot.signals) {
      if (sig.edge < settings.minEdge) continue;
      const fill = paperTrade(sig, bankroll);
      if (fill) n += 1;
      if (n >= 4) break;
    }
    if (n > 0) toast.message(`Bot filled ${n} paper order${n === 1 ? "" : "s"}`);
  }, [snapshot.fetchedAt, settings.armed, settings.minEdge, settings.bankroll, snapshot.signals, paperTrade, fills]);

  const wx = selected ? snapshot.weather[selected.cityId] : undefined;
  const pnl = realizedPnl(fills);
  const equity = settings.bankroll + pnl.closed;

  return (
    <div className="min-h-dvh bg-background text-foreground">
      <Header
        snapshot={snapshot}
        fetching={query.isFetching}
        onRefresh={() => query.refetch()}
        equity={equity}
        pnl={pnl.closed}
      />
      <main className="mx-auto max-w-[1440px] px-3 pb-8 sm:px-5">
        {snapshot.warning ? (
          <p className="mt-3 rounded-lg bg-warn/10 px-3 py-2 text-sm text-warn">{snapshot.warning}</p>
        ) : null}
        <StatsRow snapshot={snapshot} equity={equity} openCost={pnl.openCost} />
        <div className="mt-4 hidden gap-4 lg:grid lg:grid-cols-[280px_minmax(0,1fr)_320px]">
          <CityRail events={snapshot.events} selectedId={selected?.eventId} onSelect={setSelected} weather={snapshot.weather} />
          <Board event={selected} weather={wx} onTrade={(s) => paperTrade(s, equity)} />
          <aside className="flex flex-col gap-4">
            <BotCard />
            <SignalsCard signals={snapshot.signals} onPick={setSelected} onTrade={(s) => paperTrade(s, equity)} />
            <FillsCard />
          </aside>
        </div>
        <div className="mt-4 lg:hidden">
          <Tabs defaultValue="board">
            <TabsList className="w-full">
              <TabsTrigger value="markets">Markets</TabsTrigger>
              <TabsTrigger value="board">Board</TabsTrigger>
              <TabsTrigger value="bot">Bot</TabsTrigger>
            </TabsList>
            <TabsContent value="markets">
              <CityRail events={snapshot.events} selectedId={selected?.eventId} onSelect={setSelected} weather={snapshot.weather} />
            </TabsContent>
            <TabsContent value="board">
              <Board event={selected} weather={wx} onTrade={(s) => paperTrade(s, equity)} />
            </TabsContent>
            <TabsContent value="bot" className="flex flex-col gap-4">
              <BotCard />
              <SignalsCard signals={snapshot.signals} onPick={setSelected} onTrade={(s) => paperTrade(s, equity)} />
              <FillsCard />
            </TabsContent>
          </Tabs>
        </div>
      </main>
    </div>
  );
}

function Header({
  snapshot,
  fetching,
  onRefresh,
  equity,
  pnl,
}: {
  snapshot: DeskSnapshot;
  fetching: boolean;
  onRefresh: () => void;
  equity: number;
  pnl: number;
}) {
  const [clock, setClock] = useState("");
  useEffect(() => {
    const tick = () => setClock(new Date().toISOString().slice(11, 19) + "Z");
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, []);
  const armed = useDeskStore((s) => s.settings.armed);

  return (
    <header className="sticky top-0 z-30 border-b border-border bg-background/90 backdrop-blur-sm">
      <div className="mx-auto flex max-w-[1440px] items-center gap-3 px-3 py-3 sm:px-5">
        <div className="flex items-center gap-2.5">
          <span className="flex size-9 items-center justify-center rounded-md bg-primary text-primary-foreground">
            <CloudSun className="size-4" strokeWidth={1.75} />
          </span>
          <div>
            <p className="font-sans text-sm font-semibold tracking-[0.22em]">ISOBAR</p>
            <p className="text-[11px] tracking-wide text-muted-foreground">Polymarket weather desk</p>
          </div>
        </div>
        <div className="ml-auto flex items-center gap-2 sm:gap-3">
          <Badge variant={armed ? "signal" : "outline"}>{armed ? "Bot armed" : "Paper"}</Badge>
          <div className="hidden text-right sm:block">
            <p className="font-mono text-xs tabular text-muted-foreground">{clock || "—"}</p>
            <p className="font-mono text-xs tabular">
              {formatUsd(equity, 0)}{" "}
              <span className={pnl >= 0 ? "text-signal" : "text-danger"}>
                {pnl >= 0 ? "+" : ""}
                {formatUsd(pnl, 0)}
              </span>
            </p>
          </div>
          <Button variant="outline" size="icon" onClick={onRefresh} aria-label="Refresh" className="size-11">
            <RefreshCw className={cn("size-4", fetching && "animate-spin")} />
          </Button>
        </div>
      </div>
      <p className="sr-only">
        {snapshot.totals.events} live temperature markets across {snapshot.totals.cities} cities
      </p>
    </header>
  );
}

function StatsRow({ snapshot, equity, openCost }: { snapshot: DeskSnapshot; equity: number; openCost: number }) {
  const items = [
    { k: "Markets", v: String(snapshot.totals.events) },
    { k: "Cities", v: String(snapshot.totals.cities) },
    { k: "24h volume", v: formatUsd(snapshot.totals.volume24hr, 0) },
    { k: "Edges", v: String(snapshot.totals.openSignals) },
    { k: "Equity", v: formatUsd(equity, 0) },
    { k: "Open risk", v: formatUsd(openCost, 0) },
  ];
  return (
    <section className="mt-4 grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6">
      {items.map((it) => (
        <div key={it.k} className="rounded-xl bg-card px-3 py-3 shadow-[var(--shadow-border)]">
          <p className="text-[11px] tracking-wide text-muted-foreground uppercase">{it.k}</p>
          <p className="mt-1 font-mono text-lg tabular">{it.v}</p>
        </div>
      ))}
    </section>
  );
}

function CityRail({
  events,
  selectedId,
  onSelect,
  weather,
}: {
  events: DeskEvent[];
  selectedId?: string;
  onSelect: (id: string) => void;
  weather: Record<string, WeatherNow>;
}) {
  return (
    <ScrollArea className="h-[min(70vh,720px)] rounded-xl bg-card shadow-[var(--shadow-border)]">
      <ul className="p-2">
        {events.map((ev) => {
          const w = weather[ev.cityId];
          const active = ev.eventId === selectedId;
          return (
            <li key={ev.eventId}>
              <button
                type="button"
                onClick={() => onSelect(ev.eventId)}
                className={cn(
                  "flex w-full items-center gap-3 rounded-lg px-3 py-3 text-left transition-colors duration-150",
                  active ? "bg-accent" : "hover:bg-muted",
                )}
              >
                <div className="min-w-0 flex-1">
                  <div className="flex items-baseline justify-between gap-2">
                    <span className="truncate text-sm font-medium">{ev.cityName}</span>
                    <span className="font-mono text-xs tabular text-muted-foreground">{fmtDate(ev.eventDate)}</span>
                  </div>
                  <div className="mt-1 flex items-center gap-2 font-mono text-[11px] tabular text-muted-foreground">
                    <span>{ev.kind === "high" ? "High" : "Low"}</span>
                    <span>{formatTemp(w?.tempC != null ? convertTemp(w.tempC, ev.unit) : null, ev.unit)}</span>
                    {ev.bestSignal ? (
                      <span className="text-signal">+{formatPct(ev.bestSignal.edge)}</span>
                    ) : null}
                  </div>
                </div>
              </button>
            </li>
          );
        })}
      </ul>
    </ScrollArea>
  );
}

function Board({
  event,
  weather,
  onTrade,
}: {
  event: DeskEvent | null;
  weather?: WeatherNow;
  onTrade: (s: Signal) => void;
}) {
  if (!event) {
    return (
      <div className="rounded-xl bg-card p-8 text-sm text-muted-foreground shadow-[var(--shadow-border)]">
        No live temperature markets right now.
      </div>
    );
  }
  const unit = event.unit;
  const nowTemp = weather?.tempC != null ? convertTemp(weather.tempC, unit) : null;

  return (
    <section className="flex flex-col gap-4">
      <div className="rounded-xl bg-card p-4 shadow-[var(--shadow-border)] sm:p-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <p className="text-[11px] tracking-[0.18em] text-muted-foreground uppercase">
              {event.kind === "high" ? "Daily high" : "Daily low"} · {fmtDate(event.eventDate)}
            </p>
            <h1 className="mt-1 text-2xl font-medium tracking-tight sm:text-3xl">{event.cityName}</h1>
            <p className="mt-1 max-w-prose text-sm text-muted-foreground">
              {weatherLabel(weather?.weatherCode ?? null, weather?.cover ?? null)}
              {weather?.station ? ` · ${weather.station}` : ""}
            </p>
          </div>
          <a
            href={`https://polymarket.com/event/${event.slug}`}
            target="_blank"
            rel="noreferrer"
            className="inline-flex h-11 items-center gap-1 rounded-md px-3 text-sm text-muted-foreground shadow-[var(--shadow-border)] transition-colors hover:text-foreground"
          >
            Market <ArrowUpRight className="size-3.5" />
          </a>
        </div>
        <div className="mt-5 grid grid-cols-2 gap-3 sm:grid-cols-4">
          <Metric icon={Thermometer} label="Now" value={formatTemp(nowTemp, unit)} />
          <Metric icon={Activity} label="Model high" value={event.modelHigh != null ? `${event.modelHigh.toFixed(1)}°${unit}` : "—"} />
          <Metric icon={Crosshair} label="Implied" value={event.implied != null ? `${event.implied.toFixed(1)}°${unit}` : "—"} />
          <Metric icon={CloudSun} label="Observed max" value={event.observed != null ? `${event.observed.toFixed(1)}°${unit}` : "—"} />
        </div>
        <div className="mt-4 flex flex-wrap items-center gap-x-4 gap-y-2 text-xs text-muted-foreground">
          <span className="inline-flex items-center gap-1.5">
            <Droplets className="size-3.5" /> {weather?.humidity != null ? `${Math.round(weather.humidity)}%` : "—"}
          </span>
          <span className="inline-flex items-center gap-1.5">
            <Wind className="size-3.5" /> {weather?.windMs != null ? `${weather.windMs.toFixed(1)} m/s` : "—"}
          </span>
        </div>
        <p className="mt-2 truncate font-mono text-[11px] text-muted-foreground">{weather?.source ?? "—"}</p>
        {weather?.modelStdC != null ? (
          <p className="mt-3 font-mono text-[11px] tabular text-muted-foreground">
            Ensemble {weather.membersC.length} members · σ {weather.modelStdC.toFixed(2)}°C
            {weather.modelMinC != null && weather.modelMaxC != null
              ? ` · range ${weather.modelMinC.toFixed(1)}–${weather.modelMaxC.toFixed(1)}°C`
              : ""}
            {weather.observedAt ? ` · obs ${fmtTime(weather.observedAt)}` : ""}
          </p>
        ) : null}
        <HourlyChart weather={weather} unit={unit} />
      </div>
      <BucketTable event={event} onTrade={onTrade} />
    </section>
  );
}

function Metric({ icon: Icon, label, value }: { icon: typeof Thermometer; label: string; value: string }) {
  return (
    <div className="rounded-lg bg-muted px-3 py-3">
      <p className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
        <Icon className="size-3.5" /> {label}
      </p>
      <p className="mt-1 font-mono text-xl tabular">{value}</p>
    </div>
  );
}

function HourlyChart({ weather, unit }: { weather?: WeatherNow; unit: "C" | "F" }) {
  const data = useMemo(() => {
    const rows = weather?.hourly ?? [];
    return rows.slice(0, 24).map((h) => ({
      t: h.time.slice(11, 16),
      v: convertTemp(h.tempC, unit),
    }));
  }, [weather?.hourly, unit]);
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  if (!data.length) return null;
  return (
    <div className="mt-4 h-40">
      {mounted ? (
        <ResponsiveContainer width="100%" height="100%">
          <AreaChart data={data} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
            <XAxis dataKey="t" tick={{ fill: "#8d97a3", fontSize: 10 }} interval={3} axisLine={false} tickLine={false} />
            <YAxis
              domain={["dataMin - 1", "dataMax + 1"]}
              tick={{ fill: "#8d97a3", fontSize: 10 }}
              axisLine={false}
              tickLine={false}
              width={36}
            />
            <RTooltip
              contentStyle={{ background: "#161b22", border: "1px solid rgba(236,239,243,0.08)", borderRadius: 8, fontSize: 12 }}
              formatter={(v) => [`${Number(v).toFixed(1)}°${unit}`, "Temp"]}
            />
            <Area type="monotone" dataKey="v" stroke="#d7dce2" fill="#d7dce2" fillOpacity={0.12} strokeWidth={1.5} />
          </AreaChart>
        </ResponsiveContainer>
      ) : (
        <Skeleton className="h-full w-full rounded-lg" />
      )}
    </div>
  );
}

function BucketTable({ event, onTrade }: { event: DeskEvent; onTrade: (s: Signal) => void }) {
  return (
    <div className="overflow-hidden rounded-xl bg-card shadow-[var(--shadow-border)]">
      <div className="flex items-center justify-between px-4 py-3">
        <h2 className="text-sm font-medium">Temperature buckets</h2>
        <p className="text-[11px] text-muted-foreground">Model vs last trade</p>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[640px] text-left text-sm">
          <thead className="text-[11px] tracking-wide text-muted-foreground uppercase">
            <tr className="border-t border-border">
              <th className="px-4 py-2 font-medium">Bucket</th>
              <th className="px-2 py-2 font-medium">Market</th>
              <th className="px-2 py-2 font-medium">Model</th>
              <th className="px-2 py-2 font-medium">Edge</th>
              <th className="px-2 py-2 font-medium">Book</th>
              <th className="px-4 py-2 font-medium text-right">Trade</th>
            </tr>
          </thead>
          <tbody>
            {event.buckets.map((b) => (
              <BucketRow key={b.marketId} event={event} bucket={b} onTrade={onTrade} />
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function BucketRow({
  event,
  bucket,
  onTrade,
}: {
  event: DeskEvent;
  bucket: MarketBucket;
  onTrade: (s: Signal) => void;
}) {
  const edge = bucket.edgeYes;
  const side: "YES" | "NO" = bucket.edgeYes >= bucket.edgeNo ? "YES" : "NO";
  const showEdge = side === "YES" ? bucket.edgeYes : bucket.edgeNo;
  const signal: Signal = {
    id: `${bucket.marketId}-${side}`,
    eventId: event.eventId,
    marketId: bucket.marketId,
    cityId: event.cityId,
    cityName: event.cityName,
    date: event.eventDate,
    kind: event.kind,
    unit: event.unit,
    question: bucket.question,
    label: bucket.label,
    side,
    marketP: side === "YES" ? bucket.yesPrice : bucket.noPrice,
    modelP: side === "YES" ? bucket.modelP : 1 - bucket.modelP,
    edge: showEdge,
    kelly: side === "YES" ? bucket.kellyYes : bucket.kellyNo,
    volume24hr: bucket.volume24hr || event.volume24hr,
  };
  return (
    <tr className="border-t border-border">
      <td className="px-4 py-3 font-medium">{bucket.label}</td>
      <td className="px-2 py-3 font-mono tabular">{formatPct(bucket.yesPrice)}</td>
      <td className="px-2 py-3 font-mono tabular">{formatPct(bucket.modelP)}</td>
      <td className={cn("px-2 py-3 font-mono tabular", edge > 0.03 ? "text-signal" : edge < -0.03 ? "text-danger" : "text-muted-foreground")}>
        {edge >= 0 ? "+" : ""}
        {formatPct(edge)}
      </td>
      <td className="px-2 py-3">
        <div className="flex h-2 w-28 overflow-hidden rounded-full bg-muted">
          <div className="h-full bg-primary/80" style={{ width: `${Math.min(100, bucket.yesPrice * 100)}%` }} />
          <div className="h-full bg-signal/70" style={{ width: `${Math.min(100, bucket.modelP * 100)}%` }} />
        </div>
      </td>
      <td className="px-4 py-3 text-right">
        <Button
          variant="outline"
          size="sm"
          disabled={showEdge < 0.03 || signal.marketP < 0.04 || signal.marketP > 0.9}
          onClick={() => {
            onTrade(signal);
            toast.success(`Paper ${side} ${bucket.label}`);
          }}
        >
          {side} {formatPct(signal.marketP, 0)}
        </Button>
      </td>
    </tr>
  );
}

function BotCard() {
  const settings = useDeskStore((s) => s.settings);
  const patch = useDeskStore((s) => s.patchSettings);
  const resetBook = useDeskStore((s) => s.resetBook);
  return (
    <div className="rounded-xl bg-card p-4 shadow-[var(--shadow-border)]">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h2 className="text-sm font-medium">Paper bot</h2>
          <p className="text-xs text-muted-foreground">Kelly-sized. No live CLOB orders.</p>
        </div>
        <div className="flex items-center gap-2">
          <Label htmlFor="arm">Arm</Label>
          <Switch id="arm" checked={settings.armed} onCheckedChange={(v) => patch({ armed: v })} />
        </div>
      </div>
      <Separator className="my-3" />
      <div className="grid grid-cols-2 gap-3">
        <Field label="Bankroll" value={settings.bankroll} onChange={(n) => patch({ bankroll: n })} />
        <Field label="Kelly frac" value={settings.kellyFraction} step={0.01} onChange={(n) => patch({ kellyFraction: n })} />
        <Field label="Min edge" value={settings.minEdge} step={0.01} onChange={(n) => patch({ minEdge: n })} />
        <Field label="Max pos %" value={settings.maxPosPct} step={0.01} onChange={(n) => patch({ maxPosPct: n })} />
      </div>
      <Button variant="ghost" className="mt-3 w-full" onClick={resetBook}>
        Clear fills
      </Button>
    </div>
  );
}

function Field({ label, value, onChange, step = 1 }: { label: string; value: number; onChange: (n: number) => void; step?: number }) {
  return (
    <div className="flex flex-col gap-1">
      <Label>{label}</Label>
      <Input
        type="number"
        step={step}
        value={value}
        className="h-11 font-mono tabular"
        onChange={(e) => onChange(Number(e.target.value))}
      />
    </div>
  );
}

function SignalsCard({
  signals,
  onPick,
  onTrade,
}: {
  signals: Signal[];
  onPick: (eventId: string) => void;
  onTrade: (s: Signal) => void;
}) {
  return (
    <div className="rounded-xl bg-card shadow-[var(--shadow-border)]">
      <div className="px-4 py-3">
        <h2 className="text-sm font-medium">Live edges</h2>
        <p className="text-xs text-muted-foreground">Ensemble vs Polymarket YES/NO</p>
      </div>
      <ul className="max-h-80 overflow-auto">
        {signals.length === 0 ? (
          <li className="px-4 py-6 text-sm text-muted-foreground">No edges above the floor. Markets look tight.</li>
        ) : (
          signals.slice(0, 12).map((s) => (
            <li key={s.id} className="border-t border-border px-4 py-3">
              <button type="button" className="block w-full text-left" onClick={() => onPick(s.eventId)}>
                <div className="flex items-center justify-between gap-2">
                  <span className="truncate text-sm">{s.cityName}</span>
                  <span className="font-mono text-xs tabular text-signal">+{formatPct(s.edge)}</span>
                </div>
                <p className="mt-0.5 truncate text-xs text-muted-foreground">
                  {s.side} {s.label} · mkt {formatPct(s.marketP)} · model {formatPct(s.modelP)}
                </p>
              </button>
              <Button variant="outline" size="sm" className="mt-2" onClick={() => onTrade(s)}>
                Paper {s.side}
              </Button>
            </li>
          ))
        )}
      </ul>
    </div>
  );
}

function FillsCard() {
  const fills = useDeskStore((s) => s.fills);
  return (
    <div className="rounded-xl bg-card shadow-[var(--shadow-border)]">
      <div className="px-4 py-3">
        <h2 className="text-sm font-medium">Fills</h2>
      </div>
      <ul className="max-h-64 overflow-auto">
        {fills.length === 0 ? (
          <li className="px-4 py-6 text-sm text-muted-foreground">No paper fills yet. Arm the bot or take a bucket.</li>
        ) : (
          fills.slice(0, 16).map((f) => (
            <li key={f.id} className="flex items-center justify-between gap-2 border-t border-border px-4 py-2.5 text-sm">
              <div className="min-w-0">
                <p className="truncate">
                  {f.side} {f.cityName}
                </p>
                <p className="truncate text-xs text-muted-foreground">{f.question.replace(/^Will the /, "")}</p>
              </div>
              <div className="text-right font-mono text-xs tabular">
                <p>{formatUsd(f.cost, 0)}</p>
                <p className={f.status === "won" ? "text-signal" : f.status === "lost" ? "text-danger" : "text-muted-foreground"}>
                  {f.status}
                </p>
              </div>
            </li>
          ))
        )}
      </ul>
    </div>
  );
}
