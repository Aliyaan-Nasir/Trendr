import type { Candidate } from "./sources/candidates";
import { toIndexUnits } from "./index-method";
import { CRYPTO, MAX_VERSION, versioned } from "./identifiers";

/** A live trend as TrendrLens reports it. */
export interface LiveTrend {
  id: `0x${string}`;
  index: bigint;
  updatedAt: number;
  status: number;
  assetClass: number;
  /** Latest-series expiry at or before now whose settlement is not final yet, or 0. */
  pendingExpiry: number;
  nextExpiry: number;
}

export interface Measurement {
  /** Index points (0 to 100), or null when no source answered. */
  points: number | null;
  /** Net smart-money flow (USD, 24h) for crypto, or null. */
  netflowUsd: number | null;
}

export interface NewTrendItem {
  identifier: string;
  assetClass: number;
  index: bigint;
  surfacer: string;
  smartMoneyConfirmed: boolean;
}

export interface Decisions {
  newTrends: NewTrendItem[];
  updates: Array<{ id: `0x${string}`; index: bigint }>;
  settlements: Array<{ id: `0x${string}`; expiry: bigint }>;
}

/** CRE allows 15 HTTP calls per execution. */
export const HTTP_CALL_LIMIT = 15;

/**
 * How many trends fit in one run after the fixed calls, never more than `cap`. When every source
 * reads through the collector, measuring costs no per-trend calls and only the cap applies.
 */
export function sampleSlots(fixedCalls: number, perSampleCalls: number, cap: number): number {
  if (fixedCalls > HTTP_CALL_LIMIT) return 0;
  if (perSampleCalls <= 0) return cap;
  return Math.max(0, Math.min(cap, Math.floor((HTTP_CALL_LIMIT - fixedCalls) / perSampleCalls)));
}

/**
 * Splits the run's sample slots: trends with a pending settlement first (oldest expiry first),
 * then up to `maxCandidates` candidates, then the trends observed longest ago. Deterministic, so
 * every node samples the same trends.
 */
export function allocate(
  live: readonly LiveTrend[],
  candidates: readonly Candidate[],
  slots: number,
  maxCandidates: number,
): { trends: LiveTrend[]; candidates: Candidate[] } {
  const pending = live
    .filter((t) => t.pendingExpiry > 0)
    .sort((a, b) => a.pendingExpiry - b.pendingExpiry || a.updatedAt - b.updatedAt || a.id.localeCompare(b.id));
  const rest = live
    .filter((t) => t.pendingExpiry === 0)
    .sort((a, b) => a.updatedAt - b.updatedAt || a.id.localeCompare(b.id));

  const trends = pending.slice(0, slots);
  const pickedCandidates = candidates.slice(0, Math.min(maxCandidates, slots - trends.length));
  trends.push(...rest.slice(0, slots - trends.length - pickedCandidates.length));
  return { trends, candidates: pickedCandidates };
}

/**
 * The listing a candidate should use from the registry statuses of `base`, `base.2`, ...
 * (`statuses[i]` for listing i + 1): the first unused listing after only retired ones, or null
 * when a listing is still live or all versions are used.
 */
export function freeListing(base: string, statuses: readonly number[]): string | null {
  for (let i = 0; i < Math.min(statuses.length, MAX_VERSION); i++) {
    const status = statuses[i];
    if (status === 0) return versioned(base, i + 1);
    if (status !== 3) return null; // Active or Cooling: already listed
  }
  return null;
}

export interface DecideParams {
  now: number;
  heartbeatSec: number;
  deviationBps: number;
  minCreateIndexPoints: number;
  minConfirmNetflowUsd: number;
}

/**
 * What the report carries. A sampled trend is reported when its heartbeat is due, when it moved
 * at least `deviationBps`, or when a series is waiting for its settlement observation (the first
 * observation at or after expiry settles it, so it must be a fresh measurement). Trends that were
 * not measured are never re-reported with an old value. A report that goes out also carries
 * sampled trends past half their heartbeat. Candidates become trends at or above
 * `minCreateIndexPoints`, and crypto candidates also need smart-money net inflow.
 */
export function decide(
  sampled: ReadonlyArray<{ trend: LiveTrend; m: Measurement }>,
  candidates: ReadonlyArray<{ candidate: Candidate; identifier: string; m: Measurement }>,
  p: DecideParams,
): Decisions {
  const out: Decisions = { newTrends: [], updates: [], settlements: [] };
  const riders: Array<{ id: `0x${string}`; index: bigint }> = [];
  for (const { trend, m } of sampled) {
    if (m.points === null) continue;
    const index = toIndexUnits(m.points);
    const age = p.now - trend.updatedAt;
    const moved = trend.index > 0n ? Number(absDiff(index, trend.index) * 10_000n / trend.index) : Infinity;
    if (age >= p.heartbeatSec || moved >= p.deviationBps || trend.pendingExpiry > 0) {
      out.updates.push({ id: trend.id, index });
      if (trend.pendingExpiry > 0) out.settlements.push({ id: trend.id, expiry: BigInt(trend.pendingExpiry) });
    } else if (age >= p.heartbeatSec / 2) {
      riders.push({ id: trend.id, index });
    }
  }
  for (const { candidate, identifier, m } of candidates) {
    if (m.points === null || m.points < p.minCreateIndexPoints) continue;
    const crypto = candidate.assetClass === CRYPTO;
    const confirmed = m.netflowUsd !== null && m.netflowUsd >= p.minConfirmNetflowUsd;
    if (crypto && !confirmed) continue;
    out.newTrends.push({
      identifier,
      assetClass: candidate.assetClass,
      index: toIndexUnits(m.points),
      surfacer: candidate.surfacer,
      smartMoneyConfirmed: crypto && confirmed,
    });
  }
  // A report that goes out anyway also carries trends halfway to their heartbeat, so heartbeats
  // line up and share one transaction's base cost instead of each paying for its own.
  if (!isEmpty(out)) out.updates.push(...riders);
  return out;
}

function absDiff(a: bigint, b: bigint): bigint {
  return a > b ? a - b : b - a;
}

export function isEmpty(d: Decisions): boolean {
  return d.newTrends.length === 0 && d.updates.length === 0 && d.settlements.length === 0;
}
