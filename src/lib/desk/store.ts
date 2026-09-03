import { create } from "zustand";
import { persist } from "zustand/middleware";
import type { BotSettings, PaperFill, Signal } from "./types";

type DeskState = {
  settings: BotSettings;
  fills: PaperFill[];
  selectedEventId: string | null;
  setSelected: (id: string | null) => void;
  patchSettings: (patch: Partial<BotSettings>) => void;
  paperTrade: (signal: Signal, bankroll: number) => PaperFill | null;
  settle: (marketId: string, yesWon: boolean) => void;
  resetBook: () => void;
};

const defaults: BotSettings = {
  bankroll: 10_000,
  kellyFraction: 0.12,
  minEdge: 0.06,
  minPrice: 0.05,
  maxPrice: 0.85,
  maxPosPct: 0.08,
  armed: false,
};

export const useDeskStore = create<DeskState>()(
  persist(
    (set, get) => ({
      settings: defaults,
      fills: [],
      selectedEventId: null,
      setSelected: (id) => set({ selectedEventId: id }),
      patchSettings: (patch) =>
        set((s) => ({ settings: { ...s.settings, ...patch } })),
      paperTrade: (signal, bankroll) => {
        const { settings, fills } = get();
        if (fills.some((f) => f.marketId === signal.marketId && f.side === signal.side && f.status === "open")) {
          return null;
        }
        if (signal.edge < settings.minEdge) return null;
        if (signal.marketP < settings.minPrice || signal.marketP > settings.maxPrice) return null;
        const f = signal.kelly * settings.kellyFraction;
        const cap = settings.maxPosPct;
        const stake = Math.max(5, Math.min(bankroll * Math.min(f, cap), bankroll * cap));
        const shares = stake / signal.marketP;
        const fill: PaperFill = {
          id: `${signal.marketId}-${signal.side}-${Date.now()}`,
          eventId: signal.eventId,
          marketId: signal.marketId,
          cityName: signal.cityName,
          question: signal.question,
          side: signal.side,
          price: signal.marketP,
          shares,
          cost: stake,
          modelP: signal.modelP,
          placedAt: new Date().toISOString(),
          status: "open",
          payout: 0,
        };
        set({ fills: [fill, ...fills].slice(0, 80) });
        return fill;
      },
      settle: (marketId, yesWon) =>
        set((s) => ({
          fills: s.fills.map((f) => {
            if (f.marketId !== marketId || f.status !== "open") return f;
            const won = f.side === "YES" ? yesWon : !yesWon;
            return {
              ...f,
              status: won ? "won" : "lost",
              payout: won ? f.shares : 0,
            };
          }),
        })),
      resetBook: () => set({ fills: [] }),
    }),
    { name: "isobar-desk", skipHydration: true },
  ),
);

export function realizedPnl(fills: PaperFill[]) {
  let closed = 0;
  let openCost = 0;
  for (const f of fills) {
    if (f.status === "open") openCost += f.cost;
    else closed += f.payout - f.cost;
  }
  return { closed, openCost };
}
