import { type Change, diffHolding, type Holding, lossCapReached, mirror, openPnl } from "@trendr/autopilot";
import type { ExecutorDb, FollowRow } from "./db";
import type { Executor, Log, TickContext, VenueResolver } from "./executor";
import type { PerplChain } from "./perpl-chain";

/**
 * Copy-trading. Each tick first enforces loss caps, then snapshots every followed leader's Perpl
 * positions from chain, diffs them against the last snapshot, and turns each change into an order
 * for each follower, sized and capped by that follower's settings and its venue's leverage cap. A leader's first snapshot is
 * only recorded: positions opened before someone followed are not copied. A copied opening never
 * fills worse than the follow's slippage from the leader's own fill (and the mark), so a leader
 * cannot sell to followers far above where they bought.
 */

const money = (v: number) => `${v < 0 ? "-" : ""}${Math.abs(v).toFixed(2)} AUSD`;

export class Copier {
  constructor(
    private readonly db: ExecutorDb,
    private readonly chain: PerplChain,
    private readonly venues: VenueResolver,
    private readonly executor: Executor,
    private readonly log: Log,
  ) {}

  async tick(ctx: TickContext): Promise<void> {
    await this.guard(ctx).catch((e) => this.log.error({ err: e instanceof Error ? e.message : String(e) }, "copy loss caps failed"));
    const follows = await this.db.activeFollows();
    const byLeader = new Map<string, FollowRow[]>();
    for (const f of follows) byLeader.set(f.leader, [...(byLeader.get(f.leader) ?? []), f]);
    const markets = [...ctx.bySymbol.values()];
    for (const [leader, followers] of byLeader) {
      try {
        const account = await this.chain.account(leader as `0x${string}`);
        const now = account ? await this.chain.holdings(account.id, markets) : new Map();
        const holdings = new Map<string, Holding>([...now].map(([m, h]) => [m, { side: h.side, size: h.size, marginAusd: h.marginAusd, entryPrice: h.entryPrice }]));
        const before = await this.db.leaderHoldings(leader);
        if (before !== null) {
          for (const m of markets) {
            const price = ctx.marks.get(m.symbol);
            if (!price) continue;
            for (const change of diffHolding(m.symbol, before.get(m.symbol) ?? null, holdings.get(m.symbol) ?? null, price)) {
              await this.db.audit(leader, "leader_trade", { change }, null, null);
              for (const f of followers) await this.copy(f, change, ctx, price).catch((e) => this.log.error({ follow: f.id, err: e instanceof Error ? e.message : String(e) }, "copy failed"));
            }
          }
        }
        await this.db.saveLeaderHoldings(leader, markets.map((m) => m.symbol), holdings);
      } catch (e) {
        this.log.error({ leader, err: e instanceof Error ? e.message : String(e) }, "leader snapshot failed");
      }
    }
  }

  /**
   * Loss caps. A follow whose open copies are down its cap together is paused and closed out: each
   * open copy closes at the market, and closes that do not fill are sent again on the next tick
   * until none is left. Closing out goes on through the kill switch, a pause or an unfollow, since
   * it only ever reduces risk.
   */
  private async guard(ctx: TickContext): Promise<void> {
    for (const f of await this.db.followsToGuard()) {
      try {
        const live = await this.db.followPositions(f.id);
        if (!f.closingOut) {
          const pnl = openPnl(live, ctx.marks);
          if (!lossCapReached(f.settings, pnl)) continue;
          const reason = `Paused at your loss cap: open copies were down ${money(-pnl)} (cap ${money(f.settings.maxOpenLossAusd)}), so Autopilot closed them.`;
          if (!(await this.db.startCloseOut(f.id, reason))) continue;
          await this.db.audit(f.follower, "copy_loss_cap", { leader: f.leader, openPnlAusd: pnl, capAusd: f.settings.maxOpenLossAusd, positions: live.length }, null, f.id);
          this.log.warn({ follow: f.id, follower: f.follower, openPnlAusd: pnl, capAusd: f.settings.maxOpenLossAusd }, "copy loss cap reached");
        }
        if (live.length === 0) {
          await this.db.endCloseOut(f.id);
          continue;
        }
        const venue = await this.venues.forOwner(f.follower);
        if (!venue) continue;
        for (const p of live) {
          const market = ctx.bySymbol.get(p.market);
          const price = ctx.marks.get(p.market);
          // An order in flight is settled by the executor first; a market without a price waits.
          if (p.status !== "open" || !market || !price) continue;
          await this.executor.place(venue, market, { owner: f.follower, ruleId: null, followId: f.id }, { kind: "close", position: p, reason: "loss_cap", price });
        }
      } catch (e) {
        this.log.error({ follow: f.id, err: e instanceof Error ? e.message : String(e) }, "copy loss cap check failed");
      }
    }
  }

  private async copy(f: FollowRow, change: Change, ctx: TickContext, price: number): Promise<void> {
    if (ctx.kill && (change.kind === "open" || change.kind === "increase")) {
      await this.db.audit(f.follower, "copy_skipped", { change, reason: "kill switch engaged" }, null, f.id);
      return;
    }
    const venue = await this.venues.forOwner(f.follower);
    if (!venue) return;
    const market = ctx.bySymbol.get(change.market)!;
    const held = await this.db.livePosition({ followId: f.id, market: change.market });
    if (held && held.status !== "open") return;
    const holding: Holding | null = held ? { side: held.side, size: held.size, marginAusd: held.marginAusd } : null;
    const order = mirror(change, f.settings, holding, {
      price,
      realizedTodayAusd: await this.db.realizedToday({ followId: f.id }),
      openPnlAusd: openPnl(await this.db.followPositions(f.id), ctx.marks),
      maxLeverage: Math.min(market.maxLeverage, venue.maxLeverage),
    });
    if (order.action === "skip") {
      await this.db.audit(f.follower, "copy_skipped", { change, reason: order.reason }, null, f.id);
      return;
    }
    const who = { owner: f.follower, ruleId: null, followId: f.id };
    if (order.action === "reduce") {
      await this.executor.place(venue, market, who, { kind: "close", position: held!, size: order.size, reason: `copied ${change.kind}`, price });
      return;
    }
    if (!held && (await this.executor.marketBusy(f.follower, change.market, venue))) {
      await this.db.audit(f.follower, "copy_skipped", { change, reason: `${change.market} already has a position on this account` }, null, f.id);
      return;
    }
    const seq = (await this.db.sql<{ n: number }[]>`SELECT count(*)::int AS n FROM autopilot_orders o JOIN autopilot_positions p ON p.id = o.position_id WHERE p.follow_id = ${f.id}`)[0]?.n ?? 0;
    await this.executor.place(venue, market, who, {
      kind: "open",
      intent: `follow:${f.id}:${change.market}:${seq + 1}`,
      decision: {
        side: order.side,
        size: order.size,
        marginAusd: order.marginAusd,
        leverage: order.leverage,
        reason: `copied ${change.kind} of ${f.leader}`,
        signal: { leader: f.leader, change, worstPrice: order.worstPrice },
      },
      price,
      worstPrice: order.worstPrice,
      existing: held ?? undefined,
    });
  }
}
