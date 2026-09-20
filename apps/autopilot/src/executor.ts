import { type Decision, evaluate, type RuleState } from "@trendr/autopilot";
import { type PerplMarket, toSizeUnits } from "@trendr/perpl";
import type { Address } from "viem";
import type { ExecutorDb, OrderRow, PositionRow, RuleRow } from "./db";
import type { OrderOutcome, PerplChain } from "./perpl-chain";
import { type Venue, VenueError } from "./venues";

/**
 * The Autopilot loop. Each tick it finishes orders in flight, reconciles positions with the
 * chain, evaluates every running rule with the shared engine and acts, then lets copy-trading
 * mirror leaders. Orders are idempotent (a unique intent per attempt, stored before sending) and
 * every decision, order and failure lands in the audit log.
 */

export interface Log {
  info(obj: object, msg: string): void;
  warn(obj: object, msg: string): void;
  error(obj: object, msg: string): void;
}

export interface VenueResolver {
  /** The venue an owner trades through, or null when it has none (no active grant). */
  forOwner(owner: string): Promise<Venue | null>;
}

export interface ExecutorOptions {
  slippageBps: number;
  fillTimeoutSec: number;
  maxConsecutiveFailures: number;
  /** Kill switch from the environment. */
  killEnv: boolean;
  /** How old a Nansen reading may be and still count. */
  netflowMaxAgeSec: number;
  pollMs?: number;
}

export interface ExecutorStatus {
  lastTickAt: number;
  lastTickMs: number;
  lastError: string | null;
  killed: boolean;
  rules: number;
  ordersInFlight: number;
  ticks: number;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const lower = (a: string) => a.toLowerCase();

export class Executor {
  readonly status: ExecutorStatus = { lastTickAt: 0, lastTickMs: 0, lastError: null, killed: false, rules: 0, ordersInFlight: 0, ticks: 0 };
  /** The last reason a rule waited, so the audit log records changes rather than every tick. */
  private readonly lastWait = new Map<number, string>();

  constructor(
    private readonly db: ExecutorDb,
    private readonly chain: PerplChain,
    private readonly markets: () => Promise<PerplMarket[]>,
    private readonly venues: VenueResolver,
    private readonly opts: ExecutorOptions,
    private readonly log: Log,
    private readonly hooks: { afterRules?: (ctx: TickContext) => Promise<void> } = {},
  ) {}

  async tick(nowSec = Math.floor(Date.now() / 1000)): Promise<void> {
    const started = Date.now();
    try {
      const kill = this.opts.killEnv || (await this.db.killSwitch()).engaged;
      const markets = await this.markets();
      const bySymbol = new Map(markets.map((m) => [m.symbol, m]));
      const marks = await this.chain.marks(markets);
      const ctx: TickContext = { nowSec, kill, bySymbol, marks };

      for (const o of await this.db.openOrders()) await this.resolve(o, ctx).catch((e) => this.fail("resolve", e, { order: o.id }));
      await this.reconcile(ctx).catch((e) => this.fail("reconcile", e, {}));
      const rules = await this.db.rulesToRun();
      for (const r of rules) await this.runRule(r, ctx).catch((e) => this.fail("rule", e, { rule: r.id }));
      await this.hooks.afterRules?.(ctx);

      this.status.killed = kill;
      this.status.rules = rules.length;
      this.status.ordersInFlight = (await this.db.openOrders()).length;
      this.status.lastError = null;
    } catch (e) {
      this.status.lastError = e instanceof Error ? e.message : String(e);
      throw e;
    } finally {
      this.status.lastTickAt = Math.floor(Date.now() / 1000);
      this.status.lastTickMs = Date.now() - started;
      this.status.ticks++;
    }
  }

  private fail(where: string, e: unknown, fields: Record<string, unknown>) {
    const message = e instanceof Error ? e.message : String(e);
    this.status.lastError = `${where}: ${message}`;
    this.log.error({ ...fields, err: message.slice(0, 300) }, `autopilot ${where} failed`);
  }

  private async runRule(r: RuleRow, ctx: TickContext): Promise<void> {
    const market = ctx.bySymbol.get(r.rule.market);
    if (!market) return this.pause(r, `Perpl has no open ${r.rule.market} market`);
    const venue = await this.venues.forOwner(r.owner);
    if (!venue) return this.pause(r, "no active Autopilot grant for the account");
    const pos = await this.db.livePosition({ ruleId: r.id });
    // An order is in flight for it; resolve() settles it.
    if (pos && (pos.status === "opening" || pos.status === "closing")) return;
    const price = ctx.marks.get(market.symbol);
    if (!price) return this.wait(r, "no mark price");
    // Paused rules manage their open position to its exit but open nothing new.
    if (!pos && r.status !== "enabled") return;

    const trendId = await this.db.trendIdOf(r.rule.trend);
    const lookback = r.rule.entry.windowMin * 60 + 2 * 86_400;
    const attention = trendId ? await this.db.attention(trendId, ctx.nowSec - lookback) : [];
    const netflow = await this.db.latestNetflow(r.rule.trend, this.opts.netflowMaxAgeSec);
    const state: RuleState = {
      position: pos && pos.entryPrice !== null && pos.openedAt
        ? { side: pos.side, entryPrice: pos.entryPrice, size: pos.size, marginAusd: pos.marginAusd, leverage: pos.leverage, openedAt: Math.floor(pos.openedAt.getTime() / 1000) }
        : null,
      realizedTodayAusd: await this.db.realizedToday({ ruleId: r.id }),
      lastExitAt: await this.db.lastExitAt(r.id),
      killed: ctx.kill || r.status === "stopped",
    };
    const d = evaluate(r.rule, state, { now: ctx.nowSec, price, attention, netflowUsd: netflow });
    if (d.action === "wait" || d.action === "hold") return this.wait(r, d.reason);
    this.lastWait.delete(r.id);

    if (d.action === "close" && pos) {
      await this.db.audit(r.owner, "exit_signal", { reason: d.reason, movePct: d.movePct, price }, r.id);
      await this.place(venue, market, { owner: r.owner, ruleId: r.id, followId: null }, { kind: "close", position: pos, reason: d.reason, price });
      return;
    }
    if (d.action === "open" && r.status === "enabled" && !ctx.kill) {
      if (await this.marketBusy(r.owner, market.symbol, venue)) return this.wait(r, `${market.symbol} already has a position on this account`);
      const n = (await this.db.positionCount(r.id)) + 1;
      await this.db.audit(r.owner, "entry_signal", { reason: d.reason, signal: d.signal, price, size: d.size, marginAusd: d.marginAusd, leverage: d.leverage }, r.id);
      await this.place(venue, market, { owner: r.owner, ruleId: r.id, followId: null }, { kind: "open", intent: `rule:${r.id}:open:${n}`, decision: d, price });
    }
  }

  /** True when the owner already holds the market (another rule, a copy, or a manual position). */
  async marketBusy(owner: string, symbol: string, venue: Venue): Promise<boolean> {
    if ((await this.db.liveInMarket(lower(owner), symbol)).length > 0) return true;
    const id = await venue.accountId();
    if (!id) return false;
    const market = (await this.markets()).find((m) => m.symbol === symbol);
    return market ? (await this.chain.holdings(id, [market])).has(symbol) : false;
  }

  private async wait(r: RuleRow, reason: string): Promise<void> {
    if (this.lastWait.get(r.id) === reason) return;
    this.lastWait.set(r.id, reason);
    await this.db.audit(r.owner, "waiting", { reason }, r.id);
  }

  private async pause(r: RuleRow, reason: string): Promise<void> {
    if (r.status !== "enabled") return;
    await this.db.setRuleStatus(r.id, "paused", reason);
    await this.db.audit(r.owner, "rule_paused", { reason, by: "autopilot" }, r.id);
    this.log.warn({ rule: r.id, reason }, "rule paused");
  }

  /**
   * Places an order: reserve a request id, record the order and its position (idempotent), send,
   * then wait for its result on chain. Shared with copy-trading, whose openings may bring a tighter
   * worst price than the slippage from the mark.
   */
  async place(
    venue: Venue,
    market: PerplMarket,
    who: { owner: string; ruleId: number | null; followId: number | null },
    what:
      | {
          kind: "open";
          intent: string;
          decision: Extract<Decision, { action: "open" }> | { side: "long" | "short"; size: number; marginAusd: number; leverage: number; signal?: Record<string, unknown>; reason: string };
          price: number;
          worstPrice?: number;
          existing?: PositionRow;
        }
      | { kind: "close"; position: PositionRow; size?: number; reason: string; price: number },
  ): Promise<void> {
    const slip = this.opts.slippageBps / 10_000;
    const owner = lower(who.owner);
    if (what.kind === "open") {
      const d = what.decision;
      // Never above the market's limit or the venue's (an account's session order guard refuses
      // more). A lower leverage keeps the decision's margin and shrinks the size to match.
      const leverage = Math.min(d.leverage, market.maxLeverage, venue.maxLeverage);
      const size = leverage < d.leverage ? (d.size * leverage) / d.leverage : d.size;
      if (toSizeUnits(market, size) === 0n) {
        await this.db.audit(owner, "order_skipped", { reason: `size ${size} is below one ${market.symbol} size unit` }, who.ruleId, who.followId);
        return;
      }
      try {
        await venue.prepare(d.marginAusd);
      } catch (e) {
        await this.db.audit(owner, "funding_failed", { error: e instanceof Error ? e.message : String(e), marginAusd: d.marginAusd }, who.ruleId, who.followId);
        if (who.ruleId !== null && !(e instanceof VenueError && e.retryable)) await this.pauseById(who.ruleId, owner, `cannot fund the margin: ${e instanceof Error ? e.message : String(e)}`);
        return;
      }
      const requestId = await this.db.nextRequestId(lower(venue.owner), await venue.requestSeed());
      const { order, created } = await this.db.startOrder({
        intent: what.intent,
        owner,
        market: market.symbol,
        action: "open",
        side: d.side,
        size,
        worstPrice: d.side === "long" ? Math.min(what.price * (1 + slip), what.worstPrice ?? Infinity) : Math.max(what.price * (1 - slip), what.worstPrice ?? 0),
        leverage,
        requestId,
        reason: d.reason,
        position: what.existing ? { existingId: what.existing.id } : { ruleId: who.ruleId, followId: who.followId, signal: "signal" in d && d.signal ? (d.signal as Record<string, unknown>) : {} },
      });
      if (created) await this.submit(order, venue, market);
      return;
    }
    const p = what.position;
    const n = (await this.db.orderCount(p.id)) + 1;
    const size = Math.min(what.size ?? p.size, p.size);
    const { order, created } = await this.db.startOrder({
      intent: `position:${p.id}:${size < p.size ? "reduce" : "close"}:${n}`,
      owner,
      market: market.symbol,
      action: size < p.size ? "reduce" : "close",
      side: p.side,
      size,
      worstPrice: p.side === "long" ? what.price * (1 - slip) : what.price * (1 + slip),
      leverage: p.leverage,
      requestId: await this.db.nextRequestId(lower(venue.owner), await venue.requestSeed()),
      reason: what.reason,
      position: { existingId: p.id },
    });
    if (created) await this.submit(order, venue, market);
  }

  private async pauseById(ruleId: number, owner: string, reason: string) {
    await this.db.setRuleStatus(ruleId, "paused", reason);
    await this.db.audit(owner, "rule_paused", { reason, by: "autopilot" }, ruleId);
  }

  private async submit(order: OrderRow, venue: Venue, market: PerplMarket): Promise<void> {
    let sent: { txHash: `0x${string}` | null; fromBlock: bigint };
    try {
      sent = await venue.send({ market, action: order.action, side: order.side, size: order.size, leverage: order.leverage, worstPrice: order.worstPrice, requestId: order.requestId });
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      if (e instanceof VenueError && e.retryable) {
        const attempts = await this.db.orderRetry(order.id, message);
        await this.db.audit(order.owner, "order_retry", { orderId: order.id, attempts, error: message }, await this.ruleOf(order));
        return;
      }
      await this.finish(order, { status: "failed", error: message });
      return;
    }
    await this.db.orderSent(order.id, sent.txHash, sent.fromBlock);
    await this.db.audit(order.owner, "order_sent", { orderId: order.id, action: order.action, side: order.side, size: order.size, requestId: order.requestId.toString(), tx: sent.txHash, venue: venue.kind }, await this.ruleOf(order));
    const outcome = await this.awaitOutcome(order, venue, market, sent.txHash, sent.fromBlock);
    if (outcome) await this.applyOutcome(order, outcome);
  }

  private async ruleOf(o: OrderRow): Promise<number | null> {
    if (o.positionId === null) return null;
    const rows = await this.db.sql<{ rule_id: string | null }[]>`SELECT rule_id FROM autopilot_positions WHERE id = ${o.positionId}`;
    return rows[0]?.rule_id ? Number(rows[0].rule_id) : null;
  }

  private async awaitOutcome(o: OrderRow, venue: Venue, market: PerplMarket, txHash: `0x${string}` | null, fromBlock: bigint): Promise<OrderOutcome | null> {
    const accountId = await venue.accountId();
    if (!accountId) return null;
    const deadline = Date.now() + this.opts.fillTimeoutSec * 1000;
    while (Date.now() < deadline) {
      const out = txHash ? await this.chain.outcomeOfTx(txHash, accountId, o.requestId, market) : await this.chain.findOrder(accountId, o.requestId, market, fromBlock);
      // A session batch carries the order itself; its receipt answers at once.
      if (out || txHash) return out ?? { txHash: txHash!, blockNumber: 0n, filled: 0, price: null, marginAusd: 0, pnlAusd: 0, feeAusd: 0, failure: "the order left no trace in its transaction" };
      await sleep(this.opts.pollMs ?? 1500);
    }
    return null;
  }

  private async applyOutcome(o: OrderRow, out: OrderOutcome): Promise<void> {
    if (out.filled > 0) {
      await this.finish(o, { status: "filled", txHash: out.txHash, fillPrice: out.price, fillSize: out.filled, feeAusd: out.feeAusd, pnlAusd: out.pnlAusd, marginAusd: out.marginAusd });
    } else {
      await this.finish(o, { status: out.failure === "OrderDescIdTooLow" ? "failed" : "unfilled", txHash: out.txHash, error: out.failure ?? "no liquidity within the price limit" });
    }
  }

  private async finish(o: OrderRow, r: Parameters<ExecutorDb["orderDone"]>[1]): Promise<void> {
    await this.db.orderDone(o, { ...r, closeReason: o.reason ?? undefined });
    const ruleId = await this.ruleOf(o);
    await this.db.audit(o.owner, `order_${r.status}`, { orderId: o.id, action: o.action, side: o.side, price: r.fillPrice ?? null, size: r.fillSize ?? null, feeAusd: r.feeAusd ?? null, pnlAusd: r.pnlAusd ?? null, tx: r.txHash ?? null, error: r.error ?? null }, ruleId);
    this.log.info({ order: o.id, intent: o.intent, status: r.status, price: r.fillPrice, size: r.fillSize, error: r.error }, "order finished");
    if (r.status === "failed" && ruleId !== null && (await this.db.consecutiveFailures(ruleId)) >= this.opts.maxConsecutiveFailures) {
      await this.pauseById(ruleId, o.owner, `${this.opts.maxConsecutiveFailures} orders failed in a row: ${r.error ?? "unknown"}`);
    }
  }

  /** Finishes orders left in flight: resend ones never sent, find the result of ones sent. */
  private async resolve(o: OrderRow, ctx: TickContext): Promise<void> {
    const market = ctx.bySymbol.get(o.market);
    const venue = await this.venues.forOwner(o.owner);
    if (!market || !venue) {
      await this.finish(o, { status: "failed", error: !market ? "market closed" : "no venue for the account" });
      return;
    }
    if (o.status === "pending") {
      // Never confirmed sent: if an earlier attempt landed after all, its request id shows on chain.
      const accountId = await venue.accountId();
      const landed = accountId && o.fromBlock !== null ? await this.chain.findOrder(accountId, o.requestId, market, o.fromBlock) : null;
      if (landed) return this.applyOutcome(o, landed);
      if (o.attempts >= 5) return this.finish(o, { status: "failed", error: `gave up after ${o.attempts} attempts` });
      return this.submit(o, venue, market);
    }
    const out = await this.awaitOutcome(o, venue, market, o.txHash as `0x${string}` | null, o.fromBlock ?? 0n);
    if (out) return this.applyOutcome(o, out);
    // Sent through the API but never seen on chain within its lifetime: it expired.
    if (Date.now() - o.createdAt.getTime() > 120_000) await this.finish(o, { status: "unfilled", error: "the order never reached the chain" });
  }

  /** Positions the exchange closed or shrank without us: liquidations and manual trades. */
  private async reconcile(ctx: TickContext): Promise<void> {
    const live = await this.db.livePositions();
    const byOwner = new Map<string, PositionRow[]>();
    for (const p of live) byOwner.set(p.owner, [...(byOwner.get(p.owner) ?? []), p]);
    for (const [owner, positions] of byOwner) {
      // One owner's failure (a grant that does not open, an RPC error) leaves the others reconciled.
      await this.reconcileOwner(owner, positions, ctx).catch((e) => this.fail("reconcile", e, { owner }));
    }
  }

  private async reconcileOwner(owner: string, positions: PositionRow[], ctx: TickContext): Promise<void> {
    const venue = await this.venues.forOwner(owner);
    const id = venue ? await venue.accountId() : null;
    if (!id) return;
    const markets = positions.map((p) => ctx.bySymbol.get(p.market)).filter((m): m is PerplMarket => m !== undefined);
    const held = await this.chain.holdings(id, markets);
    for (const p of positions) {
      const h = held.get(p.market);
      const mark = ctx.marks.get(p.market) ?? null;
      if (!h || h.side !== p.side) {
        const estimate = mark !== null && p.entryPrice !== null ? (p.side === "long" ? mark - p.entryPrice : p.entryPrice - mark) * p.size - p.feesAusd : null;
        await this.db.closedExternally(p.id, mark, estimate, "closed outside Autopilot");
        await this.db.audit(owner, "position_closed_externally", { positionId: p.id, market: p.market, estimatedPnlAusd: estimate }, p.ruleId, p.followId);
      } else if (h.size < p.size * 0.999) {
        await this.db.adjustSize(p.id, h.size, h.marginAusd);
        await this.db.audit(owner, "position_reduced_externally", { positionId: p.id, from: p.size, to: h.size }, p.ruleId, p.followId);
      }
    }
  }
}

export interface TickContext {
  nowSec: number;
  kill: boolean;
  bySymbol: Map<string, PerplMarket>;
  marks: Map<string, number>;
}

export type { Address };
