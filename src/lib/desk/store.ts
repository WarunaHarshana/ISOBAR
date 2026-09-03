import { create } from "zustand";
import { persist } from "zustand/middleware";
import type { PaperFill } from "./types";

/** Client UI preference only — paper book / Arm live on the server. */
type DeskState = {
  selectedEventId: string | null;
  setSelected: (id: string | null) => void;
};

export const useDeskStore = create<DeskState>()(
  persist(
    (set) => ({
      selectedEventId: null,
      setSelected: (id) => set({ selectedEventId: id }),
    }),
    {
      name: "isobar-desk",
      skipHydration: true,
      partialize: (s) => ({ selectedEventId: s.selectedEventId }),
    },
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
