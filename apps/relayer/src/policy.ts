import {
  type Call,
  type Deployment,
  deploymentPerplPermissions,
  legacyOutcomeMarkets,
  outcomeMarketsAbi,
  passkeyAccountAbi,
  type SessionConfig,
  stableSwapAbi,
  tradingPermissions,
  type UsdcConversion,
  usdcConversion,
} from "@trendr/contracts";
import { type Address, decodeFunctionData, erc20Abi, getAbiItem, type Hex, isAddressEqual, toFunctionSelector, zeroAddress } from "viem";
import type { TrendrTokens } from "./tokens";

/**
 * What the relayer pays gas for. The account contract enforces its own session rules; this is the
 * relayer's separate allowlist, so it never sponsors calls outside the Trendr protocol. Token
 * calls are limited to AUSD and Trendr tokens, checked on chain: a token contract of the caller's
 * choosing could burn the whole gas limit in `approve` or `transfer` and still succeed.
 */

export type PolicyResult = { ok: true } | { ok: false; reason: string; index?: number };

export const MAX_CALLS = 8;
const OK: PolicyResult = { ok: true };
const fail = (reason: string, index?: number): PolicyResult => ({ ok: false, reason, index });

const APPROVE = toFunctionSelector("approve(address,uint256)");
const TRANSFER = toFunctionSelector("transfer(address,uint256)");
/** Version 2's addSession (permissions carry a guard); version 1 accounts upgrade instead of renewing. */
const ADD_SESSION = toFunctionSelector(getAbiItem({ abi: passkeyAccountAbi, name: "addSession" }));
const REVOKE_SESSION = toFunctionSelector(getAbiItem({ abi: passkeyAccountAbi, name: "revokeSession" }));
/** What holders may still do on a replaced OutcomeMarkets: take their collateral back. */
const LEGACY_REDEEM = (["redeemSets", "redeemWinnings"] as const).map((name) => toFunctionSelector(getAbiItem({ abi: outcomeMarketsAbi, name })).toLowerCase());

function selectorOf(data: Hex): Hex | null {
  return data.length >= 10 ? (data.slice(0, 10).toLowerCase() as Hex) : null;
}

/** Contracts a session may approve AUSD to and trade with, and an owner may call. */
export function protocolTargets(d: Deployment): Address[] {
  const targets = [d.outcomeMarkets, d.attentionPerp, d.bondingCurve, d.trendrSpot];
  if (d.perplExchange && !isAddressEqual(d.perplExchange, zeroAddress)) targets.push(d.perplExchange);
  return targets;
}

function isOneOf(a: Address, list: readonly Address[]): boolean {
  return list.some((x) => isAddressEqual(a, x));
}

function approvedSpender(data: Hex): Address | null {
  try {
    const { functionName, args } = decodeFunctionData({ abi: erc20Abi, data });
    return functionName === "approve" ? (args[0] as Address) : null;
  } catch {
    return null;
  }
}

/**
 * Why a call to the stable pool is not exactly the account's USDC to AUSD conversion (owner batches
 * on chains with a conversion, Mainnet): `exchange` of USDC for AUSD, paid to the account itself,
 * with a minimum out. Null when it is.
 */
function conversionProblem(data: Hex, c: UsdcConversion, account: Address): string | null {
  try {
    const { functionName, args } = decodeFunctionData({ abi: stableSwapAbi, data });
    if (functionName !== "exchange") return "the conversion pool only exchanges";
    const [i, j, , minOut, receiver] = args;
    if (i !== c.usdcIndex || j !== c.ausdIndex) return "the conversion pool only exchanges USDC for AUSD";
    if (!isAddressEqual(receiver, account)) return "a conversion pays the account itself";
    if (minOut === 0n) return "a conversion needs a minimum out";
    return null;
  } catch {
    return "the conversion pool only exchanges";
  }
}

function common(calls: readonly Call[]): PolicyResult {
  if (calls.length === 0) return fail("empty batch");
  if (calls.length > MAX_CALLS) return fail(`at most ${MAX_CALLS} calls per batch`);
  for (const [i, c] of calls.entries()) {
    if (c.value !== 0n) return fail("calls may not send MON", i);
    if (selectorOf(c.data) === null) return fail("call data too short", i);
  }
  return OK;
}

/**
 * Session batches: the trading allowlist, and approvals of AUSD (to trade) or of a Trendr token (UP
 * or DOWN, to sell through TrendrSpot) to the contracts a session may approve. The account
 * requires every approval to be used in the batch, so none can outlive it.
 */
export async function checkSessionCalls(calls: readonly Call[], d: Deployment, tokens: TrendrTokens): Promise<PolicyResult> {
  const base = common(calls);
  if (!base.ok) return base;
  const permissions = tradingPermissions(d);
  const allowed = permissions.filter((p) => p.selector !== "0x00000000");
  // Selector zero marks the spenders a session may approve.
  const spenders = permissions.filter((p) => p.selector === "0x00000000").map((p) => p.target);
  const unverified: TokenCall[] = [];
  for (const [i, c] of calls.entries()) {
    const sel = selectorOf(c.data)!;
    if (sel === APPROVE) {
      const spender = approvedSpender(c.data);
      if (!spender || !isOneOf(spender, spenders)) return fail("approvals are limited to protocol contracts", i);
      if (!isAddressEqual(c.target, d.ausd)) unverified.push({ index: i, token: c.target });
      continue;
    }
    if (isAddressEqual(c.target, d.ausd)) return fail("AUSD calls are limited to approvals of protocol contracts", i);
    if (allowed.some((p) => isAddressEqual(p.target, c.target) && p.selector.toLowerCase() === sel)) continue;
    return fail("call is not on the relayer allowlist", i);
  }
  return checkTokens(unverified, tokens, "approvals are limited to AUSD and Trendr tokens");
}

/**
 * Why an owner's `addSession` is not sponsored, or null. Every guard a permission names must be the
 * deployment's Perpl order guard, and Perpl orders must name it: a session naming a replaced guard
 * would keep that guard's older rules (no leverage cap, for one), and one without a guard could
 * trade Perpl at any price. Anything else a session may do is the owner's choice.
 */
function addSessionProblem(data: Hex, d: Deployment): string | null {
  let permissions: readonly { target: Address; selector: Hex; guard: Address }[];
  try {
    const decoded = decodeFunctionData({ abi: passkeyAccountAbi, data });
    if (decoded.functionName !== "addSession") return "only session management may target the account";
    permissions = decoded.args[0].permissions;
  } catch {
    return "a session must be added in the current format";
  }
  const guard = d.perplOrderGuard ?? zeroAddress;
  const orders = deploymentPerplPermissions(d).filter((p) => !isAddressEqual(p.guard, zeroAddress));
  for (const p of permissions) {
    const isOrder = orders.some((o) => isAddressEqual(o.target, p.target) && o.selector.toLowerCase() === p.selector.toLowerCase());
    if (isOrder && !isAddressEqual(p.guard, guard)) return "session Perpl orders must go through the current order guard";
    if (!isOrder && !isAddressEqual(p.guard, zeroAddress) && !isAddressEqual(p.guard, guard)) return "a session permission names a guard other than the current Perpl order guard";
  }
  return null;
}

/**
 * Owner batches, authorized by the passkey: session management on the account itself (sessions
 * whose guards are current, see addSessionProblem), AUSD transfers and approvals, any call into protocol contracts, redemptions on a replaced
 * OutcomeMarkets, transfers of Trendr tokens and their approvals to protocol contracts (to sell
 * through TrendrSpot at the owner's limit), and on Mainnet the USDC to AUSD conversion of an Aurora
 * deposit (approving USDC to the stable pool, and its exchange paying the account).
 */
export async function checkOwnerCalls(
  calls: readonly Call[],
  d: Deployment,
  account: Address,
  tokens: TrendrTokens,
): Promise<PolicyResult> {
  const base = common(calls);
  if (!base.ok) return base;
  const unverified: TokenCall[] = [];
  const approvals: TokenCall[] = [];
  for (const [i, c] of calls.entries()) {
    const sel = selectorOf(c.data)!;
    if (isAddressEqual(c.target, account)) {
      if (sel === REVOKE_SESSION) continue;
      if (sel === ADD_SESSION) {
        const problem = addSessionProblem(c.data, d);
        if (problem) return fail(problem, i);
        continue;
      }
      return fail("only session management may target the account", i);
    }
    const conversion = usdcConversion(d.chainId);
    if (conversion && isAddressEqual(c.target, conversion.usdc)) {
      const spender = sel === APPROVE ? approvedSpender(c.data) : null;
      if (spender && isAddressEqual(spender, conversion.pool)) continue;
      return fail("USDC calls are limited to approving the conversion pool", i);
    }
    if (conversion && isAddressEqual(c.target, conversion.pool)) {
      const problem = conversionProblem(c.data, conversion, account);
      if (problem) return fail(problem, i);
      continue;
    }
    if (isAddressEqual(c.target, d.ausd)) {
      if (sel === TRANSFER || sel === APPROVE) continue;
      return fail("AUSD calls are limited to transfers and approvals", i);
    }
    if (isOneOf(c.target, [...protocolTargets(d), d.curationFees])) continue;
    if (isOneOf(c.target, legacyOutcomeMarkets(d.chainId))) {
      if (LEGACY_REDEEM.includes(sel)) continue;
      return fail("a replaced OutcomeMarkets only redeems", i);
    }
    if (sel === TRANSFER) {
      unverified.push({ index: i, token: c.target });
      continue;
    }
    if (sel === APPROVE) {
      const spender = approvedSpender(c.data);
      if (spender && isOneOf(spender, protocolTargets(d))) {
        approvals.push({ index: i, token: c.target });
        continue;
      }
    }
    return fail("call is not on the relayer allowlist", i);
  }
  const transfers = await checkTokens(unverified, tokens, "transfers are limited to AUSD and Trendr tokens");
  return transfers.ok ? checkTokens(approvals, tokens, "approvals are limited to AUSD and Trendr tokens") : transfers;
}

interface TokenCall {
  index: number;
  token: Address;
}

/** Fails at the first call whose target is not a Trendr token; reads the chain in parallel. */
async function checkTokens(list: readonly TokenCall[], tokens: TrendrTokens, reason: string): Promise<PolicyResult> {
  const answers = await Promise.all(list.map((t) => tokens.isTrendrToken(t.token)));
  const bad = list.find((_, j) => !answers[j]);
  return bad ? fail(reason, bad.index) : OK;
}

/**
 * Session configurations the relayer sponsors at activation and upgrade: exactly the app's standard
 * trading permissions (with their guards), each once. Activation writes one slot per permission, so
 * this also fixes its gas.
 */
export function checkSessionConfig(
  s: SessionConfig,
  d: Deployment,
  now: number,
  maxDailyLimit: bigint,
  maxLifetime: number,
): PolicyResult {
  if (isAddressEqual(s.key, zeroAddress)) return fail("session key is required");
  if (s.validUntil <= now) return fail("session already expired");
  if (s.validUntil > now + maxLifetime) return fail("session lasts too long");
  if (s.dailyLimit > maxDailyLimit) return fail("session daily limit too high");
  const standard = tradingPermissions(d);
  const seen = new Set<number>();
  for (const [i, p] of s.permissions.entries()) {
    const j = standard.findIndex(
      (a) =>
        isAddressEqual(a.target, p.target) &&
        a.selector.toLowerCase() === p.selector.toLowerCase() &&
        a.recipientArg === p.recipientArg &&
        isAddressEqual(a.guard, p.guard),
    );
    if (j < 0) return fail("session permission is not a standard trading permission", i);
    if (seen.has(j)) return fail("session permission is listed twice", i);
    seen.add(j);
  }
  if (seen.size !== standard.length) return fail(`a session must carry all ${standard.length} standard trading permissions`);
  return OK;
}

/**
 * What an upgrade may start: the account's one trading session, a standard one. Anything else a
 * version 1 account had (an Autopilot grant) is added again with the passkey, like any new session.
 */
export function checkUpgradeSessions(sessions: readonly SessionConfig[], d: Deployment, now: number, maxDailyLimit: bigint, maxLifetime: number): PolicyResult {
  if (sessions.length !== 1) return fail("an upgrade starts exactly one trading session");
  return checkSessionConfig(sessions[0]!, d, now, maxDailyLimit, maxLifetime);
}

/** Decodes an owner call to the account for logging, or null. */
export function describeAccountCall(data: Hex): string | null {
  try {
    return decodeFunctionData({ abi: passkeyAccountAbi, data }).functionName;
  } catch {
    return null;
  }
}
