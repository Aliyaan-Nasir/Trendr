import { type Alerts, type Chain, errorSummary, type Head, MonadRealtime } from "@trendr/chain";
import { type Deployment, kuruGraduationVenueAbi } from "@trendr/contracts";
import type { Address, PublicClient } from "viem";
import type { Executor } from "./executor";
import { type PlanConfig, plan } from "./plan";
import { type RegistryParams, readParams, readSnapshot, Status } from "./snapshot";

export interface KeeperLog {
  info(fields: Record<string, unknown>, message: string): void;
  warn(fields: Record<string, unknown>, message: string): void;
  error(fields: Record<string, unknown>, message: string): void;
  debug(fields: Record<string, unknown>, message: string): void;
}

export interface KeeperOptions extends PlanConfig {
  scanEveryBlocks: number;
  maxActionsPerScan: number;
  pollMs: number;
  headLagAlertSec: number;
  minBalanceWei: bigint;
  /** WebSocket endpoints; without any, heads are polled over HTTP. */
  wsUrls?: readonly string[];
  /** Trends the backend is rotating out: their index goes stale on purpose, so they raise no alert. */
  rotating?: () => Promise<ReadonlySet<string>>;
}

export interface KeeperStatus {
  head: { number: bigint; seenAt: number };
  lastScan: { block: bigint; at: number; durationMs: number; planned: number; sent: number } | null;
  lastError: string | null;
  oracle: { live: number; stale: number; oldestUpdateSec: number };
  balanceWei: bigint;
}

/**
 * Watches Monad at the Voted stage and keeps the protocol moving. Any protocol event triggers a
 * rescan on the next head, and a full rescan also runs every `scanEveryBlocks`, so missed events
 * never strand work: every decision is made from a fresh snapshot of chain state.
 */
export class Keeper {
  private params: RegistryParams | null = null;
  private scanning: Promise<void> | null = null;
  private dirty = true;
  private realtime: MonadRealtime | null = null;
  private timers: ReturnType<typeof setInterval>[] = [];
  readonly status: KeeperStatus = {
    head: { number: 0n, seenAt: 0 },
    lastScan: null,
    lastError: null,
    oracle: { live: 0, stale: 0, oldestUpdateSec: 0 },
    balanceWei: 0n,
  };

  constructor(
    private readonly client: PublicClient,
    private readonly chain: Chain,
    private readonly deployment: Deployment,
    private readonly executor: Executor,
    private readonly alerts: Alerts,
    private readonly log: KeeperLog,
    private readonly opts: KeeperOptions,
  ) {}

  get address(): Address {
    return this.chain.senders()[0]!;
  }

  async start(): Promise<void> {
    this.params = await readParams(this.client, this.deployment);
    const d = this.deployment;
    // On a permissioned Kuru router (Mainnet) the venue refuses graduation listings.
    const permissioned = await this.client.readContract({ address: d.kuruGraduationVenue, abi: kuruGraduationVenueAbi, functionName: "routerPermissioned" }).catch(() => false);
    this.opts.graduate = !permissioned;
    if (this.opts.wsUrls && this.opts.wsUrls.length > 0) {
      this.realtime = new MonadRealtime(this.opts.wsUrls, {
        log: (level, message, fields) => this.log[level](fields ?? {}, message),
      })
        .onHeads((h) => this.onHead(h))
        .onLogs({ address: [d.trendRegistry, d.outcomeMarkets, d.attentionPerp, d.bondingCurve, d.outcomeListing] }, () => {
          this.dirty = true;
        })
        .start();
    }
    // Polls over HTTP whenever there is no live WebSocket feed.
    this.timers.push(
      setInterval(() => {
        if (this.realtime?.status.connected) return;
        this.client
          .getBlockNumber()
          .then((number) => {
            if (number > this.status.head.number) this.onHead({ number } as Head);
          })
          .catch((e) => this.log.warn({ error: String(e) }, "head poll failed"));
      }, this.opts.pollMs),
    );
    this.timers.push(setInterval(() => this.checkLiveness(), 5_000));
    this.log.info({ keeper: this.address, windows: this.opts.seriesWindows, listed: this.opts.listWindows, graduates: this.opts.graduate }, "keeper started");
  }

  stop(): void {
    this.realtime?.stop();
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
  }

  /** Scans now and waits for it; tests and the polling path use it directly. */
  async scan(): Promise<void> {
    if (this.scanning) {
      this.dirty = true;
      return this.scanning;
    }
    this.scanning = this.doScan().finally(() => {
      this.scanning = null;
    });
    return this.scanning;
  }

  private onHead(head: Head): void {
    this.status.head = { number: head.number, seenAt: Date.now() };
    const due = this.status.lastScan === null || head.number - this.status.lastScan.block >= BigInt(this.opts.scanEveryBlocks);
    if ((this.dirty || due) && !this.scanning) void this.scan();
  }

  private async doScan(): Promise<void> {
    const started = Date.now();
    this.dirty = false;
    try {
      this.params ??= await readParams(this.client, this.deployment);
      const snapshot = await readSnapshot(this.client, this.deployment, this.params);
      const rotating = this.opts.rotating ? await this.opts.rotating().catch(() => new Set<string>()) : new Set<string>();
      const live = snapshot.trends.filter((t) => (t.status === Status.Active || t.status === Status.Cooling) && !rotating.has(t.identifier));
      const ages = live.map((t) => Number(snapshot.now - t.updatedAt));
      const stale = ages.filter((a) => a > Number(snapshot.params.stalenessLimit)).length;
      this.status.oracle = { live: live.length, stale, oldestUpdateSec: ages.length ? Math.max(...ages) : 0 };
      this.alerts.set("oracle-stale", stale > 0, `${stale} of ${live.length} live trends have a stale index (oldest ${this.status.oracle.oldestUpdateSec}s)`);

      const actions = plan(snapshot, this.deployment, this.opts);
      const results = await this.executor.run(actions, this.opts.maxActionsPerScan);
      const sent = results.filter((r) => r.outcome === "sent").length;
      // What was sent changed state; look again on the next head.
      if (sent > 0 || actions.length > results.length) this.dirty = true;
      this.status.lastScan = { block: snapshot.block, at: Date.now(), durationMs: Date.now() - started, planned: actions.length, sent };
      this.status.lastError = null;
      if (actions.length > 0) this.log.debug({ block: snapshot.block, planned: actions.length, sent }, "scan");

      const failing = this.executor.failing(4);
      for (const f of failing) this.alerts.set(`failing:${f.key}`, true, `${f.key} failed ${f.failures} times: ${f.reason}`);
      // An action that succeeded or is no longer needed resolves its alert.
      const still = new Set(failing.map((f) => `failing:${f.key}`));
      for (const key of Object.keys(this.alerts.active())) if (key.startsWith("failing:") && !still.has(key)) this.alerts.set(key, false, "");
      this.status.balanceWei = await this.client.getBalance({ address: this.address });
      this.alerts.set("balance-low", this.status.balanceWei < this.opts.minBalanceWei, `keeper ${this.address} holds ${this.status.balanceWei} wei of MON`);
    } catch (e) {
      this.status.lastError = errorSummary(e);
      this.log.error({ error: this.status.lastError }, "scan failed");
      this.dirty = true;
    }
  }

  private checkLiveness(): void {
    const silentSec = this.status.head.seenAt ? (Date.now() - this.status.head.seenAt) / 1000 : 0;
    this.alerts.set("head-lag", silentSec > this.opts.headLagAlertSec, `no new block for ${Math.round(silentSec)}s`);
    const scanAgeSec = this.status.lastScan ? (Date.now() - this.status.lastScan.at) / 1000 : 0;
    this.alerts.set("scan-stalled", scanAgeSec > Math.max(60, this.opts.headLagAlertSec * 2), `no completed scan for ${Math.round(scanAgeSec)}s`);
  }

  /** Healthy when blocks arrive, scans complete, the last one succeeded and the key can pay for gas. */
  healthy(): boolean {
    const now = Date.now();
    const headOk = now - this.status.head.seenAt < this.opts.headLagAlertSec * 1000;
    const scanOk = this.status.lastScan !== null && now - this.status.lastScan.at < Math.max(60, this.opts.headLagAlertSec * 2) * 1000;
    const funded = this.status.balanceWei >= this.opts.minBalanceWei;
    return headOk && scanOk && funded && this.status.lastError === null;
  }
}
