import type { Target } from "./config";

export const HOUR_MS = 3_600_000;
export const DAY_MS = 24 * HOUR_MS;

/**
 * One transfer from the treasury. It is written as `pending` before it is sent, so a crash
 * mid-send still counts it toward the caps. `unknown` means the send failed after it may have been
 * broadcast; `failed` means no MON moved (the simulation refused it, or it reverted on chain).
 */
export interface TransferRecord {
  id: string;
  target: string;
  /** Wei, as a decimal string. */
  amount: string;
  at: number;
  status: "pending" | "confirmed" | "unknown" | "failed";
  /** The treasury could cover only part of the refill. */
  partial: boolean;
  hash?: string;
  gasLimit?: string;
}

/** What the service remembers about a target between checks and restarts. */
export interface TargetMemory {
  /** Consecutive failed sends; the next try waits out `retryAt`. */
  failures: number;
  retryAt: number;
  lastError: string | null;
  /** Set when the wallet refilled abnormally often; only an operator release clears it. */
  halted: { at: number; reason: string } | null;
  /** Refills before this no longer count toward the frequency limit. */
  releasedAt: number;
}

export const freshMemory = (): TargetMemory => ({ failures: 0, retryAt: 0, lastError: null, halted: null, releasedAt: 0 });

export interface PlanOptions {
  /** The treasury's balance never goes below this. */
  floor: bigint;
  cooldownMs: number;
  maxRefillsPerHour: number;
  minTransfer: bigint;
}

export interface TargetView {
  target: Target;
  balance: bigint;
  /** Upper bound of the gas fee for a transfer to it. */
  fee: bigint;
}

export type TargetState = "ok" | "send" | "cooldown" | "backoff" | "capped" | "halted" | "starved";

export interface Decision {
  name: string;
  state: TargetState;
  /** A full refill: up to target when below min, else 0. */
  need: bigint;
  /** A refill within the per-transfer and daily caps, whether or not it can go out now. */
  due: bigint;
  /** What to send now when the state is `send`. */
  amount: bigint;
  /** Left under the daily cap. */
  allowance: bigint;
  /** The treasury covers only part of the refill. */
  partial: boolean;
  /** A new halt to record: the wallet tripped the frequency limit on this check. */
  halt?: string;
}

export interface Plan {
  decisions: Decision[];
  /** Above the floor before any send. */
  spendable: bigint;
  /** What targets below min are owed (cooldowns and backoffs included), within their caps. */
  owed: bigint;
  /** The treasury cannot cover what is owed, or is below its floor. */
  treasuryLow: boolean;
  /** Targets left without (or with only part of) their refill because of the treasury. */
  starved: string[];
}

/** Transfers that may have moved MON. */
export const counts = (r: TransferRecord) => r.status !== "failed";

export function sentSince(transfers: readonly TransferRecord[], name: string, since: number): bigint {
  let total = 0n;
  for (const r of transfers) if (r.target === name && r.at > since && counts(r)) total += BigInt(r.amount);
  return total;
}

/** The last transfer that may have moved MON (a pending one too, after a crash), for the cooldown. */
export function lastTransferAt(transfers: readonly TransferRecord[], name: string): number | null {
  let last: number | null = null;
  for (const r of transfers) if (r.target === name && counts(r) && (last === null || r.at > last)) last = r.at;
  return last;
}

/** Full refills (not treasury-limited partial ones) in the last hour, after any release. */
export function refillsLastHour(transfers: readonly TransferRecord[], name: string, now: number, releasedAt: number): number {
  const since = Math.max(now - HOUR_MS, releasedAt);
  return transfers.filter((r) => r.target === name && r.at > since && counts(r) && !r.partial).length;
}

const min = (...xs: bigint[]) => xs.reduce((a, b) => (b < a ? b : a));

/**
 * Decides who gets MON on this check. Targets are served in priority order (the order of
 * `views`); a target in cooldown, backoff, capped or halted is skipped and the next one is
 * served. When the treasury runs short, the first target it cannot fully cover gets what is left
 * above the floor (if that is worth a transfer) and every later one waits.
 */
export function plan(
  now: number,
  treasury: bigint,
  views: readonly TargetView[],
  memory: Readonly<Record<string, TargetMemory>>,
  transfers: readonly TransferRecord[],
  o: PlanOptions,
): Plan {
  const spendable = treasury > o.floor ? treasury - o.floor : 0n;
  let left = spendable;
  let owed = 0n;
  const decisions: Decision[] = [];
  const starved: string[] = [];
  for (const { target: t, balance, fee } of views) {
    const m = memory[t.name] ?? freshMemory();
    const need = balance < t.min ? t.target - balance : 0n;
    const sentToday = sentSince(transfers, t.name, now - DAY_MS);
    const allowance = t.maxPerDay > sentToday ? t.maxPerDay - sentToday : 0n;
    const d: Decision = { name: t.name, state: "ok", need, due: 0n, amount: 0n, allowance, partial: false };
    decisions.push(d);
    if (need === 0n) continue;
    if (m.halted) {
      d.state = "halted";
      continue;
    }
    const due = min(need, t.maxPerTransfer, allowance);
    d.due = due;
    if (due < min(o.minTransfer, need)) {
      d.state = "capped";
      continue;
    }
    const last = lastTransferAt(transfers, t.name);
    if (last !== null && now - last < o.cooldownMs) {
      d.state = "cooldown";
      owed += due + fee;
      continue;
    }
    if (m.retryAt > now) {
      d.state = "backoff";
      owed += due + fee;
      continue;
    }
    const recent = refillsLastHour(transfers, t.name, now, m.releasedAt);
    if (recent >= o.maxRefillsPerHour) {
      d.state = "halted";
      d.halt = `${recent} refills in the last hour (limit ${o.maxRefillsPerHour}): a drain or a bug`;
      continue;
    }
    owed += due + fee;
    if (left >= due + fee) {
      d.state = "send";
      d.amount = due;
      left -= due + fee;
    } else if (left > fee && left - fee >= o.minTransfer) {
      d.state = "send";
      d.amount = left - fee;
      d.partial = true;
      left = 0n;
      starved.push(t.name);
    } else {
      d.state = "starved";
      left = 0n;
      starved.push(t.name);
    }
  }
  return { decisions, spendable, owed, treasuryLow: treasury < o.floor || owed > spendable, starved };
}

export interface Backoff {
  firstMs: number;
  maxMs: number;
}

/** Records a failed send: the next try waits, doubling per consecutive failure. */
export function recordFailure(m: TargetMemory, now: number, reason: string, b: Backoff): void {
  m.failures += 1;
  m.retryAt = now + Math.min(b.firstMs * 2 ** (m.failures - 1), b.maxMs);
  m.lastError = reason;
}
