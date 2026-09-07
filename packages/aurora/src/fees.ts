/**
 * Aurora's fee split (https://docs.intents.aurora.dev/getting-started/api-keys-and-fees). The
 * integrator fee is set per API key in the Client Portal, at most 500 bps. The integrator keeps 60%
 * of it; Aurora takes 40%, but never less than its floor: 2 bps on stablecoin swaps, 10 bps on
 * others. Fees accrue per swap and can be collected in one asset (Fees Collection, configured by
 * Aurora, paid out at a $1,000 threshold by default).
 */

export const MAX_INTEGRATOR_FEE_BPS = 500;

export interface FeeSplit {
  /** What the integrator (Trendr) earns. */
  integratorBps: number;
  /** What Aurora takes. */
  auroraBps: number;
  /** What the user pays in total. */
  totalBps: number;
}

export function feeSplit(integratorFeeBps: number, kind: "stable" | "non-stable"): FeeSplit {
  if (!Number.isFinite(integratorFeeBps) || integratorFeeBps < 0 || integratorFeeBps > MAX_INTEGRATOR_FEE_BPS) {
    throw new Error(`integrator fee must be 0 to ${MAX_INTEGRATOR_FEE_BPS} bps`);
  }
  const floor = kind === "stable" ? 2 : 10;
  const integratorBps = (integratorFeeBps * 6) / 10;
  const auroraBps = Math.max(floor, (integratorFeeBps * 4) / 10);
  return { integratorBps, auroraBps, totalBps: integratorBps + auroraBps };
}
