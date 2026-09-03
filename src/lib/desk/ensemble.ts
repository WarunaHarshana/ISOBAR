/** Quant: need a real ensemble before any model edge is tradeable. */
export const MIN_ENSEMBLE_MEMBERS = 8;

export function ensembleOk(members: readonly number[]): boolean {
  return members.length >= MIN_ENSEMBLE_MEMBERS;
}
