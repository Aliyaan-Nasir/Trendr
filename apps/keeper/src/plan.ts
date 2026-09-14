import {
  attentionPerpAbi,
  bondingCurveAbi,
  type Deployment,
  outcomeListingAbi,
  outcomeMarketsAbi,
  trendRegistryAbi,
} from "@trendr/contracts";
import { type Address, encodeFunctionData, type Hex } from "viem";
import { Outcome, type Snapshot, Status } from "./snapshot";

export type ActionKind = "liquidate" | "settleRetired" | "graduate" | "settle" | "retire" | "openSeries" | "list" | "poke";

/** One transaction the keeper wants to send. */
export interface Action {
  /** Stable identity, so the same work is never sent twice concurrently. */
  key: string;
  kind: ActionKind;
  to: Address;
  data: Hex;
  /** Monad bills the gas limit, so every action carries a tight cap. */
  gasCap: bigint;
  reason: string;
}

export interface PlanConfig {
  seriesWindows: readonly number[];
  listWindows: readonly number[];
  /**
   * False where only Kuru may create markets (Mainnet): the graduation venue refuses to list, so
   * full curves wait (their holders can still sell back) instead of failing a graduate each scan.
   */
  graduate?: boolean;
}

/** Gas caps per action, with headroom over measured costs (openSeries 1.86M and list 2.5M on Testnet). */
export const GAS = {
  liquidate: 400_000n,
  settleRetired: 400_000n,
  graduate: 6_000_000n,
  settle: 200_000n,
  retire: 150_000n,
  openSeries: 3_000_000n,
  list: 4_000_000n,
  poke: 150_000n,
} as const satisfies Record<ActionKind, bigint>;

/** Retired positions settled per scan; the rest wait for the next scans (nothing is at risk there). */
export const MAX_RETIRED_SETTLEMENTS = 4;

/**
 * Decides what to send, from one snapshot, in priority order: protect solvency first
 * (liquidations, retired settlements), then pay out (graduations, settlements), then lifecycle,
 * then new markets, then funding marks. Pure, so it is tested without a chain.
 */
export function plan(s: Snapshot, d: Deployment, cfg: PlanConfig): Action[] {
  const actions: Action[] = [];
  const trendById = new Map(s.trends.map((t) => [t.id, t]));

  // Every liquidation before any retired settlement: a pile of small positions on a retired trend
  // must never push a liquidation past the per-scan action limit.
  for (const p of s.positions) {
    if (!p.liquidatable) continue;
    actions.push({
      key: `liquidate:${p.id}`,
      kind: "liquidate",
      to: d.attentionPerp,
      data: encodeFunctionData({ abi: attentionPerpAbi, functionName: "liquidate", args: [p.id] }),
      gasCap: GAS.liquidate,
      reason: `equity ${p.equity} below maintenance ${p.maintenance}`,
    });
  }
  let retiredSettlements = 0;
  for (const p of s.positions) {
    if (p.liquidatable || !p.retired || retiredSettlements >= MAX_RETIRED_SETTLEMENTS) continue;
    retiredSettlements++;
    actions.push({
      key: `settleRetired:${p.id}`,
      kind: "settleRetired",
      to: d.attentionPerp,
      data: encodeFunctionData({ abi: attentionPerpAbi, functionName: "settleRetired", args: [p.id] }),
      gasCap: GAS.settleRetired,
      reason: "trend retired",
    });
  }

  for (const id of cfg.graduate === false ? [] : s.readyCurves) {
    actions.push({
      key: `graduate:${id}`,
      kind: "graduate",
      to: d.bondingCurve,
      data: encodeFunctionData({ abi: bondingCurveAbi, functionName: "graduate", args: [id] }),
      gasCap: GAS.graduate,
      reason: "curve filled",
    });
  }

  for (const v of s.series) {
    if (v.settleable) {
      actions.push({
        key: `settle:${v.seriesId}`,
        kind: "settle",
        to: d.outcomeMarkets,
        data: encodeFunctionData({ abi: outcomeMarketsAbi, functionName: "settle", args: [v.seriesId] }),
        gasCap: GAS.settle,
        reason: `expired at ${v.expiry}`,
      });
    }
  }

  for (const t of s.trends) {
    if (t.status === Status.None || t.status === Status.Retired) continue;
    const stale = s.now - t.updatedAt >= s.params.staleRetireWindow;
    const cooledOut = t.status === Status.Cooling && s.now - t.statusSince >= s.params.retireWindow;
    if (stale || cooledOut) {
      actions.push({
        key: `retire:${t.id}`,
        kind: "retire",
        to: d.trendRegistry,
        data: encodeFunctionData({ abi: trendRegistryAbi, functionName: "pokeLifecycle", args: [t.id] }),
        gasCap: GAS.retire,
        reason: stale ? "no oracle update within the stale retire window" : "cooling for the retire window",
      });
    }
  }

  // A window gets its next series once the previous one has settled, so the keeper never has to
  // remember older series: the latest one per window is all there is to act on.
  const offered = new Set(s.windows);
  for (const v of s.series) {
    const t = trendById.get(v.trendId);
    if (!t || !cfg.seriesWindows.includes(v.window) || !offered.has(v.window)) continue;
    const fresh = s.now - t.updatedAt <= s.params.stalenessLimit;
    if (t.status !== Status.Active || !fresh) continue;
    if (v.seriesId === ZERO || v.outcome !== Outcome.Open) {
      actions.push({
        key: `openSeries:${t.id}:${v.window}`,
        kind: "openSeries",
        to: d.outcomeMarkets,
        data: encodeFunctionData({ abi: outcomeMarketsAbi, functionName: "openSeries", args: [t.identifier, v.window] }),
        gasCap: GAS.openSeries,
        reason: v.seriesId === ZERO ? "first series" : "previous series settled",
      });
    }
  }

  for (const v of s.series) {
    if (v.seriesId === ZERO || v.outcome !== Outcome.Open || v.listed || s.now >= v.expiry) continue;
    if (!cfg.listWindows.includes(v.window)) continue;
    // A retired trend's series only waits to settle; nobody can mint into it, so no markets.
    if (trendById.get(v.trendId)?.status === Status.Retired) continue;
    actions.push({
      key: `list:${v.seriesId}`,
      kind: "list",
      to: d.outcomeListing,
      data: encodeFunctionData({ abi: outcomeListingAbi, functionName: "list", args: [v.seriesId] }),
      gasCap: GAS.list,
      reason: "series has no Kuru markets yet",
    });
  }

  // Funding accrues at the mark of the last touch, so a moved index is marked promptly.
  for (const m of s.perpMarkets) {
    const t = trendById.get(m.trendId);
    if (!t || t.status === Status.Retired || m.openInterest === 0n || m.lastMark === t.index) continue;
    actions.push({
      key: `poke:${m.trendId}`,
      kind: "poke",
      to: d.attentionPerp,
      data: encodeFunctionData({ abi: attentionPerpAbi, functionName: "poke", args: [m.trendId] }),
      gasCap: GAS.poke,
      reason: `mark ${m.lastMark} behind index ${t.index}`,
    });
  }

  return actions;
}

const ZERO: Hex = `0x${"0".repeat(64)}`;
