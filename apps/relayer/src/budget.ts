import type { Address } from "viem";

/**
 * How much gas the relayer pays, counted in gas limit because Monad bills the limit whether a
 * transaction succeeds or reverts. Budgets cap one account per UTC day, every account together
 * per rolling hour, and activations per rolling hour, and an account whose relays keep reverting
 * is paused for a while.
 */

export type RelayKind = "activation" | "session" | "owner";

export interface BudgetLimits {
  /** Gas limit one account may spend per UTC day, its activation included. */
  accountGasPerDay: bigint;
  /** Gas limit all accounts together may spend in any rolling hour. */
  totalGasPerHour: bigint;
  /** Activations paid for in any rolling hour, across all accounts. */
  activationsPerHour: number;
  /** From this many reverted relays in one UTC day, each further one pauses the account. */
  revertsBeforeCooldown: number;
  /** Seconds an account is refused after a revert at or above the threshold. */
  revertCooldownSeconds: number;
}

export const DEFAULT_LIMITS: BudgetLimits = {
  accountGasPerDay: 40_000_000n,
  totalGasPerHour: 300_000_000n,
  activationsPerHour: 60,
  revertsBeforeCooldown: 3,
  revertCooldownSeconds: 3_600,
};

export interface Reservation {
  account: Address;
  kind: RelayKind;
  gas: bigint;
  /** Seconds since epoch when it was taken; settling adjusts the windows it was counted in. */
  at: number;
}

export type BudgetCode = "account_cooldown" | "account_budget" | "relayer_budget" | "activation_budget";

export type ReserveResult =
  | { ok: true; reservation: Reservation }
  | { ok: false; code: BudgetCode; message: string; retryAfter: number };

export interface BudgetUsage {
  limits: { accountGasPerDay: number; totalGasPerHour: number; activationsPerHour: number };
  /** The rolling hour, all accounts together. */
  lastHour: { gas: number; activations: number };
  /** The current UTC day. */
  today: { accounts: number; busiestAccountGas: number; reverts: number };
  coolingDown: number;
}

/**
 * Where budget state lives. MemoryBudget keeps it in the one relayer process; the methods are
 * async so a shared store (Redis, Postgres) can implement them when the relayer runs as several.
 */
export interface BudgetStore {
  /** Reserves `gas` for one relay when every budget allows it. Reserve the worst case (the cap). */
  reserve(account: Address, kind: RelayKind, gas: bigint, now: number): Promise<ReserveResult>;
  /** Settles a reservation at the gas limit actually sent, or 0n when nothing was sent. */
  settle(r: Reservation, gas: bigint): Promise<void>;
  /** Counts a relay that reverted on chain, and was billed. */
  recordRevert(account: Address, now: number): Promise<void>;
  usage(now: number): Promise<BudgetUsage>;
}

const DAY = 86_400;
const HOUR = 3_600;
const MINUTE = 60;

interface AccountDay {
  day: number;
  gas: bigint;
  reverts: number;
  coolUntil: number;
}

interface Bucket {
  gas: bigint;
  activations: number;
}

/** Budgets for one process: per-account days, and the rolling hour in one-minute buckets. */
export class MemoryBudget implements BudgetStore {
  private readonly accounts = new Map<string, AccountDay>();
  private readonly minutes = new Map<number, Bucket>();
  private sweptDay = -1;

  constructor(private readonly limits: BudgetLimits = DEFAULT_LIMITS) {}

  async reserve(account: Address, kind: RelayKind, gas: bigint, now: number): Promise<ReserveResult> {
    const a = this.account(account, now);
    if (a.coolUntil > now) {
      return refuse("account_cooldown", "too many transactions from this account reverted; try again later", a.coolUntil - now);
    }
    if (a.gas + gas > this.limits.accountGasPerDay) {
      return refuse("account_budget", "this account has used its gas allowance for today", DAY - (now % DAY));
    }
    const hour = this.hour(now);
    if (hour.gas + gas > this.limits.totalGasPerHour) {
      const wait = this.freedAfter(now, (b) => b.gas, hour.gas + gas - this.limits.totalGasPerHour);
      return refuse("relayer_budget", "the relayer has reached its hourly gas budget; try again shortly", wait);
    }
    if (kind === "activation" && hour.activations + 1 > this.limits.activationsPerHour) {
      const wait = this.freedAfter(now, (b) => BigInt(b.activations), 1n);
      return refuse("activation_budget", "the relayer has reached its hourly activation budget; try again shortly", wait);
    }
    a.gas += gas;
    const b = this.bucket(now);
    b.gas += gas;
    if (kind === "activation") b.activations += 1;
    return { ok: true, reservation: { account, kind, gas, at: now } };
  }

  async settle(r: Reservation, gas: bigint): Promise<void> {
    const refund = r.gas - gas;
    const a = this.accounts.get(r.account.toLowerCase());
    if (a && a.day === dayOf(r.at)) a.gas = max0(a.gas - refund);
    const b = this.minutes.get(minuteOf(r.at));
    if (b) {
      b.gas = max0(b.gas - refund);
      if (r.kind === "activation" && gas === 0n) b.activations = Math.max(0, b.activations - 1);
    }
  }

  async recordRevert(account: Address, now: number): Promise<void> {
    const a = this.account(account, now);
    a.reverts += 1;
    if (a.reverts >= this.limits.revertsBeforeCooldown) a.coolUntil = now + this.limits.revertCooldownSeconds;
  }

  async usage(now: number): Promise<BudgetUsage> {
    const hour = this.hour(now);
    const today = dayOf(now);
    let accounts = 0;
    let busiest = 0n;
    let reverts = 0;
    let coolingDown = 0;
    for (const a of this.accounts.values()) {
      if (a.coolUntil > now) coolingDown += 1;
      if (a.day !== today) continue;
      if (a.gas > 0n) accounts += 1;
      if (a.gas > busiest) busiest = a.gas;
      reverts += a.reverts;
    }
    return {
      limits: {
        accountGasPerDay: Number(this.limits.accountGasPerDay),
        totalGasPerHour: Number(this.limits.totalGasPerHour),
        activationsPerHour: this.limits.activationsPerHour,
      },
      lastHour: { gas: Number(hour.gas), activations: hour.activations },
      today: { accounts, busiestAccountGas: Number(busiest), reverts },
      coolingDown,
    };
  }

  /** The account's record for today; a new day clears its gas and reverts but not a cooldown. */
  private account(account: Address, now: number): AccountDay {
    const day = dayOf(now);
    if (day !== this.sweptDay) this.sweep(day, now);
    const key = account.toLowerCase();
    let a = this.accounts.get(key);
    if (!a) {
      a = { day, gas: 0n, reverts: 0, coolUntil: 0 };
      this.accounts.set(key, a);
    } else if (a.day !== day) {
      a.day = day;
      a.gas = 0n;
      a.reverts = 0;
    }
    return a;
  }

  /** Drops records of past days that no longer hold a cooldown, so memory stays bounded. */
  private sweep(day: number, now: number) {
    for (const [k, a] of this.accounts) {
      if (a.day < day && a.coolUntil <= now) this.accounts.delete(k);
    }
    this.sweptDay = day;
  }

  private bucket(now: number): Bucket {
    const m = minuteOf(now);
    let b = this.minutes.get(m);
    if (!b) {
      b = { gas: 0n, activations: 0 };
      this.minutes.set(m, b);
    }
    return b;
  }

  /** Totals over the minutes of the rolling hour; older buckets are dropped on the way. */
  private hour(now: number): Bucket {
    const first = minuteOf(now) - HOUR / MINUTE + 1;
    const total: Bucket = { gas: 0n, activations: 0 };
    for (const [m, b] of this.minutes) {
      if (m < first) {
        this.minutes.delete(m);
        continue;
      }
      total.gas += b.gas;
      total.activations += b.activations;
    }
    return total;
  }

  /** Seconds until the oldest buckets leaving the rolling hour free at least `need`. */
  private freedAfter(now: number, amount: (b: Bucket) => bigint, need: bigint): number {
    let freed = 0n;
    for (const m of [...this.minutes.keys()].sort((x, y) => x - y)) {
      freed += amount(this.minutes.get(m)!);
      if (freed >= need) return Math.max(1, (m + 1) * MINUTE + HOUR - MINUTE - now);
    }
    return HOUR;
  }
}

function refuse(code: BudgetCode, message: string, retryAfter: number): ReserveResult {
  return { ok: false, code, message, retryAfter: Math.max(1, Math.ceil(retryAfter)) };
}

const dayOf = (t: number) => Math.floor(t / DAY);
const minuteOf = (t: number) => Math.floor(t / MINUTE);
const max0 = (v: bigint) => (v < 0n ? 0n : v);
