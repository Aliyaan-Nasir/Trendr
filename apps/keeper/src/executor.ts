import { type Chain, errorSummary, type Sent, SimulationRevert } from "@trendr/chain";
import type { Action, ActionKind } from "./plan";

export interface ExecutorLog {
  info(fields: Record<string, unknown>, message: string): void;
  warn(fields: Record<string, unknown>, message: string): void;
  debug(fields: Record<string, unknown>, message: string): void;
}

export interface ActionResult {
  action: Action;
  outcome: "sent" | "reverted" | "skipped" | "failed";
  sent?: Sent;
  reason?: string;
}

/**
 * Reverts that mean someone else already did the work or the state moved on between the snapshot
 * and the simulation. They are expected with competing keepers and are not worth a warning.
 */
const RACES = [
  "NotLiquidatable",
  "UnknownPosition",
  "AlreadySettled",
  "NotSettleable",
  "NothingToPoke",
  "SeriesStillOpen",
  "SeriesClosed",
  "NotReady",
  "TrendNotActive",
  "IndexStale",
];

const MIN_BACKOFF_MS = 15_000;
const MAX_BACKOFF_MS = 10 * 60_000;

export interface ExecutorStats {
  sent: Record<ActionKind, number>;
  failed: number;
  gasLimitSpent: bigint;
  lastActionAt: number;
}

/**
 * Sends planned actions one at a time from the keeper key. An action that failed waits out an
 * exponential backoff before it is tried again, so a persistent revert never burns gas or floods
 * the logs; one that is in flight is never sent twice.
 */
export class Executor {
  private readonly inFlight = new Set<string>();
  private readonly backoff = new Map<string, { until: number; delay: number; failures: number; reason: string }>();
  readonly stats: ExecutorStats = {
    sent: { liquidate: 0, settleRetired: 0, graduate: 0, settle: 0, retire: 0, openSeries: 0, list: 0, poke: 0 },
    failed: 0,
    gasLimitSpent: 0n,
    lastActionAt: 0,
  };

  constructor(
    private readonly chain: Chain,
    private readonly log: ExecutorLog,
    private readonly now: () => number = Date.now,
  ) {}

  /** Runs up to `max` of `actions` in order and reports each. */
  async run(actions: readonly Action[], max: number): Promise<ActionResult[]> {
    const results: ActionResult[] = [];
    let attempted = 0;
    for (const action of actions) {
      if (attempted >= max) break;
      if (this.inFlight.has(action.key)) continue;
      const wait = this.backoff.get(action.key);
      if (wait && wait.until > this.now()) continue;
      attempted++;
      results.push(await this.execute(action));
    }
    // Forget backoffs for work the planner no longer asks for.
    const wanted = new Set(actions.map((a) => a.key));
    for (const key of this.backoff.keys()) if (!wanted.has(key)) this.backoff.delete(key);
    return results;
  }

  private async execute(action: Action): Promise<ActionResult> {
    this.inFlight.add(action.key);
    try {
      const sent = await this.chain.send({ to: action.to, data: action.data, gasCap: action.gasCap });
      this.stats.gasLimitSpent += sent.gasLimit;
      this.stats.lastActionAt = this.now();
      if (sent.status === "success") {
        this.backoff.delete(action.key);
        this.stats.sent[action.kind]++;
        this.log.info({ key: action.key, reason: action.reason, hash: sent.hash, block: sent.blockNumber, gas: sent.gasLimit }, action.kind);
        return { action, outcome: "sent", sent };
      }
      this.fail(action, "reverted on chain");
      this.log.warn({ key: action.key, hash: sent.hash }, `${action.kind} reverted on chain`);
      return { action, outcome: "reverted", sent, reason: "reverted on chain" };
    } catch (e) {
      const reason = e instanceof SimulationRevert ? e.reason : errorSummary(e);
      this.fail(action, reason);
      if (e instanceof SimulationRevert && RACES.some((r) => reason.startsWith(r))) {
        this.log.debug({ key: action.key, reason }, `${action.kind} no longer needed`);
        return { action, outcome: "skipped", reason };
      }
      this.log.warn({ key: action.key, reason }, `${action.kind} failed`);
      return { action, outcome: "failed", reason };
    } finally {
      this.inFlight.delete(action.key);
    }
  }

  /** Actions that keep failing, for alerting. */
  failing(minFailures: number): { key: string; failures: number; reason: string }[] {
    return [...this.backoff.entries()]
      .filter(([, b]) => b.failures >= minFailures)
      .map(([key, b]) => ({ key, failures: b.failures, reason: b.reason }));
  }

  private fail(action: Action, reason: string) {
    this.stats.failed++;
    const previous = this.backoff.get(action.key);
    const delay = Math.min((previous?.delay ?? MIN_BACKOFF_MS / 2) * 2, MAX_BACKOFF_MS);
    this.backoff.set(action.key, { until: this.now() + delay, delay, failures: (previous?.failures ?? 0) + 1, reason });
  }
}
