import type { PaperFill } from "@/lib/desk/types";

/**
 * Per-city paper ledger, derived client-side from the paper book's fills.
 * Presentation only: main's paper API does not ship a `cities` field, so the
 * UI computes it here instead of changing desk/backend logic.
 * Open fills are marked to model (shares × modelP − cost); settled fills use payout − cost.
 */
export type CityLedgerRow = {
  cityId: string;
  cityName: string;
  open: number;
  won: number;
  lost: number;
  yes: number;
  no: number;
  cost: number;
  openCost: number;
  closedPnl: number;
  markPnl: number;
};

export function fillMarkPnl(fill: PaperFill): number {
  if (fill.status === "open") return fill.shares * fill.modelP - fill.cost;
  return fill.payout - fill.cost;
}

export function cityLedger(fills: PaperFill[]): CityLedgerRow[] {
  const byId = new Map<string, CityLedgerRow>();
  for (const f of fills) {
    const key = f.cityId || f.cityName || "unknown";
    let row = byId.get(key);
    if (!row) {
      row = {
        cityId: f.cityId || key,
        cityName: f.cityName || f.cityId || key,
        open: 0,
        won: 0,
        lost: 0,
        yes: 0,
        no: 0,
        cost: 0,
        openCost: 0,
        closedPnl: 0,
        markPnl: 0,
      };
      byId.set(key, row);
    }
    row.cost += f.cost;
    row.markPnl += fillMarkPnl(f);
    if (f.side === "YES") row.yes += 1;
    else row.no += 1;
    if (f.status === "open") {
      row.open += 1;
      row.openCost += f.cost;
    } else {
      if (f.status === "won") row.won += 1;
      else row.lost += 1;
      row.closedPnl += f.payout - f.cost;
    }
  }
  return [...byId.values()].sort((a, b) => b.closedPnl - a.closedPnl || b.markPnl - a.markPnl);
}
