import { decodeFunctionResult, encodeFunctionData, type Hex, keccak256, parseAbi, toBytes } from "viem";
import type { LiveTrend } from "./plan";

export const LENS_ABI = parseAbi([
  "struct OracleTrend { bytes32 id; uint64 index; uint64 updatedAt; uint8 status; uint8 assetClass; uint64 pendingExpiry; uint64 nextExpiry; }",
  "function oracleSnapshot(uint256 cursor, uint256 scanLimit, uint256 maxResults) view returns (uint64 lastRunId, uint256 total, uint256 nextCursor, OracleTrend[] live)",
  "function identifiers(bytes32[] ids) view returns (string[])",
  "function statuses(bytes32[] ids) view returns (uint8[])",
]);

/** One read-only contract call; the workflow backs it with the CRE EVM capability. */
export type ChainCall = (to: Hex, data: Hex) => Hex;

export interface Snapshot {
  lastRunId: bigint;
  total: bigint;
  live: LiveTrend[];
  /** False when the page limit stopped the walk before the last trend. */
  complete: boolean;
}

/** Walks TrendrLens pages until every trend is scanned or `maxPages` calls are used. */
export function readSnapshot(
  call: ChainCall,
  lens: Hex,
  scan: { pageSize: number; scanLimit: number; maxPages: number },
): Snapshot {
  const live: LiveTrend[] = [];
  let cursor = 0n;
  let lastRunId = 0n;
  let total = 0n;
  for (let page = 0; page < scan.maxPages; page++) {
    const data = encodeFunctionData({
      abi: LENS_ABI,
      functionName: "oracleSnapshot",
      args: [cursor, BigInt(scan.scanLimit), BigInt(scan.pageSize)],
    });
    const [runId, count, next, rows] = decodeFunctionResult({
      abi: LENS_ABI,
      functionName: "oracleSnapshot",
      data: call(lens, data),
    });
    lastRunId = runId;
    total = count;
    for (const r of rows) {
      live.push({
        id: r.id,
        index: r.index,
        updatedAt: Number(r.updatedAt),
        status: r.status,
        assetClass: r.assetClass,
        pendingExpiry: Number(r.pendingExpiry),
        nextExpiry: Number(r.nextExpiry),
      });
    }
    cursor = next;
    if (cursor >= total) return { lastRunId, total, live, complete: true };
  }
  return { lastRunId, total, live, complete: false };
}

export function readIdentifiers(call: ChainCall, lens: Hex, ids: readonly Hex[]): string[] {
  if (ids.length === 0) return [];
  const data = encodeFunctionData({ abi: LENS_ABI, functionName: "identifiers", args: [ids] });
  return [...decodeFunctionResult({ abi: LENS_ABI, functionName: "identifiers", data: call(lens, data) })];
}

export function readStatuses(call: ChainCall, lens: Hex, ids: readonly Hex[]): number[] {
  if (ids.length === 0) return [];
  const data = encodeFunctionData({ abi: LENS_ABI, functionName: "statuses", args: [ids] });
  return [...decodeFunctionResult({ abi: LENS_ABI, functionName: "statuses", data: call(lens, data) })];
}

/** The registry's trend id: keccak256 of the identifier's bytes. */
export function trendId(identifier: string): Hex {
  return keccak256(toBytes(identifier));
}
