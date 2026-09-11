import { describe, expect, test } from "bun:test";
import { type Call, type Deployment, deploymentPerplPermissions, deployments, legacyOutcomeMarkets, passkeyAccountAbi, type Permission, tradingPermissions } from "@trendr/contracts";
import { encodeFunctionData, erc20Abi, type Hex, toFunctionSelector, zeroAddress } from "viem";
import { checkOwnerCalls as ownerCalls, checkSessionCalls as sessionCalls, checkSessionConfig, checkUpgradeSessions, MAX_CALLS } from "../src/policy";
import { RateLimiter } from "../src/rate-limit";
import type { TrendrTokens } from "../src/tokens";

const d = deployments[10143]!;
const account = "0x00000000000000000000000000000000000000aa" as const;
const other = "0x00000000000000000000000000000000000000bb" as const;
/** An UP token, and a contract that only looks like a token. */
const up = "0x00000000000000000000000000000000000000cc" as const;
const fake = "0x00000000000000000000000000000000000000dd" as const;

/** A fake on-chain reader that knows one Trendr token and records what it was asked. */
const asked: string[] = [];
const tokens: TrendrTokens = {
  isTrendrToken: async (t) => {
    asked.push(t.toLowerCase());
    return t.toLowerCase() === up;
  },
};
const checkSessionCalls = (calls: Call[], dep: Deployment) => sessionCalls(calls, dep, tokens);
const checkOwnerCalls = (calls: Call[], dep: Deployment, acct: `0x${string}`) => ownerCalls(calls, dep, acct, tokens);
const approve = (spender: `0x${string}`): Call => ({
  target: d.ausd,
  value: 0n,
  data: encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [spender, 1n] }),
});
const sel = (sig: string, target: `0x${string}`): Call => ({ target, value: 0n, data: `${toFunctionSelector(sig)}${"00".repeat(32)}` as Hex });
const addSession = (permissions: Permission[]): Call => ({
  target: account,
  value: 0n,
  data: encodeFunctionData({ abi: passkeyAccountAbi, functionName: "addSession", args: [{ key: other, validUntil: 2_000_000_000, dailyLimit: 1n, permissions }] }),
});

describe("session policy", () => {
  test("allows trading calls and approvals to protocol contracts", async () => {
    const mint = sel("mint(bytes32,uint256,address)", d.outcomeMarkets);
    expect(await checkSessionCalls([approve(d.outcomeMarkets), mint], d)).toEqual({ ok: true });
  });

  test("allows Kuru spot trades through TrendrSpot's banded buy and sell, selling Trendr tokens", async () => {
    const tokenApprove = (spender: `0x${string}`): Call => ({ ...approve(spender), target: up });
    const buy = sel("buy(address,uint256,uint256,address)", d.trendrSpot);
    const sell = sel("sell(address,uint256,uint256,address)", d.trendrSpot);
    expect(await checkSessionCalls([approve(d.trendrSpot), buy], d)).toEqual({ ok: true });
    expect(await checkSessionCalls([tokenApprove(d.trendrSpot), sell], d)).toEqual({ ok: true });
    // The owner's unbanded entry points and the bonding curve are passkey actions.
    expect(await checkSessionCalls([tokenApprove(d.trendrSpot), sel("sellWithLimit(address,uint256,uint256,address)", d.trendrSpot)], d)).toMatchObject({
      ok: false,
      index: 1,
    });
    expect(await checkSessionCalls([sel("buyWithLimit(address,uint256,uint256,address)", d.trendrSpot)], d)).toMatchObject({ ok: false, index: 0 });
    expect(await checkSessionCalls([sel("sell(bytes32,uint256,uint256,address,uint256)", d.bondingCurve)], d)).toMatchObject({ ok: false, index: 0 });
    expect(await checkSessionCalls([approve(d.bondingCurve)], d)).toEqual({ ok: false, reason: "approvals are limited to protocol contracts", index: 0 });
    // A token approval to anything else, and direct calls to Kuru's router, stay refused.
    expect(await checkSessionCalls([tokenApprove(d.kuruRouter)], d)).toMatchObject({ ok: false, index: 0 });
    // So does approving a token the protocol did not make, even to a protocol contract: its
    // approve could burn the whole gas limit and still succeed.
    const fakeApprove: Call = { ...approve(d.trendrSpot), target: fake };
    expect(await checkSessionCalls([approve(d.trendrSpot), fakeApprove], d)).toEqual({
      ok: false,
      reason: "approvals are limited to AUSD and Trendr tokens",
      index: 1,
    });
    expect(await checkSessionCalls([{ ...approve(d.bondingCurve), target: d.outcomeMarkets }], d)).toMatchObject({ ok: false, index: 0 });
    expect(await checkSessionCalls([sel("anyToAnySwap(address[],bool[],bool[],address,address,uint256,uint256)", d.kuruRouter)], d)).toMatchObject({
      ok: false,
    });
  });

  test("allows Perpl orders, account opening and deposits, but not withdrawals or forwarding", async () => {
    const order = "(uint256,uint256,uint8,uint256,uint256,uint256,uint256,bool,bool,bool,uint256,uint256,uint256,uint256,uint256)";
    expect(await checkSessionCalls([approve(d.perplExchange), sel("createAccount(uint256)", d.perplExchange)], d)).toEqual({ ok: true });
    expect(await checkSessionCalls([sel(`execOrder(${order})`, d.perplExchange)], d)).toEqual({ ok: true });
    expect(await checkSessionCalls([sel("withdrawCollateral(uint256)", d.perplExchange)], d)).toMatchObject({ ok: false });
    expect(await checkSessionCalls([sel("allowOrderForwarding(bool)", d.perplExchange)], d)).toMatchObject({ ok: false });
    // The owner, with the passkey, may do both.
    expect(
      await checkOwnerCalls([sel("allowOrderForwarding(bool)", d.perplExchange), sel("withdrawCollateral(uint256)", d.perplExchange)], d, account),
    ).toEqual({ ok: true });
  });

  test("rejects anything else", async () => {
    expect(await checkSessionCalls([approve(other)], d)).toMatchObject({ ok: false, index: 0 });
    expect(await checkSessionCalls([sel("transfer(address,uint256)", d.ausd)], d)).toMatchObject({ ok: false });
    expect(await checkSessionCalls([sel("depositPool(uint256)", d.attentionPerp)], d)).toMatchObject({ ok: false });
    expect(await checkSessionCalls([sel("mint(bytes32,uint256,address)", other)], d)).toMatchObject({ ok: false });
    expect(await checkSessionCalls([{ ...approve(d.outcomeMarkets), value: 1n }], d)).toMatchObject({ ok: false });
    expect(await checkSessionCalls([], d)).toMatchObject({ ok: false });
    expect(await checkSessionCalls(Array(MAX_CALLS + 1).fill(approve(d.outcomeMarkets)), d)).toMatchObject({ ok: false });
    expect(await checkSessionCalls([{ target: d.outcomeMarkets, value: 0n, data: "0x01" }], d)).toMatchObject({ ok: false });
  });
});

describe("owner policy", () => {
  test("allows session management, AUSD moves, protocol calls and Trendr token transfers", async () => {
    expect(
      await checkOwnerCalls(
        [
          sel("revokeSession(address)", account),
          sel("transfer(address,uint256)", d.ausd),
          sel("depositPool(uint256)", d.attentionPerp),
          sel("claim(address)", d.curationFees),
          sel("transfer(address,uint256)", up),
        ],
        d,
        account,
      ),
    ).toEqual({ ok: true });
  });

  test("adds sessions in the current format only: version 1 accounts upgrade instead of renewing", async () => {
    expect(await checkOwnerCalls([addSession(tradingPermissions(d))], d, account)).toEqual({ ok: true });
    const v2 = sel("addSession((address,uint48,uint128,(address,bytes4,uint8,address)[]))", account);
    expect(await checkOwnerCalls([v2], d, account)).toMatchObject({ ok: false, index: 0, reason: "a session must be added in the current format" });
    const v1 = sel("addSession((address,uint48,uint128,(address,bytes4,uint8)[]))", account);
    expect(await checkOwnerCalls([v1], d, account)).toMatchObject({ ok: false, index: 0 });
  });

  test("adds sessions and Autopilot grants only through the current Perpl order guard", async () => {
    const grant = deploymentPerplPermissions(d);
    expect(await checkOwnerCalls([addSession(grant), sel("revokeSession(address)", account)], d, account)).toEqual({ ok: true });
    // A replaced guard keeps its older rules (no leverage cap), and no guard trades at any price.
    const replaced = "0x697f40BaBD7f125a67E12CB6a65ca53e52c1084B" as const;
    expect(replaced.toLowerCase()).not.toBe(d.perplOrderGuard.toLowerCase());
    for (const guard of [replaced, zeroAddress]) {
      const stale = grant.map((p) => (p.guard === zeroAddress ? p : { ...p, guard }));
      expect(await checkOwnerCalls([addSession(stale)], d, account)).toEqual({ ok: false, index: 0, reason: "session Perpl orders must go through the current order guard" });
      const renewal = tradingPermissions(d).map((p) => (p.guard === zeroAddress ? p : { ...p, guard }));
      expect(await checkOwnerCalls([sel("revokeSession(address)", account), addSession(renewal)], d, account)).toMatchObject({ ok: false, index: 1 });
    }
    // A guard on anything else must be the current one too.
    const odd = [...grant, { target: d.outcomeMarkets, selector: toFunctionSelector("mint(bytes32,uint256,address)"), recipientArg: 3, guard: replaced }];
    expect(await checkOwnerCalls([addSession(odd)], d, account)).toMatchObject({ ok: false, reason: "a session permission names a guard other than the current Perpl order guard" });
  });

  test("allows only redemptions on a replaced OutcomeMarkets, and only with the passkey", async () => {
    const [legacy] = legacyOutcomeMarkets(10143);
    if (!legacy) throw new Error("Testnet lists a replaced OutcomeMarkets");
    const redeemSets = sel("redeemSets(bytes32,uint256,address)", legacy);
    const redeemWinnings = sel("redeemWinnings(bytes32,uint256,uint256,address)", legacy);
    expect(await checkOwnerCalls([redeemSets, redeemWinnings], d, account)).toEqual({ ok: true });
    expect(await checkOwnerCalls([redeemSets, sel("mint(bytes32,uint256,address)", legacy)], d, account)).toEqual({
      ok: false,
      reason: "a replaced OutcomeMarkets only redeems",
      index: 1,
    });
    expect(await checkOwnerCalls([sel("settle(bytes32)", legacy)], d, account)).toMatchObject({ ok: false, index: 0 });
    // Sessions never reach it: their permissions name the current deployment only.
    expect(await checkSessionCalls([redeemSets], d)).toMatchObject({ ok: false, index: 0 });
    // Another chain's deployment lists none.
    expect(await checkOwnerCalls([redeemSets], { ...d, chainId: 143 }, account)).toMatchObject({ ok: false, index: 0 });
  });

  test("allows trend coin trades and approvals of Trendr tokens to protocol contracts", async () => {
    const tokenApprove = (token: `0x${string}`, spender: `0x${string}`): Call => ({ ...approve(spender), target: token });
    expect(
      await checkOwnerCalls(
        [tokenApprove(up, d.trendrSpot), sel("sellWithLimit(address,uint256,uint256,address)", d.trendrSpot), sel("sell(bytes32,uint256,uint256,address,uint256)", d.bondingCurve)],
        d,
        account,
      ),
    ).toEqual({ ok: true });
    expect(await checkOwnerCalls([tokenApprove(up, other)], d, account)).toEqual({ ok: false, reason: "call is not on the relayer allowlist", index: 0 });
    expect(await checkOwnerCalls([tokenApprove(fake, d.trendrSpot)], d, account)).toEqual({ ok: false, reason: "approvals are limited to AUSD and Trendr tokens", index: 0 });
  });

  test("rejects other calls", async () => {
    expect(await checkOwnerCalls([sel("initialize(bytes32,bytes32,(address,uint48,uint128,(address,bytes4,uint8)[]),uint256,bytes)", account)], d, account)).toMatchObject({ ok: false });
    expect(await checkOwnerCalls([sel("transferFrom(address,address,uint256)", d.ausd)], d, account)).toMatchObject({ ok: false });
    expect(await checkOwnerCalls([sel("approve(address,uint256)", other)], d, account)).toMatchObject({ ok: false });
    // Transfers only of AUSD and Trendr tokens: any other contract's transfer could burn the gas.
    expect(await checkOwnerCalls([sel("transfer(address,uint256)", up), sel("transfer(address,uint256)", fake)], d, account)).toEqual({
      ok: false,
      reason: "transfers are limited to AUSD and Trendr tokens",
      index: 1,
    });
  });

  test("reads the chain only for token calls, and not at all for refused batches", async () => {
    asked.length = 0;
    await checkOwnerCalls([sel("transfer(address,uint256)", d.ausd), sel("depositPool(uint256)", d.attentionPerp)], d, account);
    await checkSessionCalls([approve(d.outcomeMarkets), sel("mint(bytes32,uint256,address)", d.outcomeMarkets)], d);
    expect(asked).toEqual([]);
    await checkSessionCalls([{ ...approve(d.trendrSpot), target: up }, sel("withdrawCollateral(uint256)", d.perplExchange)], d);
    expect(asked).toEqual([]);
    await checkSessionCalls([{ ...approve(d.trendrSpot), target: up }, { ...approve(d.outcomeMarkets), target: up }], d);
    expect(asked).toEqual([up, up]);
  });
});

describe("session config policy", () => {
  const now = 1_000_000;
  const cfg = { key: other, validUntil: now + 86_400, dailyLimit: 100_000_000n, permissions: tradingPermissions(d) };
  test("accepts the standard trading session", () => {
    expect(checkSessionConfig(cfg, d, now, 1_000_000_000n, 30 * 86_400)).toEqual({ ok: true });
  });
  test("rejects keys, lifetimes, limits and permissions outside policy", () => {
    expect(checkSessionConfig({ ...cfg, key: zeroAddress }, d, now, 1_000_000_000n, 30 * 86_400)).toMatchObject({ ok: false });
    expect(checkSessionConfig({ ...cfg, validUntil: now }, d, now, 1_000_000_000n, 30 * 86_400)).toMatchObject({ ok: false });
    expect(checkSessionConfig({ ...cfg, validUntil: now + 31 * 86_400 }, d, now, 1_000_000_000n, 30 * 86_400)).toMatchObject({ ok: false });
    expect(checkSessionConfig({ ...cfg, dailyLimit: 2_000_000_000n }, d, now, 1_000_000_000n, 30 * 86_400)).toMatchObject({ ok: false });
    const loose = { ...cfg, permissions: [{ ...cfg.permissions[0]!, recipientArg: 0 }, ...cfg.permissions.slice(1)] };
    expect(checkSessionConfig(loose, d, now, 1_000_000_000n, 30 * 86_400)).toMatchObject({ ok: false, index: 0 });
  });

  test("requires each Perpl order permission to name the deployment's order guard", () => {
    const orders = cfg.permissions.findIndex((p) => p.guard !== zeroAddress);
    expect(orders).toBeGreaterThan(0);
    expect(cfg.permissions[orders]!.guard).toBe(d.perplOrderGuard);
    const unguarded = cfg.permissions.map((p, i) => (i === orders ? { ...p, guard: zeroAddress } : p));
    expect(checkSessionConfig({ ...cfg, permissions: unguarded }, d, now, 1_000_000_000n, 30 * 86_400)).toMatchObject({ ok: false, index: orders });
    const otherGuard = cfg.permissions.map((p, i) => (i === orders ? { ...p, guard: other } : p));
    expect(checkSessionConfig({ ...cfg, permissions: otherGuard }, d, now, 1_000_000_000n, 30 * 86_400)).toMatchObject({ ok: false, index: orders });
  });

  test("an upgrade starts exactly one standard session", () => {
    expect(checkUpgradeSessions([cfg], d, now, 1_000_000_000n, 30 * 86_400)).toEqual({ ok: true });
    expect(checkUpgradeSessions([], d, now, 1_000_000_000n, 30 * 86_400)).toMatchObject({ ok: false });
    expect(checkUpgradeSessions([cfg, cfg], d, now, 1_000_000_000n, 30 * 86_400)).toMatchObject({ ok: false });
    expect(checkUpgradeSessions([{ ...cfg, dailyLimit: 2_000_000_000n }], d, now, 1_000_000_000n, 30 * 86_400)).toMatchObject({ ok: false });
  });

  test("requires exactly the standard permissions, so activation gas is fixed", () => {
    const check = (permissions: typeof cfg.permissions) => checkSessionConfig({ ...cfg, permissions }, d, now, 1_000_000_000n, 30 * 86_400);
    // Order does not matter.
    expect(check([...cfg.permissions].reverse())).toEqual({ ok: true });
    // A subset, a padded list and a repeated permission are all refused.
    expect(check(cfg.permissions.slice(1))).toMatchObject({ ok: false, reason: expect.stringContaining("all") });
    expect(check([])).toMatchObject({ ok: false });
    const repeated = [...cfg.permissions.slice(0, -1), cfg.permissions[0]!];
    expect(check(repeated)).toEqual({ ok: false, reason: "session permission is listed twice", index: repeated.length - 1 });
    expect(check([...cfg.permissions, cfg.permissions[0]!])).toMatchObject({ ok: false, index: cfg.permissions.length });
  });
});

describe("rate limiter", () => {
  test("refills over time", () => {
    let t = 0;
    const rl = new RateLimiter(2, 1, () => t);
    expect(rl.take("a")).toBe(true);
    expect(rl.take("a")).toBe(true);
    expect(rl.take("a")).toBe(false);
    expect(rl.take("b")).toBe(true);
    t = 1;
    expect(rl.take("a")).toBe(true);
    expect(rl.take("a")).toBe(false);
  });
});
