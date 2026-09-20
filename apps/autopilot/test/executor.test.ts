import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import type { Rule } from "@trendr/autopilot";
import { Copier } from "../src/copier";
import type { ExecutorDb } from "../src/db";
import { Executor } from "../src/executor";
import { asChain, BTC, ETH, FakeChain, FakeVenue, FakeVenues, quiet, testDb, VenueError } from "./fakes";

const USER = "0x00000000000000000000000000000000000000a1" as const;
const LEADER = "0x00000000000000000000000000000000000000b2" as const;
const FOLLOWER = "0x00000000000000000000000000000000000000c3" as const;
const TREND = "0x00000000000000000000000000000000000000000000000000000000000000b7";
const T = 1_800_000_000;

const rule: Rule = {
  name: "BTC breakout",
  market: "BTC",
  trend: "crypto:btc",
  entry: { attentionChangePct: 20, windowMin: 60, minIndex: 0, smartMoney: "any", side: "long" },
  size: { marginAusd: 20, leverage: 2 },
  exits: { stopLossPct: 5, takeProfitPct: 4, maxHoldMin: 0 },
  limits: { maxPositionAusd: 100, maxDailyLossAusd: 30, cooldownMin: 0 },
};

let db: ExecutorDb;
let chain: FakeChain;
let venue: FakeVenue;
let executor: Executor;

async function addRule(r: Rule = rule, owner = USER): Promise<number> {
  const rows = await db.sql<{ id: string }[]>`
    INSERT INTO autopilot_rules (owner, rule, rule_hash, status, venue) VALUES (${owner}, ${db.sql.json(r as never)}, 'h', 'enabled', 'session') RETURNING id`;
  return Number(rows[0]!.id);
}
const audit = async (ruleId: number) => (await db.sql<{ event: string }[]>`SELECT event FROM autopilot_audit WHERE rule_id = ${ruleId} ORDER BY id`).map((r) => r.event);
const positions = (ruleId: number) => db.sql<{ status: string; size: number; entry_price: number; exit_price: number | null; pnl_ausd: number | null; fees_ausd: number; close_reason: string | null }[]>`
  SELECT status, size, entry_price, exit_price, pnl_ausd, fees_ausd, close_reason FROM autopilot_positions WHERE rule_id = ${ruleId} ORDER BY id`;

beforeAll(async () => {
  db = await testDb();
});
afterAll(async () => {
  await db.sql.end();
});
beforeEach(async () => {
  await db.sql`TRUNCATE autopilot_rules, autopilot_positions, autopilot_orders, autopilot_audit, autopilot_control, follows, leader_holdings, perpl_request_ids, index_points, index_sync RESTART IDENTITY CASCADE`;
  // Attention 40, then 60 from two hours before T: +50% over any one-hour window ending after it.
  await db.sql`INSERT INTO index_sync (trend_id, identifier, synced) VALUES (${TREND}, 'crypto:btc', 2)`;
  await db.sql`INSERT INTO index_points (trend_id, observed_at, points) VALUES (${TREND}, ${T - 90_000}, 40), (${TREND}, ${T - 1800}, 60)`;
  chain = new FakeChain();
  venue = new FakeVenue(USER, 7n, chain);
  executor = new Executor(db, asChain(chain), async () => [BTC, ETH], new FakeVenues(new Map([[USER, venue]])), { slippageBps: 50, fillTimeoutSec: 1, maxConsecutiveFailures: 3, killEnv: false, netflowMaxAgeSec: 43_200, pollMs: 5 }, quiet);
});

describe("rules", () => {
  test("open on the signal, hold, then take profit with PnL net of both fees", async () => {
    const id = await addRule();
    await executor.tick(T);
    expect(venue.sent).toHaveLength(1);
    expect(venue.sent[0]).toMatchObject({ action: "open", side: "long", leverage: 2, requestId: 1n });
    expect(venue.sent[0]!.size).toBeCloseTo(40 / 80_000);
    expect(venue.sent[0]!.worstPrice).toBeCloseTo(80_400);
    expect((await positions(id))[0]).toMatchObject({ status: "open", entry_price: 80_000 });

    chain.marksBy.set("BTC", 81_000);
    await executor.tick(T + 60);
    expect(venue.sent).toHaveLength(1);

    chain.marksBy.set("BTC", 83_300);
    await executor.tick(T + 120);
    expect(venue.sent[1]).toMatchObject({ action: "close", side: "long", requestId: 2n });
    const [p] = await positions(id);
    expect(p).toMatchObject({ status: "closed", exit_price: 83_300, close_reason: "take_profit" });
    const size = 40 / 80_000;
    const fees = (80_000 * size + 83_300 * size) * 0.0004;
    expect(p!.pnl_ausd).toBeCloseTo(3_300 * size - fees, 6);
    expect(p!.fees_ausd).toBeCloseTo(fees, 6);
    expect(await audit(id)).toEqual(["entry_signal", "order_sent", "order_filled", "waiting", "exit_signal", "order_sent", "order_filled"]);
  });

  test("a session opens at no more than its leverage cap, with the rule's margin and a smaller size", async () => {
    await addRule({ ...rule, size: { marginAusd: 20, leverage: 15 }, limits: { ...rule.limits, maxPositionAusd: 1000 } });
    await executor.tick(T);
    expect(venue.sent[0]).toMatchObject({ action: "open", leverage: 10 });
    // 20 AUSD of margin at 10x instead of 15x: 200 notional, not 300.
    expect(venue.sent[0]!.size).toBeCloseTo(200 / 80_000);
    const order = (await db.sql<{ leverage: number; size: number }[]>`SELECT leverage, size FROM autopilot_orders`)[0]!;
    expect(order).toMatchObject({ leverage: 10 });
    expect(order.size).toBeCloseTo(200 / 80_000);
  });

  test("the bot's venue is held to the market's limit alone", async () => {
    venue.maxLeverage = Number.POSITIVE_INFINITY;
    await addRule({ ...rule, size: { marginAusd: 20, leverage: 20 }, exits: { ...rule.exits, stopLossPct: 4 }, limits: { ...rule.limits, maxPositionAusd: 1000 } });
    await executor.tick(T);
    // BTC allows 15x on this market.
    expect(venue.sent[0]).toMatchObject({ action: "open", leverage: 15 });
    expect(venue.sent[0]!.size).toBeCloseTo(300 / 80_000);
  });

  test("a stop closes at a loss, and the daily loss limit then holds off new entries", async () => {
    const id = await addRule({ ...rule, limits: { ...rule.limits, maxDailyLossAusd: 1 } });
    await executor.tick(T);
    chain.marksBy.set("BTC", 75_000);
    await executor.tick(T + 60);
    const [p] = await positions(id);
    expect(p).toMatchObject({ status: "closed", close_reason: "stop" });
    expect(p!.pnl_ausd!).toBeLessThan(-2);
    await executor.tick(T + 120);
    expect(venue.sent).toHaveLength(2);
    expect((await audit(id)).at(-1)).toBe("waiting");
    const reason = (await db.sql<{ detail: { reason: string } }[]>`SELECT detail FROM autopilot_audit WHERE rule_id = ${id} ORDER BY id DESC LIMIT 1`)[0]!.detail.reason;
    expect(reason).toBe("daily loss limit reached");
  });

  test("a retryable failure leaves the order pending and the next tick sends it once", async () => {
    const id = await addRule();
    venue.failures.push(new VenueError("relayer unreachable", true));
    await executor.tick(T);
    expect(venue.sent).toHaveLength(0);
    const orders = await db.sql<{ status: string; attempts: number; request_id: string }[]>`SELECT status, attempts, request_id FROM autopilot_orders`;
    expect(orders[0]).toMatchObject({ status: "pending", attempts: 1 });
    await executor.tick(T + 15);
    // The same order and request id, not a second one.
    expect(venue.sent).toHaveLength(1);
    expect(venue.sent[0]!.requestId).toBe(BigInt(orders[0]!.request_id));
    expect((await positions(id))[0]!.status).toBe("open");
    expect(await db.sql`SELECT 1 FROM autopilot_orders`).toHaveLength(1);
  });

  test("repeated hard failures pause the rule", async () => {
    const id = await addRule();
    for (let i = 0; i < 3; i++) venue.failures.push(new VenueError("the batch reverted", false));
    for (let i = 0; i < 4; i++) await executor.tick(T + i * 15);
    const r = (await db.sql<{ status: string; status_reason: string }[]>`SELECT status, status_reason FROM autopilot_rules WHERE id = ${id}`)[0]!;
    expect(r.status).toBe("paused");
    expect(r.status_reason).toContain("3 orders failed in a row");
    expect(venue.sent).toHaveLength(0);
  });

  test("the kill switch closes positions and opens nothing", async () => {
    const id = await addRule();
    await executor.tick(T);
    await db.sql`INSERT INTO autopilot_control (key, value) VALUES ('kill', ${db.sql.json({ engaged: true, reason: "drill" } as never)})`;
    await executor.tick(T + 15);
    expect((await positions(id))[0]).toMatchObject({ status: "closed", close_reason: "kill" });
    await executor.tick(T + 30);
    expect(venue.sent).toHaveLength(2);
  });

  test("a position closed outside Autopilot is reconciled from chain", async () => {
    const id = await addRule({ ...rule, entry: { ...rule.entry, attentionChangePct: 500 } });
    await executor.tick(T);
    expect(venue.sent).toHaveLength(0);
    // Open by hand through a second rule that fires, then liquidate it on the fake chain.
    const firing = await addRule({ ...rule, name: "fires" });
    await executor.tick(T + 15);
    chain.books.get(7n)!.delete("BTC");
    await executor.tick(T + 30);
    const [p] = await positions(firing);
    expect(p).toMatchObject({ status: "closed", close_reason: "closed outside Autopilot" });
    expect(await audit(firing)).toContain("position_closed_externally");
    expect(await positions(id)).toHaveLength(0);
  });

  test("one position per market and account: a second rule on the same market waits", async () => {
    const a = await addRule();
    const b = await addRule({ ...rule, name: "second" });
    await executor.tick(T);
    expect(venue.sent).toHaveLength(1);
    expect((await positions(a))[0]!.status).toBe("open");
    expect(await positions(b)).toHaveLength(0);
    const reason = (await db.sql<{ detail: { reason: string } }[]>`SELECT detail FROM autopilot_audit WHERE rule_id = ${b} ORDER BY id DESC LIMIT 1`)[0]!.detail.reason;
    expect(reason).toBe("BTC already has a position on this account");
  });

  test("a paused rule manages its open position to the exit but opens no new one", async () => {
    const id = await addRule();
    await executor.tick(T);
    await db.sql`UPDATE autopilot_rules SET status = 'paused' WHERE id = ${id}`;
    chain.marksBy.set("BTC", 83_300);
    await executor.tick(T + 15);
    expect((await positions(id))[0]!.status).toBe("closed");
    chain.marksBy.set("BTC", 80_000);
    await executor.tick(T + 30);
    expect(venue.sent).toHaveLength(2);
  });
});

describe("copy-trading", () => {
  test("mirrors a leader's opens, reductions and closes, never their earlier positions", async () => {
    const follower = new FakeVenue(FOLLOWER, 9n, chain);
    chain.accounts.set(LEADER, 8n);
    chain.books.set(8n, new Map([["ETH", { side: "short", size: 2, entryPrice: 3_000, marginAusd: 600 }]]));
    const venues = new FakeVenues(new Map([[FOLLOWER, follower]]));
    const ex = new Executor(db, asChain(chain), async () => [BTC, ETH], venues, { slippageBps: 50, fillTimeoutSec: 1, maxConsecutiveFailures: 3, killEnv: false, netflowMaxAgeSec: 43_200, pollMs: 5 }, quiet);
    const copier = new Copier(db, asChain(chain), venues, ex, quiet);
    await db.sql`INSERT INTO autopilot_grants (owner, session_key, sealed_key, status, valid_until) VALUES (${FOLLOWER}, '0x1', 'x', 'active', ${T + 86_400})`;
    const settings = { mode: "ratio", ratio: 0.5, fixedMarginAusd: 0, maxMarginAusd: 50, maxLeverage: 3, maxDailyLossAusd: 20 };
    await db.sql`INSERT INTO follows (follower, leader, settings) VALUES (${FOLLOWER}, ${LEADER}, ${db.sql.json(settings as never)})`;
    const ctx = async () => ({ nowSec: T, kill: false, bySymbol: new Map([["BTC", BTC], ["ETH", ETH]]), marks: await chain.marks([BTC, ETH]) });

    // First snapshot: the ETH short predates the follow and is not copied.
    await copier.tick(await ctx());
    expect(follower.sent).toHaveLength(0);

    // The leader opens 0.01 BTC long at 5x (margin 160): half the size, leverage capped at 3.
    chain.books.get(8n)!.set("BTC", { side: "long", size: 0.01, entryPrice: 80_000, marginAusd: 160 });
    await copier.tick(await ctx());
    expect(follower.sent[0]).toMatchObject({ action: "open", side: "long", leverage: 3 });
    expect(follower.sent[0]!.size).toBeCloseTo(0.005);
    // A follow stored before slippage existed copies within the default 0.3% of the leader's fill.
    expect(follower.sent[0]!.worstPrice).toBeCloseTo(80_240);

    // The leader halves the position: the follower halves too.
    chain.books.get(8n)!.set("BTC", { side: "long", size: 0.005, entryPrice: 80_000, marginAusd: 80 });
    await copier.tick(await ctx());
    expect(follower.sent[1]).toMatchObject({ action: "reduce", side: "long" });
    expect(follower.sent[1]!.size).toBeCloseTo(0.0025);

    // The leader closes: the follower closes the rest.
    chain.books.get(8n)!.delete("BTC");
    await copier.tick(await ctx());
    expect(follower.sent[2]).toMatchObject({ action: "close", side: "long" });
    expect(follower.sent[2]!.size).toBeCloseTo(0.0025);
    const p = (await db.sql<{ status: string; follow_id: string }[]>`SELECT status, follow_id FROM autopilot_positions`)[0]!;
    expect(p.status).toBe("closed");
    const events = (await db.sql<{ event: string }[]>`SELECT event FROM autopilot_audit WHERE owner = ${LEADER} ORDER BY id`).map((r) => r.event);
    expect(events).toEqual(["leader_trade", "leader_trade", "leader_trade"]);
  });
});

describe("copy-trading protection", () => {
  let follower: FakeVenue;
  let copier: Copier;
  let followId: number;
  const ctx = async () => ({ nowSec: T, kill: false, bySymbol: new Map([["BTC", BTC], ["ETH", ETH]]), marks: await chain.marks([BTC, ETH]) });
  const follow = async () => (await db.sql<{ status: string; status_reason: string | null; closing_out: boolean }[]>`SELECT status, status_reason, closing_out FROM follows WHERE id = ${followId}`)[0]!;
  const followAudit = async () => db.sql<{ event: string; detail: Record<string, unknown> }[]>`SELECT event, detail FROM autopilot_audit WHERE follow_id = ${followId} ORDER BY id`;
  const copies = () => db.sql<{ status: string; market: string; close_reason: string | null }[]>`SELECT status, market, close_reason FROM autopilot_positions WHERE follow_id = ${followId} ORDER BY id`;
  const leaderOpens = (market: string, h: { side: "long" | "short"; size: number; entryPrice: number; marginAusd: number }) => chain.books.get(8n)!.set(market, h);

  beforeEach(async () => {
    follower = new FakeVenue(FOLLOWER, 9n, chain);
    chain.accounts.set(LEADER, 8n);
    chain.books.set(8n, new Map());
    const venues = new FakeVenues(new Map([[FOLLOWER, follower]]));
    const ex = new Executor(db, asChain(chain), async () => [BTC, ETH], venues, { slippageBps: 50, fillTimeoutSec: 1, maxConsecutiveFailures: 3, killEnv: false, netflowMaxAgeSec: 43_200, pollMs: 5 }, quiet);
    copier = new Copier(db, asChain(chain), venues, ex, quiet);
    await db.sql`INSERT INTO autopilot_grants (owner, session_key, sealed_key, status, valid_until) VALUES (${FOLLOWER}, '0x1', 'x', 'active', ${T + 86_400}) ON CONFLICT (owner) DO NOTHING`;
    const settings = { mode: "ratio", ratio: 1, fixedMarginAusd: 0, maxMarginAusd: 500, maxLeverage: 5, maxDailyLossAusd: 100, maxSlippagePct: 0.2, maxOpenLossAusd: 10 };
    followId = Number((await db.sql<{ id: string }[]>`INSERT INTO follows (follower, leader, settings) VALUES (${FOLLOWER}, ${LEADER}, ${db.sql.json(settings as never)}) RETURNING id`)[0]!.id);
    // The first snapshot: the leader is flat.
    await copier.tick(await ctx());
  });

  test("a leader at 20x is copied at the session's 10x cap, even when the follow allows more", async () => {
    await db.sql`UPDATE follows SET settings = jsonb_set(settings, '{maxLeverage}', '20') WHERE id = ${followId}`;
    // 0.01 BTC on 40 AUSD of margin: 20x.
    leaderOpens("BTC", { side: "long", size: 0.01, entryPrice: 80_000, marginAusd: 40 });
    await copier.tick(await ctx());
    expect(follower.sent[0]).toMatchObject({ action: "open", side: "long", leverage: 10 });
    // The ratio keeps the leader's size; the margin doubles to carry it at 10x.
    expect(follower.sent[0]!.size).toBeCloseTo(0.01);
    const copy = (await db.sql<{ leverage: number; margin_ausd: number }[]>`SELECT leverage, margin_ausd FROM autopilot_positions WHERE follow_id = ${followId}`)[0]!;
    expect(copy.leverage).toBe(10);
    expect(copy.margin_ausd).toBeCloseTo(80);
  });

  test("a copied opening is limited to the follow's slippage from the leader's fill, and skipped once the price ran past it", async () => {
    leaderOpens("BTC", { side: "long", size: 0.01, entryPrice: 80_000, marginAusd: 200 });
    chain.marksBy.set("BTC", 80_100);
    await copier.tick(await ctx());
    // 0.2% from the leader's 80,000 fill (80,160) is tighter than 0.2% from the 80,100 mark.
    expect(follower.sent[0]).toMatchObject({ action: "open", side: "long" });
    expect(follower.sent[0]!.worstPrice).toBeCloseTo(80_160);

    // The leader adds 0.01 at 81,000 (average 80,500) while the market already trades at 81,300.
    leaderOpens("BTC", { side: "long", size: 0.02, entryPrice: 80_500, marginAusd: 400 });
    chain.marksBy.set("BTC", 81_300);
    await copier.tick(await ctx());
    expect(follower.sent).toHaveLength(1);
    const skipped = (await followAudit()).filter((a) => a.event === "copy_skipped").at(-1)!;
    expect(skipped.detail.reason).toBe("the price moved 0.37% from the leader's fill, past your 0.2% limit");
  });

  test("open losses past the loss cap close every copy, pause the follow and say why", async () => {
    leaderOpens("BTC", { side: "long", size: 0.01, entryPrice: 80_000, marginAusd: 200 });
    leaderOpens("ETH", { side: "short", size: 0.1, entryPrice: 3_000, marginAusd: 100 });
    await copier.tick(await ctx());
    expect(follower.sent.map((o) => o.action)).toEqual(["open", "open"]);

    // BTC falls 1%: the BTC copy is down 8, ETH flat. Under the 10 AUSD cap: nothing happens.
    chain.marksBy.set("BTC", 79_200);
    await copier.tick(await ctx());
    expect(follower.sent).toHaveLength(2);
    expect((await follow()).status).toBe("active");

    // ETH rises too: together the copies are down 8 + 3 = 11. The first close does not go through.
    chain.marksBy.set("ETH", 3_030);
    follower.failures.push(new VenueError("the batch reverted", false));
    await copier.tick(await ctx());
    expect(await follow()).toMatchObject({ status: "paused", closing_out: true, status_reason: "Paused at your loss cap: open copies were down 11.00 AUSD (cap 10.00 AUSD), so Autopilot closed them." });
    const cap = (await followAudit()).find((a) => a.event === "copy_loss_cap")!;
    expect(cap.detail).toMatchObject({ leader: LEADER, capAusd: 10, positions: 2 });
    expect(cap.detail.openPnlAusd as number).toBeCloseTo(-11);
    expect((await copies()).map((p) => p.status)).toEqual(["open", "closed"]);

    // The leader adds to BTC meanwhile: a paused follow copies nothing, and the close is sent again.
    leaderOpens("BTC", { side: "long", size: 0.02, entryPrice: 79_600, marginAusd: 400 });
    await copier.tick(await ctx());
    expect(follower.sent.slice(2).map((o) => o.action)).toEqual(["close", "close"]);
    expect((await copies()).map((p) => [p.status, p.close_reason])).toEqual([
      ["closed", "loss_cap"],
      ["closed", "loss_cap"],
    ]);
    expect((await follow()).closing_out).toBe(true);

    // Nothing left to close: the close-out ends; the follow stays paused until the owner resumes it.
    await copier.tick(await ctx());
    expect(await follow()).toMatchObject({ status: "paused", closing_out: false });
    expect(follower.sent).toHaveLength(4);
    expect((await followAudit()).filter((a) => a.event === "copy_loss_cap")).toHaveLength(1);
  });

  test("open losses count against the daily loss limit", async () => {
    await db.sql`UPDATE follows SET settings = settings || '{"maxDailyLossAusd": 6, "maxOpenLossAusd": 50}'::jsonb WHERE id = ${followId}`;
    leaderOpens("BTC", { side: "long", size: 0.01, entryPrice: 80_000, marginAusd: 200 });
    await copier.tick(await ctx());
    chain.marksBy.set("BTC", 79_200);
    await copier.tick(await ctx());
    // Down 8 on the open BTC copy and nothing realized: a new ETH opening is not copied.
    leaderOpens("ETH", { side: "short", size: 0.1, entryPrice: 3_000, marginAusd: 100 });
    await copier.tick(await ctx());
    expect(follower.sent).toHaveLength(1);
    expect((await followAudit()).filter((a) => a.event === "copy_skipped").at(-1)!.detail.reason).toBe("daily loss limit reached");
  });
});

describe("trend listings", () => {
  test("a rule follows its topic to the newest listing, by exact identifier", async () => {
    const tid = (n: number) => `0x${n.toString(16).padStart(64, "0")}`;
    // The retired first listing synced last; an unrelated trend shares the prefix.
    await db.sql`INSERT INTO index_sync (trend_id, identifier, synced) VALUES (${tid(2)}, 'crypto:btc.2', 1), (${tid(3)}, 'crypto:btc.com', 1)`;
    await db.sql`UPDATE index_sync SET updated_at = now() + interval '1 hour' WHERE identifier = 'crypto:btc'`;
    expect(await db.trendIdOf("crypto:btc")).toBe(tid(2));
    expect(await db.trendIdOf("crypto:btc.2")).toBe(tid(2));
    expect(await db.trendIdOf("crypto:btc.com")).toBe(tid(3));
    expect(await db.trendIdOf("crypto:eth")).toBeNull();
  });
});
