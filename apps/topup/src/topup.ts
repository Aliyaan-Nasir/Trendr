import { type Chain, errorSummary, SimulationRevert } from "@trendr/chain";
import { type Address, formatEther, type Hex } from "viem";
import { AlertBook, type Post, type RepeatOptions } from "./alerts";
import { BurnMeter, runwayDays } from "./burn";
import type { Target } from "./config";
import {
  type Backoff,
  DAY_MS,
  type Decision,
  freshMemory,
  type Plan,
  plan,
  recordFailure,
  refillsLastHour,
  sentSince,
  type TargetMemory,
  type TargetState,
  type TransferRecord,
} from "./plan";
import { emptyState, type State, type Store } from "./store";

/** The chain reads a check needs; a viem PublicClient provides them. */
export interface Reader {
  getBalance(args: { address: Address }): Promise<bigint>;
  getCode(args: { address: Address }): Promise<Hex | undefined>;
  estimateFeesPerGas(): Promise<{ maxFeePerGas?: bigint; gasPrice?: bigint }>;
}

export interface TopUpLog {
  info(fields: Record<string, unknown>, message: string): void;
  warn(fields: Record<string, unknown>, message: string): void;
  error(fields: Record<string, unknown>, message: string): void;
}

export interface TopUpOptions {
  treasury: Address;
  /** Highest priority first. */
  targets: Target[];
  floor: bigint;
  intervalMs: number;
  cooldownMs: number;
  maxRefillsPerHour: number;
  minTransfer: bigint;
  runwayAlertDays: number;
  /** Gas cap for a transfer to a wallet with code; plain EOAs take exactly 21000. */
  delegatedGasCap: bigint;
  dryRun: boolean;
  failureBackoff: Backoff;
  alertRepeat: RepeatOptions;
  /** Consecutive failed checks before alerting; one blip is not worth a message. */
  checkFailuresBeforeAlert: number;
}

export interface TargetStatus {
  name: string;
  address: Address;
  balance: bigint | null;
  min: bigint;
  target: bigint;
  state: TargetState | "unknown";
  /** The refill it is waiting for, within its caps; 0 when above min. */
  due: bigint;
  /** Null until it is below min and its code has been read. */
  delegated: boolean | null;
  sentToday: bigint;
  allowance: bigint;
  refillsLastHour: number;
  burnPerDay: bigint | null;
  lastTransfer: TransferRecord | null;
  failures: number;
  lastError: string | null;
  halted: { at: number; reason: string } | null;
}

export interface TopUpStatus {
  role: "starting" | "leader" | "standby" | "dry-run";
  lastCheck: { at: number; durationMs: number; error: string | null } | null;
  lastSuccessAt: number | null;
  consecutiveCheckFailures: number;
  treasury: { address: Address; balance: bigint | null; floor: bigint; spendable: bigint; burnPerDay: bigint | null; runwayDays: number | null };
  targets: TargetStatus[];
  /** Dry run: what the last check would have sent. */
  wouldSend: { name: string; amount: bigint; gasCap: bigint; partial: boolean }[];
}

export type ReleaseResult = "released" | "not-halted" | "unknown-target" | "standby";

/** A plain transfer to an account without code. */
const TRANSFER_GAS = 21_000n;
/** The ledger keeps a day of slack beyond the 24 hours the caps look at. */
const KEEP_MS = 2 * DAY_MS;
/** Runway alerts clear only well above the threshold, so an estimate near it does not flap. */
const RUNWAY_CLEAR_FACTOR = 1.5;

const mon = (wei: bigint) => formatEther(wei);

/**
 * Keeps every target wallet between its min and target balance from one treasury. Each check
 * reads the balances, plans transfers by priority within the treasury's floor, the cooldowns, the
 * backoffs and the daily caps, then sends them one at a time from one key. State that guards
 * against overspending (the transfer ledger, halts, alert state) is reloaded from the store at
 * every check and written ahead of every send.
 */
export class TopUp {
  private state: State = emptyState();
  readonly alerts: AlertBook;
  private readonly burn = new BurnMeter();
  private queue: Promise<unknown> = Promise.resolve();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;
  readonly status: TopUpStatus;

  constructor(
    private readonly reader: Reader,
    private readonly sender: Chain | null,
    private readonly store: Store,
    private readonly log: TopUpLog,
    private readonly opts: TopUpOptions,
    alert: { source: string; webhookUrl?: string; post?: Post },
    private readonly now: () => number = Date.now,
  ) {
    if (!opts.dryRun && !sender) throw new Error("a sender is required unless dry running");
    this.alerts = new AlertBook(alert.source, log, this.state.alerts, opts.alertRepeat, alert.webhookUrl, alert.post, now);
    this.status = {
      role: "starting",
      lastCheck: null,
      lastSuccessAt: null,
      consecutiveCheckFailures: 0,
      treasury: { address: opts.treasury, balance: null, floor: opts.floor, spendable: 0n, burnPerDay: null, runwayDays: null },
      targets: opts.targets.map((t) => this.targetStatus(t, null, null, null)),
      wouldSend: [],
    };
  }

  /** Checks now, then every interval after the previous check ends. */
  start(): void {
    const tick = () => {
      if (this.stopped) return;
      void this.check().finally(() => {
        if (!this.stopped) this.timer = setTimeout(tick, this.opts.intervalMs);
      });
    };
    tick();
  }

  /** Stops scheduling and waits for a check (and any send in it) to finish. */
  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    await this.queue;
  }

  /** One check; checks and releases never overlap. */
  check(): Promise<void> {
    return this.exclusive(() => this.runCheck());
  }

  /** Clears a halt so the target is refilled again; its earlier refills stop counting. */
  release(name: string): Promise<ReleaseResult> {
    return this.exclusive(async () => {
      if (!this.opts.targets.some((t) => t.name === name)) return "unknown-target";
      if (!this.opts.dryRun && !(await this.store.lead())) return "standby";
      await this.load();
      const m = this.memory(name);
      if (!m.halted) return "not-halted";
      Object.assign(m, { halted: null, releasedAt: this.now(), failures: 0, retryAt: 0, lastError: null });
      this.alerts.set(`halted:${name}`, false, "");
      await this.save();
      this.log.warn({ target: name }, "target released by an operator");
      const status = this.status.targets.find((t) => t.name === name);
      if (status) status.halted = null;
      return "released";
    });
  }

  /** Healthy when checks succeed and the treasury holds at least its floor. A standby defers to the leader. */
  healthy(): boolean {
    if (this.status.role === "standby") return true;
    const fresh = this.status.lastSuccessAt !== null && this.now() - this.status.lastSuccessAt < 3 * this.opts.intervalMs + 60_000;
    const funded = this.status.treasury.balance !== null && this.status.treasury.balance >= this.opts.floor;
    return fresh && funded;
  }

  private exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.queue.then(fn, fn);
    this.queue = next.catch(() => undefined);
    return next;
  }

  private memory(name: string): TargetMemory {
    this.state.targets[name] ??= freshMemory();
    return this.state.targets[name];
  }

  /** Reloads state, keeping a check-failed alert raised while the store itself was unreachable. */
  private async load(): Promise<void> {
    const carried = this.alerts.state["check-failed"];
    const now = this.now();
    const loaded = await this.store.load();
    loaded.transfers = loaded.transfers.filter((r) => r.at > now - KEEP_MS);
    const names = new Set(this.opts.targets.map((t) => t.name));
    for (const name of Object.keys(loaded.targets)) if (!names.has(name)) delete loaded.targets[name];
    if (carried && !loaded.alerts["check-failed"]) loaded.alerts["check-failed"] = carried;
    this.state = loaded;
    this.alerts.restore(loaded.alerts);
  }

  private save(): Promise<void> {
    return this.store.save(this.state);
  }

  private async runCheck(): Promise<void> {
    const started = this.now();
    let loaded = false;
    let error: string | null = null;
    try {
      if (!this.opts.dryRun && !(await this.store.lead())) {
        if (this.status.role !== "standby") this.log.info({}, "another instance holds the lock; standing by");
        this.status.role = "standby";
        return;
      }
      if (this.status.role === "standby") this.log.info({}, "took the lock; now leading");
      this.status.role = this.opts.dryRun ? "dry-run" : "leader";
      await this.load();
      loaded = true;
      await this.cycle();
      this.alerts.set("check-failed", false, "");
      await this.save();
      this.status.lastSuccessAt = this.now();
      this.status.consecutiveCheckFailures = 0;
    } catch (e) {
      error = errorSummary(e);
      this.status.consecutiveCheckFailures += 1;
      const n = this.status.consecutiveCheckFailures;
      this.log.error({ error, consecutive: n }, "check failed");
      this.alerts.set("check-failed", n >= this.opts.checkFailuresBeforeAlert, `${n} checks in a row failed: ${error}`);
      // Keep what this check learned (write-ahead records, alert state) when the store is reachable.
      if (loaded) await this.save().catch(() => undefined);
    } finally {
      this.status.lastCheck = { at: started, durationMs: this.now() - started, error };
    }
  }

  private async cycle(): Promise<void> {
    const o = this.opts;
    const now = this.now();
    const [treasury, balances, fees] = await Promise.all([
      this.reader.getBalance({ address: o.treasury }),
      Promise.all(o.targets.map((t) => this.reader.getBalance({ address: t.address }))),
      this.reader.estimateFeesPerGas(),
    ]);
    const maxFee = fees.maxFeePerGas ?? fees.gasPrice ?? 0n;
    o.targets.forEach((t, i) => this.burn.observe(now, t.name, balances[i]!));
    // Only a wallet that may be funded needs its code read: one with code (an EIP-7702 delegation)
    // runs it on receipt, so its transfer is estimated rather than fixed at 21000 gas.
    const codes = await Promise.all(o.targets.map((t, i) => (balances[i]! < t.min ? this.reader.getCode({ address: t.address }) : null)));
    const delegated = codes.map((c) => (c === null ? null : c !== undefined && c !== "0x"));
    const gasCap = (i: number) => (delegated[i] === false ? TRANSFER_GAS : o.delegatedGasCap);
    const views = o.targets.map((target, i) => ({ target, balance: balances[i]!, fee: gasCap(i) * maxFee }));
    const p = plan(now, treasury, views, this.state.targets, this.state.transfers, {
      floor: o.floor,
      cooldownMs: o.cooldownMs,
      maxRefillsPerHour: o.maxRefillsPerHour,
      minTransfer: o.minTransfer,
    });

    for (const d of p.decisions) {
      const m = this.memory(d.name);
      // Funded some other way: earlier failures no longer matter.
      if (d.state === "ok" && m.failures > 0) Object.assign(m, { failures: 0, retryAt: 0, lastError: null });
      if (d.halt) {
        m.halted = { at: now, reason: d.halt };
        this.log.error({ target: d.name, reason: d.halt }, "target halted");
      }
    }

    const wouldSend: TopUpStatus["wouldSend"] = [];
    let sent = false;
    for (const [i, d] of p.decisions.entries()) {
      const t = o.targets[i]!;
      if (o.dryRun && d.state === "starved") {
        this.log.info({ target: t.name, to: t.address, balance: mon(balances[i]!), due: mon(d.due) }, "dry run: would send once the treasury covers it");
      }
      if (d.state !== "send") continue;
      if (o.dryRun) {
        wouldSend.push({ name: t.name, amount: d.amount, gasCap: gasCap(i), partial: d.partial });
        this.log.info(
          { target: t.name, to: t.address, balance: mon(balances[i]!), amount: mon(d.amount), gasCap: gasCap(i).toString(), partial: d.partial },
          "dry run: would send",
        );
        continue;
      }
      await this.transfer(t, d, gasCap(i), balances[i]!, delegated[i] === false);
      sent = true;
    }
    this.status.wouldSend = wouldSend;

    const treasuryNow = sent ? await this.reader.getBalance({ address: o.treasury }) : treasury;
    const spendableNow = treasuryNow > o.floor ? treasuryNow - o.floor : 0n;
    const burnPerDay = this.burn.perDay(now);
    const runway = runwayDays(spendableNow, burnPerDay);
    this.status.treasury = { address: o.treasury, balance: treasuryNow, floor: o.floor, spendable: spendableNow, burnPerDay, runwayDays: runway };
    this.status.targets = o.targets.map((t, i) => this.targetStatus(t, balances[i]!, p.decisions[i]!, delegated[i]!));
    this.raiseAlerts(p, treasuryNow, spendableNow, burnPerDay, runway, balances);
  }

  /** Sends one transfer, recorded before it goes out and settled from its receipt. */
  private async transfer(t: Target, d: Decision, gasCap: bigint, before: bigint, plain: boolean): Promise<void> {
    const now = this.now();
    const m = this.memory(t.name);
    const record: TransferRecord = { id: crypto.randomUUID(), target: t.name, amount: d.amount.toString(), at: now, status: "pending", partial: d.partial };
    this.state.transfers.push(record);
    await this.save();
    try {
      // A wallet without code takes exactly 21000 gas; Monad's estimate for it runs higher.
      const sent = await this.sender!.send({ to: t.address, data: "0x", value: d.amount, gasCap, gas: plain ? TRANSFER_GAS : undefined });
      record.hash = sent.hash;
      record.gasLimit = sent.gasLimit.toString();
      if (sent.status === "success") {
        record.status = "confirmed";
        Object.assign(m, { failures: 0, retryAt: 0, lastError: null });
        const after = await this.reader.getBalance({ address: t.address }).catch(() => null);
        this.log.info(
          {
            target: t.name,
            to: t.address,
            amount: mon(d.amount),
            partial: d.partial,
            hash: sent.hash,
            gasLimit: sent.gasLimit.toString(),
            before: mon(before),
            after: after === null ? null : mon(after),
          },
          "refilled",
        );
      } else {
        record.status = "failed";
        recordFailure(m, now, "reverted on chain", this.opts.failureBackoff);
        this.log.warn({ target: t.name, hash: sent.hash }, "transfer reverted on chain");
      }
    } catch (e) {
      // A refused simulation sent nothing; any later error may have broadcast the transfer, so it
      // keeps counting toward the caps and the cooldown.
      const refused = e instanceof SimulationRevert;
      const reason = refused ? e.reason : errorSummary(e);
      record.status = refused ? "failed" : "unknown";
      recordFailure(m, now, reason, this.opts.failureBackoff);
      this.log.warn({ target: t.name, reason, outcome: record.status, retryInSec: Math.round((m.retryAt - now) / 1000) }, "transfer failed");
    }
    await this.save();
  }

  private raiseAlerts(p: Plan, treasury: bigint, spendable: bigint, burnPerDay: bigint | null, runway: number | null, balances: bigint[]): void {
    const o = this.opts;
    // Once short, the treasury stays low until it covers one more refill of every wallet from min
    // to target, so a partial refill that lifts a wallet past its min does not clear the alert.
    const round = o.targets.reduce((a, t) => a + t.target - t.min, 0n);
    const low = p.treasuryLow || (this.alerts.has("treasury-low") && spendable < round);
    const wanted = o.floor + (p.owed > round ? p.owed : round);
    const waiting = p.starved.length > 0 ? `; cannot cover ${p.starved.join(", ")}` : p.owed > 0n ? `; owes ${mon(p.owed)} MON` : "";
    this.alerts.set(
      "treasury-low",
      low,
      `treasury ${o.treasury} holds ${mon(treasury)} MON against a floor of ${mon(o.floor)} MON${waiting}; send it at least ${mon(wanted > treasury ? wanted - treasury : 0n)} MON`,
    );
    const runwayHolds =
      !low && runway !== null && runway < (this.alerts.has("runway") ? o.runwayAlertDays * RUNWAY_CLEAR_FACTOR : o.runwayAlertDays);
    this.alerts.set(
      "runway",
      runwayHolds,
      `treasury ${o.treasury} lasts about ${runway} days at the observed burn of ${burnPerDay === null ? "?" : mon(burnPerDay)} MON a day; fund it`,
    );
    for (const [i, d] of p.decisions.entries()) {
      const t = o.targets[i]!;
      const m = this.memory(t.name);
      this.alerts.set(
        `capped:${t.name}`,
        d.state === "capped",
        `${t.name} reached its cap of ${mon(t.maxPerDay)} MON a day and holds ${mon(balances[i]!)} MON (min ${mon(t.min)}); refills resume as the 24 hour window moves`,
        false,
      );
      this.alerts.set(
        `halted:${t.name}`,
        m.halted !== null,
        `${t.name} (${t.address}) is halted: ${m.halted?.reason}; no refills until an operator releases it`,
        false,
      );
      this.alerts.set(`send-failed:${t.name}`, m.failures > 0, `transfers to ${t.name} failed ${m.failures} time(s) in a row: ${m.lastError}`);
    }
    // Conditions about wallets that are no longer configured.
    const names = new Set(o.targets.map((t) => t.name));
    for (const key of this.alerts.keys()) {
      const name = key.includes(":") ? key.slice(key.indexOf(":") + 1) : null;
      if (name !== null && !names.has(name)) this.alerts.set(key, false, "");
    }
  }

  private targetStatus(t: Target, balance: bigint | null, decision: Decision | null, delegated: boolean | null): TargetStatus {
    const now = this.now();
    const m = this.state.targets[t.name] ?? freshMemory();
    const sentToday = sentSince(this.state.transfers, t.name, now - DAY_MS);
    const last = this.state.transfers.filter((r) => r.target === t.name).at(-1) ?? null;
    return {
      name: t.name,
      address: t.address,
      balance,
      min: t.min,
      target: t.target,
      state: decision?.state ?? "unknown",
      due: decision?.due ?? 0n,
      delegated,
      sentToday,
      allowance: t.maxPerDay > sentToday ? t.maxPerDay - sentToday : 0n,
      refillsLastHour: refillsLastHour(this.state.transfers, t.name, now, m.releasedAt),
      burnPerDay: this.burn.perDay(now, t.name),
      lastTransfer: last,
      failures: m.failures,
      lastError: m.lastError,
      halted: m.halted,
    };
  }

  /** The status with amounts in MON, for /health. */
  view(): Record<string, unknown> {
    const s = this.status;
    const fmt = (v: bigint | null) => (v === null ? null : mon(v));
    return {
      role: s.role,
      dryRun: this.opts.dryRun,
      lastCheck: s.lastCheck,
      lastSuccessAt: s.lastSuccessAt,
      treasury: {
        address: s.treasury.address,
        balance: fmt(s.treasury.balance),
        floor: mon(s.treasury.floor),
        spendable: mon(s.treasury.spendable),
        burnPerDay: fmt(s.treasury.burnPerDay),
        runwayDays: s.treasury.runwayDays,
      },
      targets: s.targets.map((t) => ({
        ...t,
        balance: fmt(t.balance),
        min: mon(t.min),
        target: mon(t.target),
        due: mon(t.due),
        sentToday: mon(t.sentToday),
        allowance: mon(t.allowance),
        burnPerDay: fmt(t.burnPerDay),
        lastTransfer: t.lastTransfer && { ...t.lastTransfer, amount: mon(BigInt(t.lastTransfer.amount)) },
      })),
      wouldSend: s.wouldSend.map((w) => ({ ...w, amount: mon(w.amount), gasCap: w.gasCap.toString() })),
      alerts: this.alerts.active(),
    };
  }
}
