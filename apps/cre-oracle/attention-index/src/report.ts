import { encodeAbiParameters, type Hex } from "viem";
import type { Decisions } from "./plan";

/** TrendRegistry.Report, ABI-encoded exactly as `abi.decode(report, (Report))` expects. */
export const REPORT_ABI = [
  {
    type: "tuple",
    components: [
      { name: "runId", type: "uint64" },
      { name: "observedAt", type: "uint64" },
      {
        name: "newTrends",
        type: "tuple[]",
        components: [
          { name: "identifier", type: "string" },
          { name: "assetClass", type: "uint8" },
          { name: "index", type: "uint64" },
          { name: "surfacer", type: "address" },
          { name: "smartMoneyConfirmed", type: "bool" },
        ],
      },
      {
        name: "updates",
        type: "tuple[]",
        components: [
          { name: "id", type: "bytes32" },
          { name: "index", type: "uint64" },
        ],
      },
      {
        name: "settlements",
        type: "tuple[]",
        components: [
          { name: "id", type: "bytes32" },
          { name: "expiry", type: "uint64" },
        ],
      },
    ],
  },
] as const;

export function encodeReport(runId: bigint, observedAt: bigint, d: Decisions): Hex {
  return encodeAbiParameters(REPORT_ABI, [
    {
      runId,
      observedAt,
      newTrends: d.newTrends.map((t) => ({
        identifier: t.identifier,
        assetClass: t.assetClass,
        index: t.index,
        surfacer: t.surfacer as `0x${string}`,
        smartMoneyConfirmed: t.smartMoneyConfirmed,
      })),
      updates: d.updates,
      settlements: d.settlements,
    },
  ]);
}

export interface GasParams {
  base: number;
  perNewTrend: number;
  perUpdate: number;
  perSettlement: number;
  max: number;
}

/**
 * Gas limit for delivering a report. Monad bills the full limit, so it is sized to the items
 * instead of left at a large default; the forwarder swallows a failed onReport, so the margin
 * per item is generous.
 */
export function gasLimit(d: Decisions, g: GasParams): number {
  const total =
    g.base + d.newTrends.length * g.perNewTrend + d.updates.length * g.perUpdate + d.settlements.length * g.perSettlement;
  return Math.min(total, g.max);
}
