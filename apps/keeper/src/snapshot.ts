import { attentionPerpAbi, type Deployment, outcomeMarketsAbi, trendRegistryAbi, trendrLensAbi } from "@trendr/contracts";
import type { Hex, PublicClient } from "viem";

/** Registry trend status. */
export enum Status {
  None = 0,
  Active = 1,
  Cooling = 2,
  Retired = 3,
}

/** Series outcome. */
export enum Outcome {
  Open = 0,
  Up = 1,
  Down = 2,
  Void = 3,
}

export interface TrendState {
  id: Hex;
  identifier: string;
  status: Status;
  index: bigint;
  updatedAt: bigint;
  statusSince: bigint;
}

export interface SeriesState {
  trendId: Hex;
  window: number;
  seriesId: Hex;
  expiry: bigint;
  outcome: Outcome;
  settleable: boolean;
  listed: boolean;
}

export interface PositionState {
  id: bigint;
  trendId: Hex;
  owner: Hex;
  equity: bigint;
  maintenance: bigint;
  liquidatable: boolean;
  retired: boolean;
}

export interface PerpMarketState {
  trendId: Hex;
  openInterest: bigint;
  lastMark: bigint;
}

/** Registry parameters the planner needs; immutable, so read once. */
export interface RegistryParams {
  stalenessLimit: bigint;
  retireWindow: bigint;
  staleRetireWindow: bigint;
}

/** Everything the planner decides from, read at one block. */
export interface Snapshot {
  block: bigint;
  now: bigint;
  params: RegistryParams;
  windows: number[];
  trends: TrendState[];
  series: SeriesState[];
  positions: PositionState[];
  perpMarkets: PerpMarketState[];
  readyCurves: Hex[];
}

const PAGE = 100;
const SERIES_CHUNK = 40;
const POSITION_PAGE = 200;
/** How long after a series could last expire a retired trend's series are still read (an outage's worth). */
export const RETIRED_SETTLE_GRACE_SEC = 7n * 86_400n;

export async function readParams(client: PublicClient, d: Deployment): Promise<RegistryParams> {
  const read = (functionName: "stalenessLimit" | "retireWindow" | "staleRetireWindow") =>
    client.readContract({ address: d.trendRegistry, abi: trendRegistryAbi, functionName });
  const [stalenessLimit, retireWindow, staleRetireWindow] = await Promise.all([
    read("stalenessLimit"),
    read("retireWindow"),
    read("staleRetireWindow"),
  ]);
  return { stalenessLimit: BigInt(stalenessLimit), retireWindow: BigInt(retireWindow), staleRetireWindow: BigInt(staleRetireWindow) };
}

/**
 * Reads the protocol state the keeper acts on, pinned to one block so every view agrees. Pages are
 * bounded so a large protocol never exceeds the RPC's eth_call gas limit.
 */
export async function readSnapshot(client: PublicClient, d: Deployment, params: RegistryParams): Promise<Snapshot> {
  const head = await client.getBlock({ blockTag: "latest" });
  const blockNumber = head.number;
  const at = { blockNumber } as const;

  const total = await client.readContract({ address: d.trendRegistry, abi: trendRegistryAbi, functionName: "trendCount", ...at });
  const trends: TrendState[] = [];
  for (let start = 0n; start < total; start += BigInt(PAGE)) {
    const page = await client.readContract({
      address: d.trendRegistry,
      abi: trendRegistryAbi,
      functionName: "trends",
      args: [start, BigInt(PAGE)],
      ...at,
    });
    for (const v of page) {
      trends.push({
        id: v.id,
        identifier: v.identifier,
        status: v.trend.status as Status,
        index: BigInt(v.trend.index),
        updatedAt: BigInt(v.trend.updatedAt),
        statusSince: BigInt(v.trend.statusSince),
      });
    }
  }

  const windows = (
    await client.readContract({ address: d.outcomeMarkets, abi: outcomeMarketsAbi, functionName: "windows", ...at })
  ).map(Number);

  // Live trends, and retired ones whose last series may still wait for settlement: a series
  // expires at most one window after its trend retired, and settling it releases what its holders
  // and the market maker minted. Older retirements are left out, so the read stays bounded.
  const horizon = BigInt(Math.max(0, ...windows)) + RETIRED_SETTLE_GRACE_SEC;
  const watched = trends.filter((t) => t.status !== Status.Retired || head.timestamp - t.statusSince <= horizon).map((t) => t.id);
  const series: SeriesState[] = [];
  for (let i = 0; i < watched.length; i += SERIES_CHUNK) {
    const views = await client.readContract({
      address: d.trendrLens,
      abi: trendrLensAbi,
      functionName: "series",
      args: [watched.slice(i, i + SERIES_CHUNK)],
      ...at,
    });
    for (const v of views) {
      series.push({
        trendId: v.trendId,
        window: Number(v.window),
        seriesId: v.seriesId,
        expiry: BigInt(v.expiry),
        outcome: v.outcome as Outcome,
        settleable: v.settleable,
        listed: v.listed,
      });
    }
  }

  const positions: PositionState[] = [];
  const nextPositionId = await client.readContract({ address: d.attentionPerp, abi: attentionPerpAbi, functionName: "nextPositionId", ...at });
  for (let from = 0n; from < nextPositionId; ) {
    const [open, next] = await client.readContract({
      address: d.trendrLens,
      abi: trendrLensAbi,
      functionName: "positions",
      args: [from, BigInt(POSITION_PAGE)],
      ...at,
    });
    for (const p of open) {
      positions.push({
        id: p.id,
        trendId: p.trendId,
        owner: p.owner,
        equity: p.equity,
        maintenance: p.maintenance,
        liquidatable: p.liquidatable,
        retired: p.retired,
      });
    }
    if (next <= from) break;
    from = next;
  }

  const withPositions = [...new Set(positions.map((p) => p.trendId))];
  const perpMarkets = await Promise.all(
    withPositions.map(async (trendId) => {
      const [longQty, shortQty, , , , lastMark] = await client.readContract({
        address: d.attentionPerp,
        abi: attentionPerpAbi,
        functionName: "markets",
        args: [trendId],
        ...at,
      });
      return { trendId, openInterest: longQty + shortQty, lastMark: BigInt(lastMark) };
    }),
  );

  // A full curve graduates whatever its trend's status.
  const all = trends.map((t) => t.id);
  const readyCurves: Hex[] = [];
  for (let i = 0; i < all.length; i += PAGE) {
    readyCurves.push(
      ...(await client.readContract({
        address: d.trendrLens,
        abi: trendrLensAbi,
        functionName: "readyCurves",
        args: [all.slice(i, i + PAGE)],
        ...at,
      })),
    );
  }

  return { block: blockNumber, now: head.timestamp, params, windows, trends, series, positions, perpMarkets, readyCurves };
}
