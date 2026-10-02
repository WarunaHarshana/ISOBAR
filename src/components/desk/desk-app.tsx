import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Activity,
  ArrowUpRight,
  BarChart3,
  CloudSun,
  Crosshair,
  Droplets,
  Globe,
  Maximize2,
  Minimize2,
  RefreshCw,
  ShieldAlert,
  Sparkles,
  Thermometer,
  Wallet,
  Wind,
  Zap,
} from "lucide-react";
import { toast } from "sonner";
import { Area, AreaChart, ResponsiveContainer, Tooltip as RTooltip, XAxis, YAxis } from "recharts";
import { fetchDeskSnapshot } from "@/lib/desk/server";
import {
  getPaperBookFn,
  manualPaperTradeFn,
  patchPaperSettingsFn,
  resetPaperBookFn,
} from "@/lib/desk/paper-api";
import { useDeskStore } from "@/lib/desk/store";
import { weatherLabel } from "@/lib/desk/parse";
import type { BotSettings, DeskEvent, DeskSnapshot, MarketBucket, Signal, WeatherNow } from "@/lib/desk/types";
import { cn, convertTemp, formatPct, formatTemp, formatUsd } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Skeleton } from "@/components/ui/skeleton";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

const PAPER_BOOK_KEY = ["paper-book"] as const;

const fallbackSettings: BotSettings = {
  bankroll: 10_000,
  kellyFraction: 0.12,
  minEdge: 0.06,
  minPrice: 0.05,
  maxPrice: 0.85,
  maxPosPct: 0.08,
  armed: false,
};

function usePaperBookQuery() {
  return useQuery({
    queryKey: PAPER_BOOK_KEY,
    queryFn: () => getPaperBookFn(),
    refetchInterval: 25_000,
    staleTime: 5_000,
  });
}

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
  const queryClient = useQueryClient();
  const query = useQuery({
    queryKey: ["desk"],
    queryFn: () => fetchDeskSnapshot(),
    initialData: initial,
    refetchInterval: 25_000,
    staleTime: 12_000,
  });
  const paper = usePaperBookQuery();
  const snapshot = query.data ?? initial;
  const selectedId = useDeskStore((s) => s.selectedEventId);
  const setSelected = useDeskStore((s) => s.setSelected);

  const [isExpanded, setIsExpanded] = useState(false);

  const pnl = paper.data?.pnl ?? { closed: 0, openCost: 0 };
  const equity = paper.data?.equity ?? fallbackSettings.bankroll + pnl.closed;

  const selected =
    snapshot.events.find((e) => e.eventId === selectedId) ?? snapshot.events[0] ?? null;

  useEffect(() => {
    void useDeskStore.persist.rehydrate();
  }, []);

  useEffect(() => {
    if (!selectedId && snapshot.events[0]) setSelected(snapshot.events[0].eventId);
  }, [selectedId, snapshot.events, setSelected]);

  const toastedTick = useRef<string | null>(null);
  useEffect(() => {
    const at = paper.data?.book.lastTickAt;
    const n = paper.data?.worker.filledLastTick ?? 0;
    if (!at || n <= 0 || toastedTick.current === at) return;
    toastedTick.current = at;
    toast.message(`Bot filled ${n} paper order${n === 1 ? "" : "s"}`);
  }, [paper.data?.book.lastTickAt, paper.data?.worker.filledLastTick]);

  const onTrade = async (s: Signal) => {
    try {
      const res = await manualPaperTradeFn({ data: s });
      queryClient.setQueryData(PAPER_BOOK_KEY, res);
      if (res.fill) {
        toast.success(`Paper ${s.side} ${s.label}`);
      } else {
        const reason = res.worker.liveLocked || res.book.lastError;
        toast.message(reason ? String(reason) : "No fill (caps or filters)");
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Paper trade failed");
    }
  };

  const wx = selected ? snapshot.weather[selected.cityId] : undefined;

  return (
    <div className="min-h-dvh bg-background text-foreground antialiased selection:bg-apple-blue/30 selection:text-white">
      <Header
        snapshot={snapshot}
        fetching={query.isFetching}
        onRefresh={() => query.refetch()}
        equity={equity}
        pnl={pnl.closed}
      />
      <main className="mx-auto max-w-[1440px] px-3 pb-16 sm:px-6">
        {snapshot.warning ? (
          <div className="mt-4 flex items-center gap-2.5 rounded-2xl bg-warn/15 border border-warn/25 px-4 py-3 text-xs sm:text-sm text-warn backdrop-blur-md">
            <span className="size-2 rounded-full bg-warn shrink-0 animate-pulse" />
            <p>{snapshot.warning}</p>
          </div>
        ) : null}
        <StatsRow snapshot={snapshot} equity={equity} openCost={pnl.openCost} />
        
        {/* Main 3-Column Desk Grid with wider right sidebar */}
        <div className={cn(
          "mt-6 hidden gap-5 lg:grid transition-all duration-300",
          isExpanded
            ? "lg:grid-cols-[270px_minmax(0,1fr)_340px]"
            : "lg:grid-cols-[270px_minmax(0,1fr)_380px] xl:grid-cols-[290px_minmax(0,1fr)_420px]"
        )}>
          <CityRail events={snapshot.events} selectedId={selected?.eventId} onSelect={setSelected} weather={snapshot.weather} />
          <Board event={selected} weather={wx} onTrade={onTrade} />
          <aside className="flex flex-col gap-5">
            <BotCard />
            <ActivityConsole
              signals={snapshot.signals}
              onPick={setSelected}
              onTrade={onTrade}
              isExpanded={isExpanded}
              onToggleExpand={() => setIsExpanded((v) => !v)}
            />
          </aside>
        </div>

        {/* Expanded 3-Column Activity Desk Section */}
        {isExpanded ? (
          <section className="mt-8 pt-6 border-t border-white/[0.08] animate-in fade-in-50 duration-300">
            <div className="flex items-center justify-between mb-5 px-1">
              <div>
                <h2 className="text-xl font-semibold tracking-[-0.02em] text-white flex items-center gap-2">
                  <Activity className="size-5 text-apple-cyan" />
                  <span>Desk Activity Monitor</span>
                </h2>
                <p className="text-xs text-white/50 mt-0.5">
                  Panoramic view: live market opportunities, mark-to-market exposure, and order book fills
                </p>
              </div>
              <Button
                variant="secondary"
                size="sm"
                onClick={() => setIsExpanded(false)}
                className="rounded-full gap-1.5 text-xs text-white/80 hover:text-white"
              >
                <Minimize2 className="size-3.5" />
                <span>Collapse to Sidebar</span>
              </Button>
            </div>
            <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-5">
              <SignalsCard signals={snapshot.signals} onPick={setSelected} onTrade={onTrade} isExpanded />
              <CityLedgerCard isExpanded />
              <FillsCard isExpanded />
            </div>
          </section>
        ) : null}

        {/* Mobile View */}
        <div className="mt-6 lg:hidden">
          <Tabs defaultValue="board">
            <TabsList className="w-full h-11 p-1 bg-white/[0.06] rounded-2xl border border-white/[0.08] backdrop-blur-md">
              <TabsTrigger value="markets" className="rounded-xl text-xs sm:text-sm font-medium">Markets</TabsTrigger>
              <TabsTrigger value="board" className="rounded-xl text-xs sm:text-sm font-medium">Board</TabsTrigger>
              <TabsTrigger value="activity" className="rounded-xl text-xs sm:text-sm font-medium">Activity</TabsTrigger>
              <TabsTrigger value="bot" className="rounded-xl text-xs sm:text-sm font-medium">Bot</TabsTrigger>
            </TabsList>
            <TabsContent value="markets" className="mt-4">
              <CityRail events={snapshot.events} selectedId={selected?.eventId} onSelect={setSelected} weather={snapshot.weather} />
            </TabsContent>
            <TabsContent value="board" className="mt-4">
              <Board event={selected} weather={wx} onTrade={onTrade} />
            </TabsContent>
            <TabsContent value="activity" className="mt-4">
              <ActivityConsole
                signals={snapshot.signals}
                onPick={setSelected}
                onTrade={onTrade}
                isExpanded={false}
                onToggleExpand={() => {}}
              />
            </TabsContent>
            <TabsContent value="bot" className="mt-4 flex flex-col gap-4">
              <BotCard />
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
  const paper = usePaperBookQuery();
  const armed = paper.data?.book.settings.armed ?? false;
  useEffect(() => {
    const tick = () => setClock(new Date().toISOString().slice(11, 19) + "Z");
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, []);

  return (
    <header className="sticky top-0 z-30 glass-panel rounded-none border-b border-white/[0.06] !bg-[#08090c]/70 !backdrop-blur-2xl transition-colors duration-200">
      <div className="mx-auto flex max-w-[1440px] items-center justify-between gap-3 px-4 py-3 sm:px-6">
        <div className="flex items-center gap-3">
          <div className="flex size-10 items-center justify-center rounded-2xl bg-gradient-to-b from-[#0a84ff] to-[#0055b3] text-white shadow-[0_4px_16px_rgba(10,132,255,0.4)] ring-1 ring-white/20 select-none">
            <CloudSun className="size-5" strokeWidth={2} />
          </div>
          <div>
            <div className="flex items-center gap-2">
              <p className="font-sans text-[15px] font-semibold tracking-[-0.025em] text-white">ISOBAR</p>
              <span className="hidden sm:inline-block px-1.5 py-0.5 rounded-full text-[10px] font-medium tracking-wide bg-white/[0.08] text-white/60 border border-white/[0.08]">DESK</span>
            </div>
            <p className="text-[11px] font-normal tracking-normal text-[#86868b]">Polymarket weather probability engine</p>
          </div>
        </div>
        <div className="flex items-center gap-2.5 sm:gap-3">
          {armed ? (
            <div className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-semibold bg-[#30d158]/15 text-[#30d158] border border-[#30d158]/30 shadow-[0_0_12px_rgba(48,209,88,0.2)]">
              <span className="size-2 rounded-full bg-[#30d158] animate-pulse" />
              <span>Bot armed</span>
            </div>
          ) : (
            <div className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-medium bg-white/[0.06] text-white/70 border border-white/[0.1]">
              <span className="size-2 rounded-full bg-white/40" />
              <span>Paper only</span>
            </div>
          )}
          <div className="hidden sm:flex items-center gap-2.5 rounded-full bg-white/[0.05] border border-white/[0.08] px-3.5 py-1 backdrop-blur-md">
            <span className="font-mono text-xs tabular text-white/50">{clock || "—"}</span>
            <span className="h-3 w-px bg-white/10" />
            <div className="flex items-center gap-1.5 font-mono text-xs tabular">
              <span className="font-semibold text-white">{formatUsd(equity, 0)}</span>
              <span className={cn("text-[11px]", pnl >= 0 ? "text-signal font-semibold" : "text-danger font-semibold")}>
                {pnl >= 0 ? "+" : ""}
                {formatUsd(pnl, 0)}
              </span>
            </div>
          </div>
          <Button
            variant="secondary"
            size="icon"
            onClick={onRefresh}
            aria-label="Refresh"
            className="size-9 sm:size-10 rounded-full border border-white/[0.12] bg-white/[0.06] hover:bg-white/[0.12] active:scale-95 transition-all text-white"
          >
            <RefreshCw className={cn("size-4", fetching && "animate-spin text-apple-cyan")} />
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
    { k: "Markets", v: String(snapshot.totals.events), icon: Activity, tint: "text-[#0a84ff]", bg: "bg-[#0a84ff]/10" },
    { k: "Cities", v: String(snapshot.totals.cities), icon: Globe, tint: "text-[#64d2ff]", bg: "bg-[#64d2ff]/10" },
    { k: "24h volume", v: formatUsd(snapshot.totals.volume24hr, 0), icon: BarChart3, tint: "text-[#bf5af2]", bg: "bg-[#bf5af2]/10" },
    { k: "Live Edges", v: String(snapshot.totals.openSignals), icon: Zap, tint: "text-[#30d158]", bg: "bg-[#30d158]/10" },
    { k: "Equity", v: formatUsd(equity, 0), icon: Wallet, tint: "text-[#30d158]", bg: "bg-[#30d158]/10" },
    { k: "Open risk", v: formatUsd(openCost, 0), icon: ShieldAlert, tint: "text-[#ff9f0a]", bg: "bg-[#ff9f0a]/10" },
  ];
  return (
    <section className="mt-5 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
      {items.map((it) => {
        const Icon = it.icon;
        return (
          <div
            key={it.k}
            className="rounded-2xl glass-card-hover p-4 overflow-hidden group select-none"
          >
            <div className="flex items-center justify-between gap-1">
              <span className="text-[10px] font-semibold tracking-[0.06em] text-white/50 uppercase truncate">
                {it.k}
              </span>
              <span className={cn("size-6 rounded-lg flex items-center justify-center shrink-0", it.bg, it.tint)}>
                <Icon className="size-3.5" />
              </span>
            </div>
            <p className="mt-2 font-mono text-xl sm:text-2xl font-semibold tabular tracking-[-0.03em] text-[#f5f5f7]">
              {it.v}
            </p>
          </div>
        );
      })}
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
    <div className="flex flex-col h-[min(72vh,740px)] rounded-3xl glass-card overflow-hidden">
      <div className="flex items-center justify-between px-4 py-3 border-b border-white/[0.08] bg-white/[0.02]">
        <div className="flex items-center gap-2">
          <Globe className="size-4 text-[#0a84ff]" />
          <h2 className="text-xs font-semibold tracking-[-0.01em] text-white">Weather Markets</h2>
        </div>
        <span className="px-2 py-0.5 rounded-full text-[10px] font-mono text-white/50 bg-white/[0.06] border border-white/[0.08]">
          {events.length}
        </span>
      </div>
      <ScrollArea className="flex-1">
        <ul className="p-2 space-y-1">
          {events.map((ev) => {
            const w = weather[ev.cityId];
            const active = ev.eventId === selectedId;
            const hasSignal = Boolean(ev.bestSignal && ev.bestSignal.edge > 0.02);
            return (
              <li key={ev.eventId}>
                <button
                  type="button"
                  onClick={() => onSelect(ev.eventId)}
                  className={cn(
                    "flex w-full items-center gap-3 rounded-2xl px-3.5 py-3 text-left transition-all duration-200 ease-[cubic-bezier(0.16,1,0.3,1)] tap-tactile",
                    active
                      ? "bg-white/[0.14] text-white border border-white/[0.16] shadow-[0_4px_20px_rgba(0,0,0,0.35)]"
                      : "hover:bg-white/[0.06] text-white/70 hover:text-white border border-transparent",
                  )}
                >
                  <div className="min-w-0 flex-1">
                    <div className="flex items-baseline justify-between gap-2">
                      <span className="truncate text-sm font-semibold tracking-[-0.01em]">{ev.cityName}</span>
                      <span className="font-mono text-[11px] tabular text-white/40">{fmtDate(ev.eventDate)}</span>
                    </div>
                    <div className="mt-1.5 flex items-center justify-between text-[11px]">
                      <div className="flex items-center gap-2 font-mono tabular text-white/60">
                        <span className="text-[10px] px-1.5 py-0.5 rounded bg-white/[0.06] uppercase tracking-wider">
                          {ev.kind === "high" ? "High" : "Low"}
                        </span>
                        <span className="font-medium text-white/80">
                          {formatTemp(w?.tempC != null ? convertTemp(w.tempC, ev.unit) : null, ev.unit)}
                        </span>
                      </div>
                      {hasSignal ? (
                        <span className="px-2 py-0.5 rounded-full text-[10px] font-semibold font-mono bg-[#30d158]/15 text-[#30d158] border border-[#30d158]/30">
                          +{formatPct(ev.bestSignal!.edge)}
                        </span>
                      ) : null}
                    </div>
                  </div>
                </button>
              </li>
            );
          })}
        </ul>
      </ScrollArea>
    </div>
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
      <div className="rounded-3xl glass-card p-12 text-center text-sm text-white/50">
        <CloudSun className="size-10 mx-auto mb-3 text-white/30" />
        <p className="font-medium text-white/70">No live temperature markets selected.</p>
        <p className="text-xs text-white/40 mt-1">Pick a city market from the list to view probability distributions.</p>
      </div>
    );
  }
  const unit = event.unit;
  const nowTemp = weather?.tempC != null ? convertTemp(weather.tempC, unit) : null;

  return (
    <section className="flex flex-col gap-5">
      <div className="rounded-3xl glass-card p-5 sm:p-7 overflow-hidden select-none">
        {/* Apple Weather ambient atmosphere glow */}
        <div className="absolute -top-32 -right-32 size-80 rounded-full bg-apple-blue/15 blur-3xl pointer-events-none" />
        <div className="absolute -bottom-32 -left-32 size-80 rounded-full bg-apple-cyan/10 blur-3xl pointer-events-none" />

        <div className="relative flex flex-wrap items-start justify-between gap-4">
          <div>
            <div className="inline-flex items-center gap-1.5 px-3 py-0.5 rounded-full text-[11px] font-semibold tracking-wide uppercase bg-apple-blue/15 text-apple-cyan border border-apple-blue/25">
              <span>{event.kind === "high" ? "Daily high market" : "Daily low market"}</span>
              <span>·</span>
              <span>{fmtDate(event.eventDate)}</span>
            </div>
            <h1 className="mt-2 text-3xl sm:text-4xl font-semibold tracking-[-0.03em] text-white">{event.cityName}</h1>
            <p className="mt-1.5 text-sm text-white/60 flex items-center gap-2">
              <CloudSun className="size-4 text-apple-cyan shrink-0" />
              <span>{weatherLabel(weather?.weatherCode ?? null, weather?.cover ?? null)}</span>
              {weather?.station ? <span className="text-white/40">· {weather.station}</span> : null}
            </p>
          </div>
          <a
            href={`https://polymarket.com/event/${event.slug}`}
            target="_blank"
            rel="noreferrer"
            className="inline-flex h-9 items-center gap-1.5 rounded-full px-4 text-xs font-semibold bg-white/[0.08] hover:bg-white/[0.14] border border-white/[0.12] text-white active:scale-95 transition-all shadow-sm"
          >
            <span>Polymarket</span>
            <ArrowUpRight className="size-3.5 text-white/60" />
          </a>
        </div>

        <div className="relative mt-6 grid grid-cols-2 gap-3 sm:grid-cols-4">
          <Metric icon={Thermometer} label="Now" value={formatTemp(nowTemp, unit)} />
          <Metric icon={Activity} label={event.kind === "low" ? "Model low" : "Model high"} value={event.modelHigh != null ? `${event.modelHigh.toFixed(1)}°${unit}` : "—"} />
          <Metric icon={Crosshair} label="Implied" value={event.implied != null ? `${event.implied.toFixed(1)}°${unit}` : "—"} />
          <Metric icon={CloudSun} label={event.kind === "low" ? "Observed min" : "Observed max"} value={event.observed != null ? `${event.observed.toFixed(1)}°${unit}` : "—"} />
        </div>

        <div className="relative mt-5 flex flex-wrap items-center gap-2.5 text-xs text-white/60">
          <div className="inline-flex items-center gap-1.5 rounded-full bg-white/[0.05] border border-white/[0.08] px-3 py-1">
            <Droplets className="size-3.5 text-apple-cyan" />
            <span>Humidity {weather?.humidity != null ? `${Math.round(weather.humidity)}%` : "—"}</span>
          </div>
          <div className="inline-flex items-center gap-1.5 rounded-full bg-white/[0.05] border border-white/[0.08] px-3 py-1">
            <Wind className="size-3.5 text-apple-blue" />
            <span>Wind {weather?.windMs != null ? `${weather.windMs.toFixed(1)} m/s` : "—"}</span>
          </div>
          {weather?.source ? (
            <div className="inline-flex items-center gap-1.5 rounded-full bg-white/[0.05] border border-white/[0.08] px-3 py-1 text-white/50 font-mono text-[11px] truncate max-w-full">
              <span>{weather.source}</span>
            </div>
          ) : null}
        </div>

        {event.kind === "low" ? (
          event.lowEnsemble ? (
            <p className="relative mt-3 font-mono text-[11px] tabular text-white/40">
              {event.lowEnsemble.members > 0 ? (
                <>
                  Ensemble {event.lowEnsemble.members} daily-min members
                  {event.lowEnsemble.stdC != null ? ` · σ ${event.lowEnsemble.stdC.toFixed(2)}°C` : ""}
                  {event.lowEnsemble.minC != null && event.lowEnsemble.maxC != null
                    ? ` · range ${event.lowEnsemble.minC.toFixed(1)}–${event.lowEnsemble.maxC.toFixed(1)}°C`
                    : ""}
                  {event.lowEnsemble.source ? ` · ${event.lowEnsemble.source}` : ""}
                </>
              ) : (
                <>Daily-min ensemble unavailable for {event.eventDate}</>
              )}
              {weather?.observedAt ? ` · obs ${fmtTime(weather.observedAt)}` : ""}
            </p>
          ) : null
        ) : weather?.modelStdC != null ? (
          <p className="relative mt-3 font-mono text-[11px] tabular text-white/40">
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
    <div className="rounded-2xl bg-white/[0.04] border border-white/[0.08] p-3.5 glass-inset transition-all duration-300 ease-[cubic-bezier(0.16,1,0.3,1)] hover:bg-white/[0.07] hover:border-white/[0.14] hover:-translate-y-0.5">
      <p className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wider text-white/50">
        <Icon className="size-3.5 text-apple-cyan" /> {label}
      </p>
      <p className="mt-1.5 font-mono text-xl sm:text-2xl font-semibold tabular tracking-[-0.03em] text-[#f5f5f7]">{value}</p>
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
    <div className="mt-6 rounded-2xl bg-white/[0.03] p-4 border border-white/[0.06] glass-inset">
      <div className="flex items-center justify-between mb-3 px-1">
        <p className="text-[11px] font-semibold tracking-wider uppercase text-white/50">24-Hour Forecast Curve</p>
        <span className="text-[11px] font-mono text-white/40">Hourly resolution</span>
      </div>
      <div className="h-44">
        {mounted ? (
          <ResponsiveContainer width="100%" height="100%">
            <AreaChart data={data} margin={{ top: 10, right: 12, left: -10, bottom: 0 }}>
              <defs>
                <linearGradient id="appleTempGrad" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="#0a84ff" stopOpacity={0.35} />
                  <stop offset="60%" stopColor="#64d2ff" stopOpacity={0.12} />
                  <stop offset="100%" stopColor="#64d2ff" stopOpacity={0.0} />
                </linearGradient>
              </defs>
              <XAxis dataKey="t" tick={{ fill: "#86868b", fontSize: 10 }} interval={3} axisLine={false} tickLine={false} />
              <YAxis
                domain={["dataMin - 1", "dataMax + 1"]}
                tick={{ fill: "#86868b", fontSize: 10 }}
                axisLine={false}
                tickLine={false}
                width={36}
              />
              <RTooltip
                contentStyle={{
                  background: "rgba(22, 25, 32, 0.9)",
                  backdropFilter: "blur(20px)",
                  WebkitBackdropFilter: "blur(20px)",
                  border: "1px solid rgba(255, 255, 255, 0.12)",
                  borderRadius: 14,
                  fontSize: 12,
                  boxShadow: "0 8px 32px rgba(0,0,0,0.45)",
                }}
                formatter={(v) => [`${Number(v).toFixed(1)}°${unit}`, "Temp"]}
              />
              <Area
                type="monotone"
                dataKey="v"
                stroke="#64d2ff"
                fill="url(#appleTempGrad)"
                strokeWidth={2}
                dot={false}
                activeDot={{ r: 5, fill: "#ffffff", stroke: "#0a84ff", strokeWidth: 2 }}
              />
            </AreaChart>
          </ResponsiveContainer>
        ) : (
          <Skeleton className="h-full w-full rounded-2xl" />
        )}
      </div>
    </div>
  );
}

function BucketTable({ event, onTrade }: { event: DeskEvent; onTrade: (s: Signal) => void }) {
  return (
    <div className="overflow-hidden rounded-3xl glass-card select-none">
      <div className="flex items-center justify-between px-5 py-4 bg-white/[0.02]">
        <div>
          <h2 className="text-sm font-semibold tracking-[-0.01em] text-white">Temperature Buckets</h2>
          <p className="text-xs text-white/50 mt-0.5">Model probability distribution vs Polymarket order book</p>
        </div>
        <div className="flex items-center gap-2 text-xs text-white/50 font-mono">
          <span className="flex items-center gap-1.5"><span className="size-2 rounded-full bg-apple-cyan" /> Market</span>
          <span className="flex items-center gap-1.5"><span className="size-2 rounded-full bg-signal" /> Model</span>
        </div>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[640px] text-left text-sm">
          <thead className="text-[10px] tracking-[0.06em] text-white/50 uppercase font-semibold border-y border-white/[0.08] bg-white/[0.02]">
            <tr>
              <th className="px-5 py-3 font-semibold">Bucket range</th>
              <th className="px-3 py-3 font-semibold">Market P</th>
              <th className="px-3 py-3 font-semibold">Model P</th>
              <th className="px-3 py-3 font-semibold">Edge</th>
              <th className="px-3 py-3 font-semibold">Probability Bar</th>
              <th className="px-5 py-3 font-semibold text-right">Paper Action</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-white/[0.05]">
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
  const isActionable = showEdge >= 0.03 && signal.marketP >= 0.04 && signal.marketP <= 0.9;

  return (
    <tr className="hover:bg-white/[0.04] transition-colors group">
      <td className="px-5 py-3.5 font-semibold text-white tracking-[-0.01em]">{bucket.label}</td>
      <td className="px-3 py-3.5 font-mono text-xs tabular text-white/70">{formatPct(bucket.yesPrice)}</td>
      <td className="px-3 py-3.5 font-mono text-xs tabular font-medium text-white">{formatPct(bucket.modelP)}</td>
      <td className={cn("px-3 py-3.5 font-mono text-xs tabular font-semibold", edge > 0.03 ? "text-signal" : edge < -0.03 ? "text-danger" : "text-white/40")}>
        {edge >= 0 ? "+" : ""}
        {formatPct(edge)}
      </td>
      <td className="px-3 py-3.5">
        <div className="flex h-2.5 w-32 overflow-hidden rounded-full bg-white/[0.08] p-0.5 border border-white/[0.06]">
          <div
            className="h-full rounded-full bg-apple-cyan transition-all"
            style={{ width: `${Math.min(100, Math.max(4, bucket.yesPrice * 100))}%` }}
          />
          <div
            className="h-full rounded-full bg-signal transition-all ml-0.5"
            style={{ width: `${Math.min(100, Math.max(4, bucket.modelP * 100))}%` }}
          />
        </div>
      </td>
      <td className="px-5 py-3.5 text-right">
        <Button
          variant={isActionable ? "signal" : "secondary"}
          size="sm"
          disabled={!isActionable}
          onClick={() => onTrade(signal)}
          className={cn(
            "rounded-full h-8 px-3.5 text-xs font-semibold active:scale-95 transition-all",
            !isActionable && "opacity-40"
          )}
        >
          {side} {formatPct(signal.marketP, 0)}
        </Button>
      </td>
    </tr>
  );
}

function BotCard() {
  const queryClient = useQueryClient();
  const paper = usePaperBookQuery();
  const settings = paper.data?.book.settings ?? fallbackSettings;
  const liveLocked = paper.data?.worker.liveLocked;

  async function patch(partial: Partial<BotSettings>) {
    try {
      const res = await patchPaperSettingsFn({ data: partial });
      queryClient.setQueryData(PAPER_BOOK_KEY, res);
      if (partial.armed === true && !res.book.settings.armed) {
        toast.error(res.worker.liveLocked || res.book.lastError || "Could not arm");
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Settings update failed");
    }
  }

  async function onReset() {
    try {
      const res = await resetPaperBookFn();
      queryClient.setQueryData(PAPER_BOOK_KEY, res);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not clear fills");
    }
  }

  return (
    <div className="rounded-3xl glass-card p-5 select-none">
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2.5">
          <div className="size-8 rounded-xl bg-apple-blue/15 text-apple-cyan flex items-center justify-center border border-apple-blue/25">
            <Zap className="size-4" />
          </div>
          <div>
            <h2 className="text-sm font-semibold tracking-[-0.01em] text-white">Paper Bot</h2>
            <p className="text-[11px] text-white/50">Kelly-sized order execution</p>
          </div>
        </div>
        <div className="flex items-center gap-2.5 rounded-full bg-white/[0.04] border border-white/[0.08] px-3 py-1">
          <Label htmlFor="arm" className="text-xs font-medium text-white/70 cursor-pointer">Arm</Label>
          <Switch id="arm" checked={settings.armed} onCheckedChange={(v) => void patch({ armed: v })} />
        </div>
      </div>
      {typeof liveLocked === "string" && liveLocked ? (
        <div className="mt-3 flex items-center gap-2 rounded-xl bg-warn/15 border border-warn/25 px-3 py-2 text-xs text-warn">
          <span className="size-1.5 rounded-full bg-warn shrink-0" />
          <p className="truncate">{liveLocked}</p>
        </div>
      ) : null}
      <div className="my-4 h-px bg-white/[0.08]" />
      <div className="grid grid-cols-2 gap-2.5">
        <Field label="Bankroll" value={settings.bankroll} onChange={(n) => void patch({ bankroll: n })} />
        <Field label="Kelly frac" value={settings.kellyFraction} step={0.01} onChange={(n) => void patch({ kellyFraction: n })} />
        <Field label="Min edge" value={settings.minEdge} step={0.01} onChange={(n) => void patch({ minEdge: n })} />
        <Field label="Max pos %" value={settings.maxPosPct} step={0.01} onChange={(n) => void patch({ maxPosPct: n })} />
      </div>
      <Button
        variant="secondary"
        className="mt-4 w-full rounded-xl text-xs font-semibold text-white/70 hover:text-white border border-white/[0.08] bg-white/[0.04] hover:bg-white/[0.08] active:scale-[0.98] transition-all"
        onClick={() => void onReset()}
      >
        Reset paper fills
      </Button>
    </div>
  );
}

function Field({ label, value, onChange, step = 1 }: { label: string; value: number; onChange: (n: number) => void; step?: number }) {
  return (
    <div className="flex flex-col gap-1.5">
      <Label className="text-[11px] font-medium text-white/60 tracking-tight">{label}</Label>
      <Input
        type="number"
        step={step}
        value={value}
        className="h-10 rounded-xl font-mono tabular text-xs bg-white/[0.04] border-white/[0.08] text-white focus-visible:bg-white/[0.08]"
        onChange={(e) => onChange(Number(e.target.value))}
      />
    </div>
  );
}

function ActivityConsole({
  signals,
  onPick,
  onTrade,
  isExpanded,
  onToggleExpand,
}: {
  signals: Signal[];
  onPick: (eventId: string) => void;
  onTrade: (s: Signal) => void;
  isExpanded: boolean;
  onToggleExpand: () => void;
}) {
  const paper = usePaperBookQuery();
  const fills = paper.data?.book.fills ?? [];
  const rows = paper.data?.cities ?? [];
  const [tab, setTab] = useState<"edges" | "fills" | "ledger">("edges");

  return (
    <div className="rounded-3xl glass-card overflow-hidden select-none flex flex-col h-[580px] shadow-glass">
      <div className="flex items-center justify-between gap-2 px-3 py-2.5 border-b border-white/[0.08] bg-white/[0.02]">
        <Tabs value={tab} onValueChange={(v) => setTab(v as any)} className="w-full">
          <div className="flex items-center justify-between w-full gap-2">
            <TabsList className="h-9 p-0.5 bg-white/[0.05] rounded-xl border border-white/[0.08] flex-1">
              <TabsTrigger value="edges" className="rounded-lg text-xs py-1 px-2 font-medium flex items-center justify-center gap-1.5 flex-1">
                <Sparkles className="size-3.5 text-signal" />
                <span>Edges</span>
                <span className="px-1.5 py-0.2 rounded-full text-[10px] font-mono bg-signal/15 text-signal border border-signal/25">
                  {signals.length}
                </span>
              </TabsTrigger>
              <TabsTrigger value="fills" className="rounded-lg text-xs py-1 px-2 font-medium flex items-center justify-center gap-1.5 flex-1">
                <Wallet className="size-3.5 text-apple-cyan" />
                <span>Fills</span>
                {fills.length > 0 ? (
                  <span className="px-1.5 py-0.2 rounded-full text-[10px] font-mono bg-white/[0.1] text-white/70 border border-white/[0.08]">
                    {fills.length}
                  </span>
                ) : null}
              </TabsTrigger>
              <TabsTrigger value="ledger" className="rounded-lg text-xs py-1 px-2 font-medium flex items-center justify-center gap-1.5 flex-1">
                <Globe className="size-3.5 text-[#0a84ff]" />
                <span>Ledger</span>
              </TabsTrigger>
            </TabsList>
            <Button
              variant="ghost"
              size="icon-sm"
              onClick={onToggleExpand}
              className="size-9 rounded-xl text-white/50 hover:text-white hover:bg-white/[0.08] shrink-0 border border-white/[0.08]"
              title={isExpanded ? "Collapse 3-column desk" : "Expand 3-column desk"}
            >
              {isExpanded ? <Minimize2 className="size-3.5 text-apple-cyan" /> : <Maximize2 className="size-3.5" />}
            </Button>
          </div>
        </Tabs>
      </div>
      <div className="flex-1 min-h-0">
        {tab === "edges" ? (
          <ScrollArea className="h-full">
            <SignalsList signals={signals} onPick={onPick} onTrade={onTrade} />
          </ScrollArea>
        ) : tab === "fills" ? (
          <ScrollArea className="h-full">
            <FillsList fills={fills} />
          </ScrollArea>
        ) : (
          <ScrollArea className="h-full">
            <CityLedgerList rows={rows} />
          </ScrollArea>
        )}
      </div>
    </div>
  );
}

function SignalsCard({
  signals,
  onPick,
  onTrade,
  isExpanded = false,
}: {
  signals: Signal[];
  onPick: (eventId: string) => void;
  onTrade: (s: Signal) => void;
  isExpanded?: boolean;
}) {
  return (
    <div className={cn("rounded-3xl glass-card overflow-hidden select-none flex flex-col shadow-glass", isExpanded ? "h-[560px]" : "h-[500px]")}>
      <div className="flex items-center justify-between px-5 py-3.5 border-b border-white/[0.08] bg-white/[0.02]">
        <div className="flex items-center gap-2">
          <Sparkles className="size-4 text-signal" />
          <h2 className="text-sm font-semibold tracking-[-0.01em] text-white">Live Edges</h2>
        </div>
        <span className="px-2.5 py-0.5 rounded-full text-[11px] font-mono font-medium text-signal bg-signal/15 border border-signal/30">
          {signals.length} actionable
        </span>
      </div>
      <ScrollArea className="flex-1 min-h-0">
        <SignalsList signals={signals} onPick={onPick} onTrade={onTrade} isExpanded={isExpanded} />
      </ScrollArea>
    </div>
  );
}

function SignalsList({
  signals,
  onPick,
  onTrade,
  isExpanded = false,
}: {
  signals: Signal[];
  onPick: (eventId: string) => void;
  onTrade: (s: Signal) => void;
  isExpanded?: boolean;
}) {
  if (signals.length === 0) {
    return (
      <div className="p-8 text-center text-xs text-white/40">
        No edges above the floor. Markets look efficiently priced.
      </div>
    );
  }

  return (
    <ul className="p-2.5 space-y-1.5">
      {signals.map((s) => (
        <li
          key={s.id}
          className="p-3.5 hover:bg-white/[0.04] transition-all duration-150 rounded-2xl border border-white/[0.04] hover:border-white/[0.1] group"
        >
          <div className="flex items-start justify-between gap-3">
            <button type="button" className="text-left flex-1 min-w-0 tap-tactile" onClick={() => onPick(s.eventId)}>
              <div className="flex items-center gap-2 flex-wrap">
                <span className="text-[14px] font-semibold text-white tracking-[-0.01em] group-hover:text-apple-cyan transition-colors">
                  {s.cityName}
                </span>
                <span className="text-[10px] font-mono px-2 py-0.5 rounded-full bg-white/[0.06] text-white/50 border border-white/[0.06]">
                  {fmtDate(s.date)}
                </span>
                <span className="text-[10px] font-medium uppercase px-1.5 py-0.2 rounded bg-white/[0.04] text-white/40">
                  {s.kind}
                </span>
              </div>
              <p className="mt-1 text-xs text-white/80 font-mono">
                <span className={cn("font-bold", s.side === "YES" ? "text-apple-cyan" : "text-white/70")}>{s.side}</span>{" "}
                <span>{s.label}</span>
              </p>
              <div className="mt-1.5 flex items-center gap-3 text-[11px] font-mono tabular text-white/50">
                <span>Mkt <strong className="text-white/80">{formatPct(s.marketP)}</strong></span>
                <span>Model <strong className="text-white">{formatPct(s.modelP)}</strong></span>
                {s.kelly ? <span>Kelly <strong className="text-signal/90">{formatPct(s.kelly)}</strong></span> : null}
              </div>
            </button>
            <div className="flex flex-col items-end gap-2 shrink-0">
              <span className="font-mono text-xs tabular font-bold text-signal bg-signal/15 border border-signal/30 px-2.5 py-1 rounded-full shadow-[0_0_10px_rgba(48,209,88,0.15)]">
                +{formatPct(s.edge)}
              </span>
              <Button
                variant="signal"
                size="sm"
                className="rounded-full h-7.5 px-3 text-xs font-semibold shadow-sm active:scale-95"
                onClick={() => onTrade(s)}
              >
                Paper {s.side} {formatPct(s.marketP, 0)}
              </Button>
            </div>
          </div>
        </li>
      ))}
    </ul>
  );
}

function CityLedgerCard({ isExpanded = false }: { isExpanded?: boolean }) {
  const paper = usePaperBookQuery();
  const rows = paper.data?.cities ?? [];
  return (
    <div className={cn("rounded-3xl glass-card overflow-hidden select-none flex flex-col shadow-glass", isExpanded ? "h-[560px]" : "h-[500px]")}>
      <div className="flex items-center justify-between px-5 py-3.5 border-b border-white/[0.08] bg-white/[0.02]">
        <div className="flex items-center gap-2">
          <Globe className="size-4 text-apple-cyan" />
          <h2 className="text-sm font-semibold tracking-[-0.01em] text-white">City Ledger</h2>
        </div>
        <p className="text-[10px] text-white/40 font-mono">Mark-to-model</p>
      </div>
      <ScrollArea className="flex-1 min-h-0">
        <CityLedgerList rows={rows} isExpanded={isExpanded} />
      </ScrollArea>
    </div>
  );
}

function CityLedgerList({
  rows,
  isExpanded = false,
}: {
  rows: Array<{
    cityId: string;
    cityName: string;
    yes: number;
    no: number;
    open: number;
    won: number;
    lost: number;
    markPnl: number;
    closedPnl: number;
  }>;
  isExpanded?: boolean;
}) {
  if (rows.length === 0) {
    return <div className="p-8 text-center text-xs text-white/40">No city book yet. Fills will rank here.</div>;
  }

  return (
    <ul className="p-2.5 space-y-1.5">
      {rows.map((r) => {
        const settled = r.won + r.lost;
        const winRate = settled ? Math.round((r.won / settled) * 100) : 0;
        return (
          <li
            key={r.cityId}
            className="p-3.5 hover:bg-white/[0.04] transition-all duration-150 rounded-2xl border border-white/[0.04] hover:border-white/[0.1]"
          >
            <div className="flex items-center justify-between gap-3">
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <p className="font-semibold text-sm tracking-[-0.01em] text-white">{r.cityName}</p>
                  {r.open > 0 ? (
                    <span className="px-1.5 py-0.2 rounded-full text-[10px] font-mono bg-apple-blue/15 text-apple-cyan border border-apple-blue/25">
                      {r.open} open
                    </span>
                  ) : null}
                </div>
                <div className="flex items-center gap-2 mt-1 font-mono text-xs text-white/50 flex-wrap">
                  <span>{r.yes}Y · {r.no}N</span>
                  <span className="text-white/20">·</span>
                  <span>{r.won}W / {r.lost}L</span>
                  {settled ? (
                    <span
                      className={cn(
                        "px-1.5 py-0.2 rounded text-[10px] font-semibold",
                        winRate >= 50 ? "bg-signal/15 text-signal" : "bg-danger/15 text-danger"
                      )}
                    >
                      {winRate}%
                    </span>
                  ) : null}
                </div>
              </div>
              <div className="text-right font-mono text-xs tabular shrink-0">
                <p className={cn("font-bold text-sm", r.markPnl >= 0 ? "text-signal" : "text-danger")}>
                  {r.markPnl >= 0 ? "+" : ""}
                  {formatUsd(r.markPnl, 0)}
                </p>
                <p className="text-[11px] text-white/40 mt-0.5">closed {formatUsd(r.closedPnl, 0)}</p>
              </div>
            </div>
          </li>
        );
      })}
    </ul>
  );
}

function FillsCard({ isExpanded = false }: { isExpanded?: boolean }) {
  const paper = usePaperBookQuery();
  const fills = paper.data?.book.fills ?? [];
  return (
    <div className={cn("rounded-3xl glass-card overflow-hidden select-none flex flex-col shadow-glass", isExpanded ? "h-[560px]" : "h-[500px]")}>
      <div className="flex items-center justify-between px-5 py-3.5 border-b border-white/[0.08] bg-white/[0.02]">
        <div className="flex items-center gap-2">
          <Wallet className="size-4 text-white/70" />
          <h2 className="text-sm font-semibold tracking-[-0.01em] text-white">Recent Fills</h2>
        </div>
        <span className="px-2 py-0.5 rounded-full text-[10px] font-mono text-white/50 bg-white/[0.06] border border-white/[0.08]">
          {fills.length}
        </span>
      </div>
      <ScrollArea className="flex-1 min-h-0">
        <FillsList fills={fills} isExpanded={isExpanded} />
      </ScrollArea>
    </div>
  );
}

function FillsList({
  fills,
  isExpanded = false,
}: {
  fills: Array<{
    id: string;
    cityId: string;
    cityName: string;
    side: "YES" | "NO";
    question: string;
    cost: number;
    status: string;
    price?: number;
    shares?: number;
    filledAt?: string;
  }>;
  isExpanded?: boolean;
}) {
  if (fills.length === 0) {
    return (
      <div className="p-8 text-center text-xs text-white/40">
        No paper fills yet. Arm the bot or trade a bucket.
      </div>
    );
  }

  return (
    <ul className="p-2.5 space-y-1.5">
      {fills.slice(0, isExpanded ? 40 : 25).map((f) => (
        <li
          key={f.id}
          className="p-3.5 hover:bg-white/[0.04] transition-all duration-150 rounded-2xl border border-white/[0.04] hover:border-white/[0.1]"
        >
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2 flex-wrap">
                <span
                  className={cn(
                    "px-2 py-0.5 rounded-full text-[10px] font-bold font-mono uppercase",
                    f.side === "YES"
                      ? "bg-apple-cyan/15 text-apple-cyan border border-apple-cyan/30"
                      : "bg-white/[0.1] text-white/70 border border-white/[0.12]"
                  )}
                >
                  {f.side}
                </span>
                <p className="font-semibold text-sm tracking-[-0.01em] text-white">{f.cityName}</p>
                <span
                  className={cn(
                    "text-[10px] font-medium uppercase px-2 py-0.5 rounded-full ml-auto sm:ml-0",
                    f.status === "won"
                      ? "bg-signal/15 text-signal border border-signal/30"
                      : f.status === "lost"
                      ? "bg-danger/15 text-danger border border-danger/30"
                      : "bg-white/[0.06] text-white/60 border border-white/[0.08]"
                  )}
                >
                  {f.status}
                </span>
              </div>
              <p className="mt-1.5 text-xs text-white/70 line-clamp-2 leading-relaxed">
                {f.question.replace(/^Will the /, "")}
              </p>
              {f.filledAt ? (
                <p className="mt-1 text-[10px] font-mono text-white/40">
                  {fmtTime(f.filledAt)} {f.shares ? `· ${Math.round(f.shares)} shares @ ${formatPct(f.price ?? 0)}` : ""}
                </p>
              ) : null}
            </div>
            <div className="text-right font-mono text-xs tabular shrink-0 pt-0.5">
              <p className="font-semibold text-white text-sm">{formatUsd(f.cost, 0)}</p>
              <p className="text-[11px] text-white/40 mt-0.5">{f.shares ? `${Math.round(f.shares)} sh` : ""}</p>
            </div>
          </div>
        </li>
      ))}
    </ul>
  );
}
