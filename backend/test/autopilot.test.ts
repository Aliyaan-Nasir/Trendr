import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { generateSealKeyPair, open, seal } from "@trendr/autopilot";
import { deployments, type OwnerChallenge, type OwnerRequest, ownerRequests } from "@trendr/contracts";
import { PERPL_NETWORKS } from "@trendr/perpl";
import { type Address, getAddress, verifyMessage, zeroAddress } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { Ai } from "../src/ai/providers";
import { adminMessage, issueSession } from "../src/api/admin-auth";
import { createApp } from "../src/api/app";
import { MAX_BACKTESTS_PER_HOUR } from "../src/autopilot/routes";
import { signInMessage } from "../src/api/user-auth";
import { linkMessage } from "../src/social/routes";
import { AutopilotService } from "../src/autopilot/service";
import { AutopilotStore } from "../src/autopilot/store";
import type { ChainReader, ChainTrend } from "../src/chain";
import { Collector } from "../src/collector";
import { loadConfig } from "../src/config";
import type { Sql } from "../src/db";
import { IndexHistory } from "../src/history";
import type { Jobs } from "../src/jobs";
import { DEFAULT_RADAR, Radar } from "../src/radar";
import { Gdelt } from "../src/sources/gdelt";
import { Wikipedia } from "../src/sources/wikipedia";
import { Push } from "../src/notify/push";
import { Store } from "../src/store";
import { fakeFetch, json, quietLog, testDb } from "./helpers";
import { type TestPasskey, testPasskey } from "./passkey";

const user = privateKeyToAccount("0x8b3a350cf5c34c9194ca85829a2df0ec3153be0318b5e2d3348e872092edffba");
const other = privateKeyToAccount("0x92db14e403b83dfe3df233f83dfa3a0d7096f21ca9b0d6d6b8d88b2b4ec1564e");
const session = privateKeyToAccount("0x4bbbf85ce3377467afe5d46f804f221813b2bb87f24d81f60f1fcdbf7cbf4356");
const admin = privateKeyToAccount("0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d");
const BOT = "0x6cfacb4c9a1b63cbc87750ec471ce194bfea0211";
const TOKEN = "test-oracle-token-0123456789";
const NONCE = "test-nonce-0123456789";
const T = 1_800_000_000;

let sql: Sql;
let app: ReturnType<typeof createApp>;
let now = T * 1000;
let sealKeys: { privateKey: string; publicKey: string };
/** Every test account's owner passkey (one key stands in for all of them). */
let passkey: TestPasskey;
/**
 * On-chain session state the fake client reports, per account and key: `permitted` for Perpl
 * orders, `trading` for the app's trading calls (outcome sets, perps, coins, spot).
 */
const sessions = new Map<string, { active: boolean; validUntil: bigint; dailyLimit: bigint; permitted: boolean; trading?: boolean; guard?: Address }>();
/** When set, every session read fails the way an unreachable RPC does. */
let rpcDown = false;

const btcTrend: ChainTrend = {
  id: "0x00000000000000000000000000000000000000000000000000000000000000b7",
  identifier: "crypto:btc",
  assetClass: 0,
  status: "Active",
  createdAt: T - 86_400,
  updatedAt: T,
  statusSince: T - 86_400,
  index: 50,
  peakIndex: 60,
  surfacer: "0x0000000000000000000000000000000000000000",
};

const rule = {
  name: "BTC attention breakout",
  market: "BTC",
  trend: "crypto:btc",
  entry: { attentionChangePct: 20, windowMin: 60, side: "long" },
  size: { marginAusd: 20, leverage: 2 },
  exits: { stopLossPct: 5, takeProfitPct: 4 },
  limits: { maxPositionAusd: 100, maxDailyLossAusd: 30, cooldownMin: 0 },
};

const context = {
  instances: [{ id: 12, min_account_open_amount: "100000000", min_deposit_amount: "10000000" }],
  markets: [{ perpetual_id: 16, name: "BTC Perp", symbol: "BTC", config: { initial_margin: 1500, maintenance_margin: 2500, price_decimals: 1, size_decimals: 5, is_open: true }, order_ttl_blocks: 20 }],
};
// Five-minute candles from a day ago: flat at 80,000, then a 5% rally two hours before T.
const candles = Array.from({ length: 288 }, (_, i) => {
  const t = T - 86_400 + i * 300;
  const c = t >= T - 7200 ? 84_000 : 80_000;
  return { t: t * 1000, o: c * 10, h: c * 10, l: c * 10, c: c * 10, v: "0", n: 1 };
});

beforeAll(async () => {
  sql = await testDb();
  await sql`TRUNCATE index_points, index_sync, autopilot_rules, autopilot_backtests, autopilot_grants, autopilot_grant_keys, autopilot_positions, autopilot_orders, autopilot_audit, autopilot_control, follows, leader_holdings RESTART IDENTITY CASCADE`;
  sealKeys = await generateSealKeyPair();
  passkey = await testPasskey();
  const cfg = loadConfig({
    DATABASE_URL: "postgres://unused",
    MONAD_RPC_URL: "https://rpc.example.org",
    ORACLE_TOKEN: TOKEN,
    ADMIN_ADDRESSES: admin.address,
    AUTOPILOT_SEAL_PUBLIC_KEY: sealKeys.publicKey,
    AUTOPILOT_BOT_ADDRESS: BOT,
  });
  const client = {
    verifyMessage,
    readContract: async ({ functionName, address, args }: { functionName: string; address: string; args: readonly unknown[] }) => {
      if (rpcDown) throw new Error("fetch failed");
      if (functionName === "owner") return passkey.owner;
      // A delegated account answers zeros for keys it never added.
      const s = sessions.get(`${address.toLowerCase()}:${String(args[0]).toLowerCase()}`) ?? { active: false, validUntil: 0n, dailyLimit: 0n, permitted: false, trading: false };
      if (functionName === "sessionOf") return { active: s.active, validUntil: s.validUntil, dailyLimit: s.dailyLimit, day: 0, spentToday: 0n, nonce: 0n };
      if (functionName === "isPermitted") return String(args[1]).toLowerCase() === cfg.deployment.perplExchange.toLowerCase() ? s.permitted : (s.trading ?? false);
      // Grants made by the app name the order guard on their Perpl orders.
      if (functionName === "guardOf") return s.permitted ? (s.guard ?? cfg.deployment.perplOrderGuard) : zeroAddress;
      throw new Error(`unexpected read ${functionName}`);
    },
  };
  const chain = { trends: async () => [btcTrend], lastRunId: async () => 0n, client, deployment: cfg.deployment } as unknown as ChainReader;
  const f = fakeFetch([
    [/\/v1\/pub\/context/, () => json(context)],
    [/\/candles\/300\//, () => json({ d: candles })],
    [/\/market-data\/16\/ticker/, () => json({ d: { "16": { at: { b: 7, t: T * 1000 }, orl: 800_000, mrk: 800_010, lst: 800_005, bid: 800_000, ask: 800_020 } } })],
  ]);
  const store = new Store(sql);
  const wikipedia = new Wikipedia("Bot/1.0 (https://example.org)", "en.wikipedia", f.impl);
  const ai = new Ai([]);
  const radar = new Radar(store, null, wikipedia, ai, { ...DEFAULT_RADAR, narrativesEvery: 4, autoApproveConfidence: 0.8 }, quietLog);
  const gdelt = new Gdelt(f.impl);
  const collector = new Collector(store, chain, { elfa: null, gdelt, nansen: null, wikipedia }, { elfaRefreshSec: 1, gdeltRefreshSec: 1, nansenRefreshSec: 1, wikipediaRefreshSec: 1, elfaRadarCreditsPerDay: 0, maxGdeltPerTick: 0, maxWikipediaPerTick: 0 }, quietLog);
  const history = new IndexHistory(sql, chain);
  const autopilot = { store: new AutopilotStore(sql), service: new AutopilotService(sql, chain, history, PERPL_NETWORKS[10143]!, { takerFeeBps: 4, slippageBps: 5 }, f.impl) };
  app = createApp({ cfg, store, chain, collector, radar, ai, gdelt, rings: { elfa: null, nansen: null }, jobs: {} as Jobs, adminSessionSecret: "s".repeat(64), history, autopilot, push: new Push(sql, null), faucet: null, log: quietLog, now: () => now });
  // Attention: 40 for the first hours, 60 from three hours before T.
  await sql`INSERT INTO index_points (trend_id, observed_at, points) VALUES (${btcTrend.id}, ${T - 90_000}, 40), (${btcTrend.id}, ${T - 10_800}, 60)`;
});
afterAll(async () => {
  await sql.end();
});
beforeEach(() => {
  now = T * 1000;
  rpcDown = false;
});

async function signIn(account = user, signer = user): Promise<string> {
  const issuedAt = Math.floor(now / 1000);
  const signature = await signer.signMessage({ message: signInMessage(account.address, signer.address, issuedAt) });
  const res = await app.request("/v1/auth/session", { method: "POST", body: JSON.stringify({ account: account.address, signer: signer.address, issuedAt, signature }) });
  const body = (await res.json()) as { token?: string; error?: string };
  if (!body.token) throw new Error(body.error);
  return body.token;
}
const call = (token: string, method: string, path: string, body?: unknown) =>
  app.request(path, { method, headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
/** The account passkey's approval of `request`, with a nonce asked for with `token`. */
async function approval(token: string, account: { address: `0x${string}` }, request: OwnerRequest) {
  const res = await call(token, "POST", "/v1/owner-approvals", { action: request.action });
  if (res.status !== 200) throw new Error(((await res.json()) as { error: string }).error);
  return passkey.approve(account.address, request, (await res.json()) as OwnerChallenge);
}
/**
 * Asks for a grant the way the app does: a fresh key made on the device, sealed to the executor key
 * the server publishes and bound to the account and the key. The server only ever sees the box.
 */
async function requestGrant(token: string, owner: { address: string }, overrides: Record<string, unknown> = {}) {
  const { publicKey } = (await (await app.request("/v1/autopilot/grant/seal-key")).json()) as { publicKey: string };
  const key = generatePrivateKey();
  const account = privateKeyToAccount(key);
  const sealedKey = await seal(key, publicKey, { owner: owner.address.toLowerCase(), sessionKey: account.address.toLowerCase() });
  const res = await call(token, "POST", "/v1/autopilot/grant", { dailyLimit: "100000000", validDays: 7, sessionKey: account.address, sealedKey, ...overrides });
  return { account, sealedKey, res };
}
/** Opens a stored grant box as the executor does. */
const openGrant = async (owner: string, row: { session_key: string; sealed_key: string }) =>
  privateKeyToAccount((await open(row.sealed_key, sealKeys.privateKey, { owner, sessionKey: row.session_key })) as `0x${string}`).address.toLowerCase();
/** Enables a rule the way the app does: the rule as stored, approved by the passkey. */
async function enable(token: string, id: number, account: { address: `0x${string}` } = user) {
  const { rule: r } = (await (await call(token, "GET", `/v1/autopilot/rules/${id}`)).json()) as { rule: { ruleHash: string } };
  return call(token, "POST", `/v1/autopilot/rules/${id}/status`, { status: "enabled", ruleHash: r.ruleHash, approval: await approval(token, account, ownerRequests.enableRule(id, r.ruleHash)) });
}
async function asAdmin(method: string, path: string, body = "") {
  // Each signed request is single-use, and identical requests in the same second sign identically.
  now += 1000;
  const ts = Math.floor(now / 1000);
  const signature = await admin.signMessage({ message: adminMessage(method, path, ts, NONCE, body) });
  return app.request(path, { method, headers: { "x-trendr-address": admin.address, "x-trendr-timestamp": String(ts), "x-trendr-nonce": NONCE, "x-trendr-signature": signature, "content-type": "application/json" }, ...(body ? { body } : {}) });
}

describe("sign-in", () => {
  test("with the account key or an active session key, never someone else's", async () => {
    expect(await signIn()).toBeString();
    sessions.set(`${user.address.toLowerCase()}:${session.address.toLowerCase()}`, { active: true, validUntil: BigInt(T + 3600), dailyLimit: 0n, permitted: false, trading: true });
    const viaSession = await signIn(user, session);
    // A session ending in an hour caps the token at an hour, and the token names the key that signed.
    const [role, account, expiry, , signer] = Buffer.from(viaSession.split(".")[0]!, "base64url").toString().split(".");
    expect([role, account, Number(expiry), signer]).toEqual(["user", user.address.toLowerCase(), T + 3600, session.address.toLowerCase()]);
    await expect(signIn(user, other)).rejects.toThrow("not an active session");
    const res = await call(viaSession, "GET", "/v1/autopilot/rules");
    expect(res.status).toBe(200);
    // An admin token is not a user token.
    const adminSession = (await (await asAdmin("POST", "/v1/admin/session")).json()) as { token: string };
    // Signing out ends the app token too.
    const temp = await signIn();
    expect((await call(temp, "POST", "/v1/auth/session/revoke")).status).toBe(200);
    expect((await call(temp, "GET", "/v1/autopilot/rules")).status).toBe(401);
    expect((await call(adminSession.token, "GET", "/v1/autopilot/rules")).status).toBe(401);
  });
});

describe("session keys", () => {
  const trading = privateKeyToAccount("0x1d8a1b1c3c5b5e2a9c2e4f0d6a7b8c9d0e1f2a3b4c5d6e7f8091a2b3c4d5e6f7");
  const perplOnly = privateKeyToAccount("0x2e9b2c2d4d6c6f3b0d3f5a1e7b8c9d0e1f2a3b4c5d6e7f8091a2b3c4d5e6f708");
  const key = (k: { address: string }) => `${user.address.toLowerCase()}:${k.address.toLowerCase()}`;

  test("Autopilot's grant keys and Perpl-only sessions cannot sign in, even replaced ones", async () => {
    const token = await signIn();
    const grantKey = async () => (await requestGrant(token, user)).account;
    const first = await grantKey();
    // Even granted every permission on chain, the executor's key never signs in as the account.
    sessions.set(key(first), { active: true, validUntil: BigInt(T + 86_400), dailyLimit: 1n, permitted: true, trading: true });
    await expect(signIn(user, first)).rejects.toThrow("Autopilot's session key cannot sign in");
    // A new grant replaces the row; the old key stays refused.
    const second = await grantKey();
    expect(second.address).not.toBe(first.address);
    await expect(signIn(user, first)).rejects.toThrow("Autopilot's session key cannot sign in");
    // Any session holding Perpl permissions only is not the app's trading session.
    sessions.set(key(perplOnly), { active: true, validUntil: BigInt(T + 86_400), dailyLimit: 1n, permitted: true, trading: false });
    await expect(signIn(user, perplOnly)).rejects.toThrow("only the app's trading session can sign in");
    // Identity links need the passkey, so a session key's signature is refused there too.
    const issuedAt = T;
    const message = linkMessage(other.address, user.address, issuedAt);
    const link = await app.request("/v1/callers/link", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ identity: other.address, account: user.address, signer: first.address, issuedAt, identitySignature: await other.signMessage({ message }), accountSignature: await first.signMessage({ message }) }),
    });
    expect(link.status).toBe(403);
  });

  test("a token ends once its session key is revoked on chain, within the cache window", async () => {
    sessions.set(key(trading), { active: true, validUntil: BigInt(T + 86_400), dailyLimit: 1n, permitted: false, trading: true });
    const token = await signIn(user, trading);
    expect((await call(token, "GET", "/v1/autopilot/rules")).status).toBe(200);
    sessions.set(key(trading), { active: false, validUntil: BigInt(T + 86_400), dailyLimit: 1n, permitted: false, trading: true });
    // The answer read at sign-in stands for 30 seconds.
    now += 29_000;
    expect((await call(token, "GET", "/v1/autopilot/rules")).status).toBe(200);
    now += 2_000;
    const res = await call(token, "GET", "/v1/autopilot/rules");
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "the session key that signed in is no longer active; sign in again" });
    // The account's own key needs no chain read.
    rpcDown = true;
    expect((await call(await signIn(), "GET", "/v1/autopilot/rules")).status).toBe(200);
  });

  test("an unreachable chain answers 503, never a sign-out", async () => {
    sessions.set(key(trading), { active: true, validUntil: BigInt(T + 86_400), dailyLimit: 1n, permitted: false, trading: true });
    const token = await signIn(user, trading);
    now += 31_000;
    rpcDown = true;
    expect((await call(token, "GET", "/v1/autopilot/rules")).status).toBe(503);
    const issuedAt = Math.floor(now / 1000);
    const signature = await trading.signMessage({ message: signInMessage(user.address, trading.address, issuedAt) });
    const res = await app.request("/v1/auth/session", { method: "POST", body: JSON.stringify({ account: user.address, signer: trading.address, issuedAt, signature }) });
    expect(res.status).toBe(503);
    rpcDown = false;
    expect((await call(token, "GET", "/v1/autopilot/rules")).status).toBe(200);
  });

  test("tokens without a signer (issued before signers were recorded) are refused", async () => {
    const legacy = issueSession("s".repeat(64), user.address, T + 3600, "user");
    expect((await call(legacy, "GET", "/v1/autopilot/rules")).status).toBe(401);
  });
});

describe("perpl", () => {
  test("markets and tickers are public; request ids are sequential per account and shared with the executor", async () => {
    const markets = (await (await app.request("/v1/perpl/markets")).json()) as { markets: Array<{ id: number; symbol: string; orderTtlBlocks: number; maintenanceMargin: number }>; minAccountOpen: string; minDeposit: string };
    expect(markets.markets).toEqual([expect.objectContaining({ id: 16, symbol: "BTC", orderTtlBlocks: 20, maintenanceMargin: 0.04 })]);
    expect(markets).toMatchObject({ minAccountOpen: "100000000", minDeposit: "10000000" });
    const ticker = (await (await app.request("/v1/perpl/markets/16/ticker")).json()) as { ticker: { mark: number; bid: number; ask: number } };
    expect(ticker.ticker).toMatchObject({ mark: 80_001, bid: 80_000, ask: 80_002 });
    expect((await app.request("/v1/perpl/markets/99/ticker")).status).toBe(404);

    expect((await app.request("/v1/perpl/request-id", { method: "POST" })).status).toBe(401);
    await sql`DELETE FROM perpl_request_ids WHERE owner = ${user.address.toLowerCase()}`;
    const token = await signIn();
    const next = async () => ((await (await call(token, "POST", "/v1/perpl/request-id", {})).json()) as { requestId: string }).requestId;
    expect(await next()).toBe("1");
    expect(await next()).toBe("2");
    // The executor's allocation (GREATEST(last, seed) + 1) continues the same sequence.
    await sql`UPDATE perpl_request_ids SET last_id = GREATEST(last_id, 0) + 1 WHERE owner = ${user.address.toLowerCase()}`;
    expect(await next()).toBe("4");
  });
});

describe("rules", () => {
  test("validate, backtest and refuse to enable until backtested and granted", async () => {
    const token = await signIn();
    expect((await call(token, "POST", "/v1/autopilot/rules", { rule: { ...rule, size: { marginAusd: 20, leverage: 30 } } })).status).toBe(400);
    // Accounts' rules open through the session's order guard: at most its 10x cap.
    const at15 = { ...rule, size: { marginAusd: 20, leverage: 15 }, exits: { ...rule.exits, stopLossPct: 5 }, limits: { ...rule.limits, maxPositionAusd: 1000 } };
    for (const [method, path] of [["POST", "/v1/autopilot/rules"], ["POST", "/v1/autopilot/backtests"]] as const) {
      const over = await call(token, method, path, { rule: at15, days: 1 });
      expect(over.status).toBe(400);
      expect(((await over.json()) as { error: string }).error).toBe("size.leverage: Autopilot opens positions from your account at up to 10x; lower the leverage");
    }
    expect(((await (await call(token, "POST", "/v1/autopilot/rules", { rule: { ...rule, market: "DOGE" } })).json()) as { error: string }).error).toContain("no open DOGE market");
    const created = (await (await call(token, "POST", "/v1/autopilot/rules", { rule })).json()) as { rule: { id: number; status: string } };
    expect(created.rule.status).toBe("draft");
    const id = created.rule.id;

    expect(((await (await call(token, "POST", `/v1/autopilot/rules/${id}/status`, { status: "enabled" })).json()) as { error: string }).error).toContain("backtest this exact rule first");

    const bt = (await (await call(token, "POST", "/v1/autopilot/backtests", { rule, days: 1 })).json()) as { result: { trades: Array<{ reason: string }>; stats: { trades: number }; resolutionSec: number } };
    // Attention jumped 50% three hours before T; the price rallied 5% two hours before T: take-profit.
    expect(bt.result.resolutionSec).toBe(300);
    expect(bt.result.trades[0]?.reason).toBe("take_profit");

    expect(((await (await call(token, "POST", `/v1/autopilot/rules/${id}/status`, { status: "enabled" })).json()) as { error: string }).error).toContain("grant Autopilot access");

    // Grant: the app makes the key and seals it; the server stores the box only the executor opens.
    const requested = await requestGrant(token, user);
    const grant = (await requested.res.json()) as { session: { key: string; validUntil: number; permissions: unknown[] } };
    expect(grant.session.key).toBe(requested.account.address);
    expect(grant.session.permissions.length).toBeGreaterThan(0);
    // The session the app adds routes Perpl orders through the order guard.
    const guard = deployments[10143]!.perplOrderGuard;
    expect((grant.session.permissions as Array<{ guard: string }>).filter((p) => p.guard !== zeroAddress).map((p) => p.guard)).toEqual([guard, guard]);
    const row = (await sql<{ session_key: string; sealed_key: string }[]>`SELECT session_key, sealed_key FROM autopilot_grants WHERE owner = ${user.address.toLowerCase()}`)[0]!;
    expect(row.sealed_key).toBe(requested.sealedKey);
    expect(await openGrant(user.address.toLowerCase(), row)).toBe(requested.account.address.toLowerCase());
    expect(getAddress(row.session_key)).toBe(getAddress(grant.session.key));

    expect((await call(token, "POST", "/v1/autopilot/grant/confirm")).status).toBe(409);
    // Perpl orders the account allows without the order guard (an outdated app) are refused.
    sessions.set(`${user.address.toLowerCase()}:${grant.session.key.toLowerCase()}`, { active: true, validUntil: BigInt(T + 7 * 86_400), dailyLimit: 100_000_000n, permitted: true, guard: zeroAddress });
    const unguarded = await call(token, "POST", "/v1/autopilot/grant/confirm");
    expect(unguarded.status).toBe(409);
    expect(((await unguarded.json()) as { error: string }).error).toContain("order guard");
    // So are those naming the order guard this deployment replaced, which had no leverage cap.
    const replaced = "0x697f40BaBD7f125a67E12CB6a65ca53e52c1084B";
    expect(replaced.toLowerCase()).not.toBe(deployments[10143]!.perplOrderGuard.toLowerCase());
    sessions.set(`${user.address.toLowerCase()}:${grant.session.key.toLowerCase()}`, { active: true, validUntil: BigInt(T + 7 * 86_400), dailyLimit: 100_000_000n, permitted: true, guard: replaced });
    const outdated = await call(token, "POST", "/v1/autopilot/grant/confirm");
    expect(outdated.status).toBe(409);
    expect(((await outdated.json()) as { error: string }).error).toBe("the session's Perpl orders do not go through Trendr's current order guard; reload the app and grant again");
    sessions.set(`${user.address.toLowerCase()}:${grant.session.key.toLowerCase()}`, { active: true, validUntil: BigInt(T + 7 * 86_400), dailyLimit: 100_000_000n, permitted: true });
    const confirmed = (await (await call(token, "POST", "/v1/autopilot/grant/confirm")).json()) as { grant: { status: string } };
    expect(confirmed.grant.status).toBe("active");

    const enabled = (await (await enable(token, id)).json()) as { rule: { status: string; backtestId: number } };
    expect(enabled.rule.status).toBe("enabled");

    // A running rule cannot be edited; pausing first allows it and voids the backtest.
    expect((await call(token, "PUT", `/v1/autopilot/rules/${id}`, { rule: { ...rule, name: "edited" } })).status).toBe(409);
    await call(token, "POST", `/v1/autopilot/rules/${id}/status`, { status: "paused" });
    const edited = (await (await call(token, "PUT", `/v1/autopilot/rules/${id}`, { rule: { ...rule, name: "edited" } })).json()) as { rule: { backtestId: number | null } };
    expect(edited.rule.backtestId).toBeNull();
    expect((await call(token, "POST", `/v1/autopilot/rules/${id}/status`, { status: "enabled" })).status).toBe(409);

    // Other accounts cannot see it.
    expect((await call(await signIn(other, other), "GET", `/v1/autopilot/rules/${id}`)).status).toBe(404);

    const detail = (await (await call(token, "GET", `/v1/autopilot/rules/${id}`)).json()) as { audit: Array<{ event: string }> };
    expect(detail.audit.map((a) => a.event)).toEqual(["rule_edited", "rule_paused", "rule_enabled", "rule_created"]);
  });

  test("a new grant leaves the active one in force until the new key is on chain, then switches over", async () => {
    const owner = privateKeyToAccount("0x4cad4e4f6f8e8b5d2f5b7c3a9d0e1f2a3b4c5d6e7f8091a2b3c4d5e6f708192a");
    const o = owner.address.toLowerCase();
    const token = await signIn(owner, owner);
    const onChain = (key: string, active: boolean, validUntil = T + 7 * 86_400) =>
      sessions.set(`${o}:${key.toLowerCase()}`, { active, validUntil: BigInt(validUntil), dailyLimit: 100_000_000n, permitted: true });
    const grantKey = async () => ((await (await requestGrant(token, owner)).res.json()) as { session: { key: string } }).session.key.toLowerCase();
    const stored = async () => (await sql<{ session_key: string; sealed_key: string; status: string }[]>`SELECT session_key, sealed_key, status FROM autopilot_grants WHERE owner = ${o}`)[0]!;
    const view = async () => ((await (await call(token, "GET", "/v1/autopilot/grant")).json()) as { grant: { sessionKey: string; status: string; nextSessionKey: string | null } }).grant;

    const first = await grantKey();
    onChain(first, true);
    expect((await call(token, "POST", "/v1/autopilot/grant/confirm")).status).toBe(200);
    const { rule: r } = (await (await call(token, "POST", "/v1/autopilot/rules", { rule: { ...rule, name: "switch" } })).json()) as { rule: { id: number } };
    await call(token, "POST", "/v1/autopilot/backtests", { rule: { ...rule, name: "switch" }, days: 1 });
    expect((await enable(token, r.id, owner)).status).toBe(200);

    // Asking for a new key changes nothing the executor reads: the first key keeps trading.
    const second = await grantKey();
    expect(await stored()).toMatchObject({ session_key: first, status: "active" });
    expect(await openGrant(o, await stored())).toBe(first);
    expect(await view()).toMatchObject({ sessionKey: first, status: "active", nextSessionKey: second });
    // Rules still enable on it, and confirming before the new key is on chain changes nothing.
    await call(token, "POST", `/v1/autopilot/rules/${r.id}/status`, { status: "paused" });
    expect((await enable(token, r.id, owner)).status).toBe(200);
    expect((await call(token, "POST", "/v1/autopilot/grant/confirm")).status).toBe(409);
    expect(await view()).toMatchObject({ sessionKey: first, status: "active", nextSessionKey: second });

    // A newer request replaces the waiting one, never the active one.
    const third = await grantKey();
    expect(await view()).toMatchObject({ sessionKey: first, status: "active", nextSessionKey: third });

    // The account adds the new key and drops the old one in one batch; confirming switches over.
    onChain(third, true);
    onChain(first, false);
    const confirmed = (await (await call(token, "POST", "/v1/autopilot/grant/confirm")).json()) as { grant: { sessionKey: string; status: string } };
    expect(confirmed.grant).toMatchObject({ sessionKey: third, status: "active" });
    expect(await view()).toMatchObject({ sessionKey: third, status: "active", nextSessionKey: null });
    expect(await openGrant(o, await stored())).toBe(third);
    // Every key granted stays refused at sign-in, the replaced and the abandoned ones too, for this account only.
    const store = new AutopilotStore(sql);
    for (const k of [first, second, third]) expect(await store.isGrantKey(o, k)).toBe(true);
    expect(await store.isGrantKey(user.address, first)).toBe(false);
    const audit = await sql<{ event: string; detail: { replaces?: string } }[]>`SELECT event, detail FROM autopilot_audit WHERE owner = ${o} AND event LIKE 'grant_%' ORDER BY id`;
    expect(audit.map((a) => a.event)).toEqual(["grant_requested", "grant_active", "grant_requested", "grant_requested", "grant_active"]);
    expect(audit[2]?.detail.replaces).toBe(first);

    // With no grant in force (expired here), a request starts over as pending, as before.
    await sql`UPDATE autopilot_grants SET valid_until = ${T - 1} WHERE owner = ${o}`;
    const fourth = await grantKey();
    expect(await view()).toMatchObject({ sessionKey: fourth, status: "pending", nextSessionKey: null });
  });

  test("the server never makes or sees a grant key: it stores the app's sealed box and refuses one the executor could not open", async () => {
    const owner = privateKeyToAccount("0x7fd0708192a3b4c5d6e7f8091a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d");
    const token = await signIn(owner, owner);
    const published = (await (await app.request("/v1/autopilot/grant/seal-key")).json()) as { publicKey: string };
    expect(published.publicKey).toBe(sealKeys.publicKey);
    // An app that still expects the server to make the key gets a clear refusal.
    expect((await call(token, "POST", "/v1/autopilot/grant", { dailyLimit: "100000000", validDays: 7 })).status).toBe(400);
    const key = generatePrivateKey();
    const address = privateKeyToAccount(key).address;
    const binding = { owner: owner.address.toLowerCase(), sessionKey: address.toLowerCase() };
    // Sealed to another executor key: the header says so, and nothing is stored.
    const elsewhere = await generateSealKeyPair();
    const wrongKey = await call(token, "POST", "/v1/autopilot/grant", { sessionKey: address, sealedKey: await seal(key, elsewhere.publicKey, binding) });
    expect(wrongKey.status).toBe(400);
    expect(((await wrongKey.json()) as { error: string }).error).toContain("sealed to another Autopilot key");
    // Only the current seal version is taken, and never the account as its own session key.
    const headerless = (await seal(key, sealKeys.publicKey, binding)).slice(3);
    expect((await call(token, "POST", "/v1/autopilot/grant", { sessionKey: address, sealedKey: headerless })).status).toBe(400);
    expect((await call(token, "POST", "/v1/autopilot/grant", { sessionKey: owner.address, sealedKey: await seal(key, sealKeys.publicKey, { ...binding, sessionKey: binding.owner }) })).status).toBe(400);
    expect(await sql`SELECT 1 FROM autopilot_grants WHERE owner = ${binding.owner}`).toHaveLength(0);

    const ok = await requestGrant(token, owner);
    expect(ok.res.status).toBe(200);
    // Another account cannot claim a key some account already granted.
    const thief = await signIn(other, other);
    const claimed = await call(thief, "POST", "/v1/autopilot/grant", { sessionKey: ok.account.address, sealedKey: ok.sealedKey });
    expect(claimed.status).toBe(409);
    expect(await new AutopilotStore(sql).isGrantKey(other.address, ok.account.address)).toBe(false);
  });

  test("naming another account's trading session key in a grant request does not lock that account out", async () => {
    sessions.set(`${user.address.toLowerCase()}:${session.address.toLowerCase()}`, { active: true, validUntil: BigInt(T + 3600), dailyLimit: 0n, permitted: false, trading: true });
    const mallory = privateKeyToAccount("0x8ae1819203b4c5d6e7f8091a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d5e");
    const token = await signIn(mallory, mallory);
    const box = await seal(generatePrivateKey(), sealKeys.publicKey, { owner: mallory.address.toLowerCase(), sessionKey: session.address.toLowerCase() });
    expect((await call(token, "POST", "/v1/autopilot/grant", { sessionKey: session.address, sealedKey: box })).status).toBe(200);
    expect(await signIn(user, session)).toBeString();
  });

  test("the kill switch blocks enabling", async () => {
    const token = await signIn();
    const { rule: r } = (await (await call(token, "POST", "/v1/autopilot/rules", { rule: { ...rule, name: "second" } })).json()) as { rule: { id: number } };
    await call(token, "POST", "/v1/autopilot/backtests", { rule: { ...rule, name: "second" }, days: 1 });
    await asAdmin("POST", "/v1/admin/autopilot/kill", JSON.stringify({ engaged: true, reason: "drill" }));
    expect(((await (await call(token, "POST", `/v1/autopilot/rules/${r.id}/status`, { status: "enabled" })).json()) as { error: string }).error).toBe("Autopilot is halted: drill");
    await asAdmin("POST", "/v1/admin/autopilot/kill", JSON.stringify({ engaged: false }));
    expect((await enable(token, r.id)).status).toBe(200);
  });
});

describe("backtest limits", () => {
  test("each account runs a bounded number of backtests an hour", async () => {
    const tester = privateKeyToAccount("0x3fac3d3e5e7d7a4c1e4a6b2f8c9d0e1f2a3b4c5d6e7f8091a2b3c4d5e6f70819");
    const token = await signIn(tester, tester);
    const run = (t = token) => call(t, "POST", "/v1/autopilot/backtests", { rule, days: 1 });
    for (let i = 0; i < MAX_BACKTESTS_PER_HOUR; i++) expect((await run()).status).toBe(200);
    const refused = await run();
    expect(refused.status).toBe(429);
    expect(Number(refused.headers.get("retry-after"))).toBeGreaterThan(0);
    // Every account has its own allowance, and it renews after the hour.
    expect((await run(await signIn(other, other))).status).toBe(200);
    now += 3_600_000;
    expect((await run()).status).toBe(200);
  });
});

describe("copy-trading", () => {
  test("needs a grant, valid settings and the passkey's approval", async () => {
    const leader = BOT;
    const token = await signIn();
    const settings = { mode: "ratio", ratio: 0.5, maxMarginAusd: 50, maxLeverage: 3, maxDailyLossAusd: 20 };
    expect((await call(token, "POST", "/v1/follows", { leader: user.address, settings })).status).toBe(400);
    expect((await call(token, "POST", "/v1/follows", { leader, settings: { ...settings, mode: "fixed" } })).status).toBe(400);
    // Copies open through the session's order guard, so at most its 10x cap.
    const over = await call(token, "POST", "/v1/follows", { leader, settings: { ...settings, maxLeverage: 15 } });
    expect(over.status).toBe(400);
    expect(((await over.json()) as { error: string }).error).toBe("settings.maxLeverage: copies open from your account at up to 10x");
    const unapproved = await call(token, "POST", "/v1/follows", { leader, settings });
    expect(unapproved.status).toBe(403);
    expect(await unapproved.json()).toEqual({ error: "approve this with your passkey", code: "owner_approval" });
    // The approval covers the settings as sent; the server fills in the defaults it stores.
    const res = await call(token, "POST", "/v1/follows", { leader, settings, approval: await approval(token, user, ownerRequests.follow(leader, settings)) });
    expect(res.status).toBe(201);
    expect(((await res.json()) as { follow: { settings: Record<string, number> } }).follow.settings).toMatchObject({ fixedMarginAusd: 0, maxSlippagePct: 0.3, maxOpenLossAusd: 20 });
    const noGrant = await signIn(other, other);
    expect((await call(noGrant, "POST", "/v1/follows", { leader, settings })).status).toBe(409);
    const perf = (await (await app.request(`/v1/autopilot/performance/${leader}`)).json()) as { followers: number };
    expect(perf.followers).toBe(1);
  });

  test("the passkey approves the slippage limit and the loss cap with the rest of the caps", async () => {
    const owner = privateKeyToAccount("0x9bf29203a4b5c6d7e8f9a0b1c2d3e4f5a6b7c8d9e0f1a2b3c4d5e6f708192a3b");
    const o = owner.address.toLowerCase();
    const token = await signIn(owner, owner);
    const { account: k } = await requestGrant(token, owner);
    sessions.set(`${o}:${k.address.toLowerCase()}`, { active: true, validUntil: BigInt(T + 7 * 86_400), dailyLimit: 100_000_000n, permitted: true });
    expect((await call(token, "POST", "/v1/autopilot/grant/confirm")).status).toBe(200);
    const settings = { mode: "ratio", ratio: 1, fixedMarginAusd: 0, maxMarginAusd: 40, maxLeverage: 2, maxDailyLossAusd: 20, maxSlippagePct: 0.25, maxOpenLossAusd: 12 };
    expect((await call(token, "POST", "/v1/follows", { leader: BOT, settings: { ...settings, maxSlippagePct: 5 } })).status).toBe(400);
    expect((await call(token, "POST", "/v1/follows", { leader: BOT, settings: { ...settings, maxOpenLossAusd: 0 } })).status).toBe(400);
    // An approval of a tighter limit or a smaller cap does not cover a looser one.
    const approved = await approval(token, owner, ownerRequests.follow(BOT, settings));
    expect((await call(token, "POST", "/v1/follows", { leader: BOT, settings: { ...settings, maxSlippagePct: 0.8 }, approval: approved })).status).toBe(403);
    expect((await call(token, "POST", "/v1/follows", { leader: BOT, settings: { ...settings, maxOpenLossAusd: 1000 }, approval: await approval(token, owner, ownerRequests.follow(BOT, settings)) })).status).toBe(403);
    const res = await call(token, "POST", "/v1/follows", { leader: BOT, settings, approval: await approval(token, owner, ownerRequests.follow(BOT, settings)) });
    expect(res.status).toBe(201);
    const { follow: f } = (await res.json()) as { follow: { id: number; settings: unknown } };
    expect(f.settings).toEqual(settings);

    // The executor closed it out at the loss cap: pausing keeps the close-out going; resuming ends it.
    const closingOut = async () => (await sql<{ closing_out: boolean }[]>`SELECT closing_out FROM follows WHERE id = ${f.id}`)[0]!.closing_out;
    await sql`UPDATE follows SET status = 'paused', status_reason = 'Paused at your loss cap', closing_out = true WHERE id = ${f.id}`;
    const listed = ((await (await call(token, "GET", "/v1/follows")).json()) as { follows: Array<{ statusReason: string }> }).follows;
    expect(listed[0]?.statusReason).toBe("Paused at your loss cap");
    expect((await call(token, "POST", `/v1/follows/${f.id}/status`, { status: "paused" })).status).toBe(200);
    expect(await closingOut()).toBe(true);
    expect((await call(token, "POST", `/v1/follows/${f.id}/status`, { status: "active", approval: await approval(token, owner, ownerRequests.resumeFollow(f.id)) })).status).toBe(200);
    expect(await closingOut()).toBe(false);
    // New caps end it too.
    await sql`UPDATE follows SET status = 'paused', closing_out = true WHERE id = ${f.id}`;
    const raised = { ...settings, maxOpenLossAusd: 20 };
    expect((await call(token, "POST", "/v1/follows", { leader: BOT, settings: raised, approval: await approval(token, owner, ownerRequests.follow(BOT, raised)) })).status).toBe(201);
    expect(await closingOut()).toBe(false);

    // A follow stored before these settings existed reads with their defaults.
    await sql`UPDATE follows SET settings = settings - 'maxSlippagePct' - 'maxOpenLossAusd' WHERE id = ${f.id}`;
    const old = ((await (await call(token, "GET", "/v1/follows")).json()) as { follows: Array<{ settings: Record<string, number> }> }).follows;
    expect(old[0]?.settings).toMatchObject({ maxSlippagePct: 0.3, maxOpenLossAusd: 20 });
  });

  test("a session key alone cannot follow, resume a follow or enable a rule; it can pause, stop and unfollow", async () => {
    const victim = privateKeyToAccount("0x5dbe5e5f7f9f9c6e3f6c8d4b0e1f2a3b4c5d6e7f8091a2b3c4d5e6f708192a3b");
    const stolen = privateKeyToAccount("0x6ecf6f708a0a0d7f4a7d9e5c1f2a3b4c5d6e7f8091a2b3c4d5e6f708192a3b4c");
    const v = victim.address.toLowerCase();
    sessions.set(`${v}:${stolen.address.toLowerCase()}`, { active: true, validUntil: BigInt(T + 86_400), dailyLimit: 1n, permitted: false, trading: true });
    const token = await signIn(victim, stolen);
    // Autopilot access is granted (by the passkey, on chain) before anything below.
    const key = (await requestGrant(token, victim)).account.address;
    sessions.set(`${v}:${key.toLowerCase()}`, { active: true, validUntil: BigInt(T + 7 * 86_400), dailyLimit: 100_000_000n, permitted: true });
    expect((await call(token, "POST", "/v1/autopilot/grant/confirm")).status).toBe(200);

    // Following the attacker with huge caps: no approval, or an approval of other settings or another leader.
    const attacker = other.address;
    const greedy = { mode: "ratio", ratio: 10, maxMarginAusd: 1_000_000, maxLeverage: 10, maxDailyLossAusd: 1_000_000 };
    const modest = { mode: "ratio", ratio: 1, maxMarginAusd: 20, maxLeverage: 2, maxDailyLossAusd: 10 };
    expect((await call(token, "POST", "/v1/follows", { leader: attacker, settings: greedy })).status).toBe(403);
    expect((await call(token, "POST", "/v1/follows", { leader: attacker, settings: greedy, approval: await approval(token, victim, ownerRequests.follow(attacker, modest)) })).status).toBe(403);
    expect((await call(token, "POST", "/v1/follows", { leader: attacker, settings: modest, approval: await approval(token, victim, ownerRequests.follow(BOT, modest)) })).status).toBe(403);
    // What the passkey approved goes through, whichever token carries it.
    const followed = await call(token, "POST", "/v1/follows", { leader: BOT, settings: modest, approval: await approval(token, victim, ownerRequests.follow(BOT, modest)) });
    expect(followed.status).toBe(201);
    const { follow: f } = (await followed.json()) as { follow: { id: number } };

    // Pausing needs no prompt; resuming does, for this follow only.
    expect((await call(token, "POST", `/v1/follows/${f.id}/status`, { status: "paused" })).status).toBe(200);
    expect((await call(token, "POST", `/v1/follows/${f.id}/status`, { status: "active" })).status).toBe(403);
    expect((await call(token, "POST", `/v1/follows/${f.id}/status`, { status: "active", approval: await approval(token, victim, ownerRequests.resumeFollow(f.id + 1)) })).status).toBe(403);
    expect((await call(token, "POST", `/v1/follows/${f.id}/status`, { status: "active", approval: await approval(token, victim, ownerRequests.resumeFollow(f.id)) })).status).toBe(200);
    expect((await call(token, "POST", `/v1/follows/${f.id}/status`, { status: "stopped" })).status).toBe(200);

    // A backtested rule: enabling needs the approval of this rule as stored, and only once.
    const own = { ...rule, name: "approved" };
    const { rule: r } = (await (await call(token, "POST", "/v1/autopilot/rules", { rule: own })).json()) as { rule: { id: number; ruleHash: string } };
    await call(token, "POST", "/v1/autopilot/backtests", { rule: own, days: 1 });
    const path = `/v1/autopilot/rules/${r.id}/status`;
    expect((await call(token, "POST", path, { status: "enabled" })).status).toBe(403);
    expect((await call(token, "POST", path, { status: "enabled", ruleHash: "0".repeat(32), approval: await approval(token, victim, ownerRequests.enableRule(r.id, "0".repeat(32))) })).status).toBe(409);
    expect((await call(token, "POST", path, { status: "enabled", approval: await approval(token, victim, ownerRequests.enableRule(r.id, "0".repeat(32))) })).status).toBe(403);
    const stale = await approval(token, victim, ownerRequests.enableRule(r.id, r.ruleHash));
    now += 301_000;
    const expired = await call(token, "POST", path, { status: "enabled", ruleHash: r.ruleHash, approval: stale });
    expect(expired.status).toBe(403);
    expect(((await expired.json()) as { error: string }).error).toBe("this passkey approval expired; try again");
    const approved = await approval(token, victim, ownerRequests.enableRule(r.id, r.ruleHash));
    expect((await call(token, "POST", path, { status: "enabled", ruleHash: r.ruleHash, approval: approved })).status).toBe(200);
    expect((await call(token, "POST", path, { status: "paused" })).status).toBe(200);
    // Replaying the spent approval does not turn it back on.
    expect((await call(token, "POST", path, { status: "enabled", ruleHash: r.ruleHash, approval: approved })).status).toBe(403);
    expect((await call(token, "POST", path, { status: "stopped" })).status).toBe(200);
  });
});

describe("bot rules", () => {
  test("admins create, backtest and enable the bot's rules", async () => {
    const created = (await (await asAdmin("POST", "/v1/admin/autopilot/bot/rules", JSON.stringify({ rule }))).json()) as { rule: { id: number; owner: string; venue: string } };
    expect(created.rule).toMatchObject({ owner: BOT, venue: "api" });
    expect((await asAdmin("POST", `/v1/admin/autopilot/bot/rules/${created.rule.id}/status`, JSON.stringify({ status: "enabled" }))).status).toBe(409);
    expect((await asAdmin("POST", "/v1/admin/autopilot/bot/backtests", JSON.stringify({ rule, days: 1 }))).status).toBe(200);
    const enabled = (await (await asAdmin("POST", `/v1/admin/autopilot/bot/rules/${created.rule.id}/status`, JSON.stringify({ status: "enabled" }))).json()) as { rule?: { status: string }; error?: string };
    expect(enabled.error).toBeUndefined();
    expect(enabled.rule?.status).toBe("enabled");
    const overview = (await (await asAdmin("GET", "/v1/admin/autopilot")).json()) as { enabled: unknown[]; kill: { engaged: boolean } };
    expect(overview.kill.engaged).toBe(false);
    expect(overview.enabled.length).toBeGreaterThanOrEqual(2);
  });
});
