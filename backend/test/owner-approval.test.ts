import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { type OwnerChallenge, ownerApprovalDigest, type OwnerRequest, ownerRequests } from "@trendr/contracts";
import { Hono, type MiddlewareHandler } from "hono";
import { ContractFunctionZeroDataError, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { MAX_OPEN_APPROVALS, OWNER_APPROVAL_SEC, ownerApprovalRoutes, OwnerApprovals, verifyAssertion } from "../src/api/owner-approval";
import { ChainUnavailableError } from "../src/api/user-auth";
import type { Sql } from "../src/db";
import { testDb } from "./helpers";
import { type TestPasskey, testPasskey } from "./passkey";

/**
 * Owner approvals: the passkey's fresh say-so for following, enabling rules and linking identities.
 * Each approval covers one action, one account and its exact parameters, with a nonce the backend
 * issued, and passes once.
 */

const account = privateKeyToAccount("0x00000000000000000000000000000000000000000000000000000000000a0c01");
const other = privateKeyToAccount("0x00000000000000000000000000000000000000000000000000000000000a0c02");
const session = privateKeyToAccount("0x00000000000000000000000000000000000000000000000000000000000a0c03");
const T = 1_800_000_000;
const LEADER = "0x6cfacb4c9a1b63cbc87750ec471ce194bfea0211";
const settings = { mode: "ratio", ratio: 0.5, fixedMarginAusd: 0, maxMarginAusd: 30, maxLeverage: 2, maxDailyLossAusd: 10 };

let sql: Sql;
let now = T * 1000;
let passkey: TestPasskey;
let stranger: TestPasskey;
/** Owner keys the fake chain reports; accounts not in it have no code. */
const owners = new Map<string, readonly [Hex, Hex]>();
let rpcDown = false;
let approvals: OwnerApprovals;

beforeAll(async () => {
  sql = await testDb();
  passkey = await testPasskey();
  stranger = await testPasskey();
  const client = {
    readContract: async ({ functionName, address }: { functionName: string; address: string }) => {
      if (rpcDown) throw new Error("fetch failed");
      if (functionName !== "owner") throw new Error(`unexpected read ${functionName}`);
      const o = owners.get(address.toLowerCase());
      if (!o) throw new ContractFunctionZeroDataError({ functionName });
      return o;
    },
  };
  approvals = new OwnerApprovals(sql, client as never, 10143, () => now);
});
afterAll(async () => {
  await sql.end();
});
beforeEach(async () => {
  now = T * 1000;
  rpcDown = false;
  owners.clear();
  owners.set(account.address.toLowerCase(), passkey.owner);
  owners.set(other.address.toLowerCase(), stranger.owner);
  await sql`TRUNCATE owner_approvals`;
});

const follow = ownerRequests.follow(LEADER, settings);
const issue = async (request: OwnerRequest = follow, who = account.address) => (await approvals.issue(who, request.action))!;

describe("owner approvals", () => {
  test("a fresh passkey approval of exactly this request passes, once", async () => {
    const ch = await issue();
    expect(ch).toMatchObject({ chainId: 10143, expiresAt: T + OWNER_APPROVAL_SEC });
    expect(ch.nonce).toMatch(/^0x[0-9a-f]{64}$/);
    const approval = await passkey.approve(account.address, follow, ch);
    await approvals.verify(account.address, follow, approval);
    // Replayed: the nonce is spent.
    await expect(approvals.verify(account.address, follow, approval)).rejects.toThrow("no longer valid");
  });

  test("two requests racing with one approval: exactly one passes", async () => {
    const approval = await passkey.approve(account.address, follow, await issue());
    const results = await Promise.allSettled([approvals.verify(account.address, follow, approval), approvals.verify(account.address, follow, approval)]);
    expect(results.map((r) => r.status).sort()).toEqual(["fulfilled", "rejected"]);
  });

  test("an approval of another action is refused, whether the nonce or the signature names it", async () => {
    const enable = ownerRequests.enableRule(7, "ab".repeat(16));
    // A nonce issued for following cannot enable a rule.
    const forFollow = await issue();
    await expect(approvals.verify(account.address, enable, await passkey.approve(account.address, enable, forFollow))).rejects.toThrow("does not match");
    // A nonce issued for enabling, signed over a follow, does not verify as an enable.
    const forEnable = await issue(enable);
    await expect(approvals.verify(account.address, enable, await passkey.approve(account.address, { ...follow, action: "enable-rule" }, forEnable))).rejects.toThrow("does not match");
  });

  test("an approval of other parameters is refused and leaves the nonce for the real request", async () => {
    const ch = await issue();
    const approval = await passkey.approve(account.address, follow, ch);
    await expect(approvals.verify(account.address, ownerRequests.follow(LEADER, { ...settings, maxMarginAusd: 1_000_000 }), approval)).rejects.toThrow("does not match");
    await expect(approvals.verify(account.address, ownerRequests.follow(other.address, settings), approval)).rejects.toThrow("does not match");
    await approvals.verify(account.address, follow, approval);
  });

  test("an expired approval is refused", async () => {
    const approval = await passkey.approve(account.address, follow, await issue());
    now += OWNER_APPROVAL_SEC * 1000;
    await expect(approvals.verify(account.address, follow, approval)).rejects.toThrow("expired");
  });

  test("a session key's signature, another passkey, or another account's nonce is refused", async () => {
    const ch = await issue();
    const digest = ownerApprovalDigest({ chainId: 10143, account: account.address, request: follow, nonce: ch.nonce, expiresAt: ch.expiresAt });
    // The trading session key signs the very same digest: it is not the owner's P256 key.
    const bySession = await session.sign({ hash: digest });
    const shaped = await passkey.assert(digest);
    await expect(approvals.verify(account.address, follow, { nonce: ch.nonce, signature: bySession })).rejects.toThrow("malformed");
    await expect(approvals.verify(account.address, follow, { ...shaped, nonce: ch.nonce, r: bySession.slice(0, 66), s: `0x${bySession.slice(66, 130)}` })).rejects.toThrow("does not match");
    // A passkey that is not this account's owner.
    await expect(approvals.verify(account.address, follow, await stranger.approve(account.address, follow, ch))).rejects.toThrow("does not match");
    // A nonce issued to another account, even with that account's own passkey.
    const theirs = await issue(follow, other.address);
    await expect(approvals.verify(account.address, follow, await passkey.approve(account.address, follow, theirs))).rejects.toThrow("does not match");
    // Missing, or a nonce nobody issued.
    await expect(approvals.verify(account.address, follow, undefined)).rejects.toThrow("approve this with your passkey");
    const forged: OwnerChallenge = { ...ch, nonce: `0x${"ab".repeat(32)}` };
    await expect(approvals.verify(account.address, follow, await passkey.approve(account.address, follow, forged))).rejects.toThrow("no longer valid");
    // The genuine approval still passes.
    await approvals.verify(account.address, follow, await passkey.approve(account.address, follow, ch));
  });

  test("an account with no passkey owner is refused, and an RPC failure is ChainUnavailableError", async () => {
    const stray = privateKeyToAccount("0x00000000000000000000000000000000000000000000000000000000000a0c04");
    const ch = (await approvals.issue(stray.address, "follow"))!;
    await expect(approvals.verify(stray.address, follow, await passkey.approve(stray.address, follow, ch))).rejects.toThrow("no passkey on chain");
    const zero = `0x${"00".repeat(32)}` as Hex;
    owners.set(stray.address.toLowerCase(), [zero, zero]);
    await expect(approvals.verify(stray.address, follow, await passkey.approve(stray.address, follow, ch))).rejects.toThrow("no passkey on chain");
    const mine = await passkey.approve(account.address, follow, await issue());
    rpcDown = true;
    await expect(approvals.verify(account.address, follow, mine)).rejects.toBeInstanceOf(ChainUnavailableError);
    expect(await approvals.check(account.address, follow, mine)).toEqual({ body: { error: "could not check the account on chain; try again" }, status: 503 });
    rpcDown = false;
    // The outage did not spend the nonce.
    expect(await approvals.check(account.address, follow, mine)).toBeNull();
  });

  test("each account holds a bounded number of open nonces; expired ones free the slots", async () => {
    for (let i = 0; i < MAX_OPEN_APPROVALS; i++) expect(await approvals.issue(account.address, "follow")).not.toBeNull();
    expect(await approvals.issue(account.address, "follow")).toBeNull();
    expect(await approvals.issue(other.address, "follow")).not.toBeNull();
    now += OWNER_APPROVAL_SEC * 1000;
    expect(await approvals.issue(account.address, "follow")).not.toBeNull();
  });
});

describe("assertion checks", () => {
  const challenge = `0x${"5a".repeat(32)}` as Hex;
  const ok = (a: Awaited<ReturnType<TestPasskey["assert"]>>) => verifyAssertion(challenge, a, passkey);

  test("accepts what PasskeyAccount accepts", async () => {
    expect(await ok(await passkey.assert(challenge))).toBe(true);
  });

  test("needs user presence and verification, a get ceremony, this challenge, a same-origin frame and low s", async () => {
    expect(await ok(await passkey.assert(challenge, { flags: 0x01 }))).toBe(false);
    expect(await ok(await passkey.assert(challenge, { flags: 0x04 }))).toBe(false);
    expect(await ok(await passkey.assert(challenge, { type: "webauthn.create" }))).toBe(false);
    expect(await ok(await passkey.assert(challenge, { crossOrigin: true }))).toBe(false);
    expect(await ok(await passkey.assert(challenge, { highS: true }))).toBe(false);
    expect(await ok(await passkey.assert(`0x${"5b".repeat(32)}`))).toBe(false);
    expect(await verifyAssertion(challenge, await passkey.assert(challenge), stranger)).toBe(false);
    // Anything changed after signing.
    const a = await passkey.assert(challenge);
    expect(await ok({ ...a, clientDataJSON: a.clientDataJSON.replace("localhost", "evil.example") })).toBe(false);
    expect(await ok({ ...a, clientDataJSON: "not json" })).toBe(false);
    expect(await ok({ ...a, authenticatorData: `${a.authenticatorData.slice(0, -2)}ff` as Hex })).toBe(false);
  });
});

describe("POST /owner-approvals", () => {
  const routes = () => {
    type Vars = { Variables: { user: string; token: string } };
    const app = new Hono<Vars>();
    const signedIn: MiddlewareHandler<Vars> = async (c, next) => {
      const user = c.req.header("x-user");
      if (!user) return c.json({ error: "sign in first" }, 401);
      c.set("user", user);
      await next();
    };
    app.route("/", ownerApprovalRoutes(approvals, signedIn, () => now));
    return (body: unknown, user: string | null = account.address.toLowerCase()) =>
      app.request("/owner-approvals", { method: "POST", headers: { "content-type": "application/json", ...(user ? { "x-user": user } : {}) }, body: JSON.stringify(body) });
  };

  test("issues a nonce to the signed-in account for one known action", async () => {
    const ask = routes();
    expect((await ask({ action: "follow" }, null)).status).toBe(401);
    expect((await ask({ action: "withdraw" })).status).toBe(400);
    const res = await ask({ action: "follow" });
    expect(res.status).toBe(200);
    const ch = (await res.json()) as OwnerChallenge;
    expect(ch).toMatchObject({ chainId: 10143, expiresAt: T + OWNER_APPROVAL_SEC });
    await approvals.verify(account.address, follow, await passkey.approve(account.address, follow, ch));
  });

  test("each account asks at most 30 times in 10 minutes, whatever the nonces", async () => {
    const ask = routes();
    const statuses: number[] = [];
    // Bad requests count too: the limit runs before the body is read.
    for (let i = 0; i < 30; i++) statuses.push((await ask({ action: "withdraw" })).status);
    expect(new Set(statuses)).toEqual(new Set([400]));
    const refused = await ask({ action: "follow" });
    expect(refused.status).toBe(429);
    expect(Number(refused.headers.get("retry-after"))).toBeGreaterThan(0);
    // Another account is unaffected; the window ends.
    expect((await ask({ action: "follow" }, other.address.toLowerCase())).status).toBe(200);
    now += 600_000;
    expect((await ask({ action: "follow" })).status).toBe(200);
  });
});
