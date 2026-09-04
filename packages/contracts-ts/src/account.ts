import {
  type Address,
  encodeAbiParameters,
  encodeFunctionData,
  encodePacked,
  type Hex,
  hashTypedData,
  keccak256,
  toFunctionSelector,
} from "viem";
import { attentionPerpAbi, outcomeMarketsAbi, passkeyAccountAbi, trendrSpotAbi } from "./abis";
import type { Deployment } from "./deployments";

/** One call in a PasskeyAccount batch. */
export interface Call {
  target: Address;
  value: bigint;
  data: Hex;
}

/** A session permission: `selector` on `target`, or with selector zero, an approved spender. */
export interface Permission {
  target: Address;
  selector: Hex;
  /** 1-based address argument that must equal the account, or 0. */
  recipientArg: number;
  /** A guard contract (IPermissionGuard) that must approve each call, or the zero address. */
  guard: Address;
}

/** The PasskeyAccount version this package's ABI and helpers are for. */
export const PASSKEY_ACCOUNT_VERSION = 2;

export interface SessionConfig {
  key: Address;
  validUntil: number;
  dailyLimit: bigint;
  permissions: Permission[];
}

/** The EIP-712 domain PasskeyAccount signs under; the account is its own verifying contract. */
export function accountDomain(chainId: number, account: Address) {
  return { name: "Trendr PasskeyAccount", version: "1", chainId, verifyingContract: account } as const;
}

export const initializeTypes = {
  Initialize: [
    { name: "ownerX", type: "bytes32" },
    { name: "ownerY", type: "bytes32" },
    { name: "sessionHash", type: "bytes32" },
    { name: "deadline", type: "uint256" },
  ],
} as const;

export const ownerExecuteTypes = {
  OwnerExecute: [
    { name: "callsHash", type: "bytes32" },
    { name: "nonce", type: "uint256" },
    { name: "deadline", type: "uint256" },
  ],
} as const;

export const upgradeTypes = {
  Upgrade: [
    { name: "sessionsHash", type: "bytes32" },
    { name: "deadline", type: "uint256" },
  ],
} as const;

export const sessionExecuteTypes = {
  SessionExecute: [
    { name: "callsHash", type: "bytes32" },
    { name: "sessionKey", type: "address" },
    { name: "nonce", type: "uint256" },
    { name: "deadline", type: "uint256" },
  ],
} as const;

/** keccak256 over each call's keccak256(abi.encode(target, value, keccak256(data))), packed. */
export function callsHash(calls: readonly Call[]): Hex {
  const hashes = calls.map((c) =>
    keccak256(
      encodeAbiParameters(
        [{ type: "address" }, { type: "uint256" }, { type: "bytes32" }],
        [c.target, c.value, keccak256(c.data)],
      ),
    ),
  );
  return keccak256(encodePacked(hashes.map(() => "bytes32"), hashes));
}

/** keccak256(abi.encode(key, validUntil, dailyLimit, keccak256(abi.encode(permissions)))). */
export function sessionHash(s: SessionConfig): Hex {
  const permissions = keccak256(
    encodeAbiParameters(
      [
        {
          type: "tuple[]",
          components: [
            { name: "target", type: "address" },
            { name: "selector", type: "bytes4" },
            { name: "recipientArg", type: "uint8" },
            { name: "guard", type: "address" },
          ],
        },
      ],
      [s.permissions],
    ),
  );
  return keccak256(
    encodeAbiParameters(
      [{ type: "address" }, { type: "uint48" }, { type: "uint128" }, { type: "bytes32" }],
      [s.key, s.validUntil, s.dailyLimit, permissions],
    ),
  );
}

/** keccak256 over each session's sessionHash, packed, as `upgrade` signs them. */
export function sessionsHash(sessions: readonly SessionConfig[]): Hex {
  const hashes = sessions.map(sessionHash);
  return keccak256(encodePacked(hashes.map(() => "bytes32"), hashes));
}

/**
 * What the account key signs to move a version 1 account to this version: the sessions to start.
 * The domain is the account's own, unchanged from version 1, so the account may still run version
 * 1 when this is signed.
 */
export function upgradeTypedData(chainId: number, account: Address, sessions: readonly SessionConfig[], deadline: bigint) {
  return {
    domain: accountDomain(chainId, account),
    types: upgradeTypes,
    primaryType: "Upgrade" as const,
    message: { sessionsHash: sessionsHash(sessions), deadline },
  };
}

export function initializeTypedData(
  chainId: number,
  account: Address,
  owner: { x: Hex; y: Hex },
  session: SessionConfig,
  deadline: bigint,
) {
  return {
    domain: accountDomain(chainId, account),
    types: initializeTypes,
    primaryType: "Initialize" as const,
    message: { ownerX: owner.x, ownerY: owner.y, sessionHash: sessionHash(session), deadline },
  };
}

export function sessionExecuteTypedData(
  chainId: number,
  account: Address,
  calls: readonly Call[],
  sessionKey: Address,
  nonce: bigint,
  deadline: bigint,
) {
  return {
    domain: accountDomain(chainId, account),
    types: sessionExecuteTypes,
    primaryType: "SessionExecute" as const,
    message: { callsHash: callsHash(calls), sessionKey, nonce, deadline },
  };
}

/** The digest a passkey assertion signs (as its WebAuthn challenge) for an owner batch. */
export function ownerExecuteDigest(
  chainId: number,
  account: Address,
  calls: readonly Call[],
  nonce: bigint,
  deadline: bigint,
): Hex {
  return hashTypedData({
    domain: accountDomain(chainId, account),
    types: ownerExecuteTypes,
    primaryType: "OwnerExecute",
    message: { callsHash: callsHash(calls), nonce, deadline },
  });
}

const ZERO_SELECTOR: Hex = "0x00000000";
const NO_GUARD: Address = "0x0000000000000000000000000000000000000000";

function selector(abi: readonly unknown[], name: string): Hex {
  const item = (abi as Array<{ type: string; name?: string; inputs?: Array<{ type: string }> }>).find(
    (x) => x.type === "function" && x.name === name,
  );
  if (!item) throw new Error(`no function ${name}`);
  return toFunctionSelector(`${name}(${(item.inputs ?? []).map((i) => i.type).join(",")})`);
}

const PERPL_ORDER = "(uint256,uint256,uint8,uint256,uint256,uint256,uint256,bool,bool,bool,uint256,uint256,uint256,uint256,uint256)";

/**
 * Perpl's order guard (PerplOrderGuard) lets a session order only immediate-or-cancel opens and
 * closes priced within this many basis points of Perpl's on-chain mark price. Trendr's own clients
 * keep within 1% of their reference so their orders always pass.
 */
export const PERPL_ORDER_BAND_BPS = 200;

/**
 * The highest leverage a session may open or add to a Perpl position at: the order guard's cap,
 * fixed when the guard was deployed (10x unless the deploy chose otherwise). Closes are not capped.
 * Higher leverage is a passkey action. Zero where the deployment has no Perpl.
 */
export function perplSessionMaxLeverage(d: Pick<Deployment, "perplSessionMaxLeverageHdths">): number {
  return (d.perplSessionMaxLeverageHdths ?? 0) / 100;
}

/**
 * Perpl trading from a session: opening the Perpl account, depositing, adding margin and orders on
 * the account's own positions, every order checked by Perpl's order guard (price band and leverage
 * cap). Turning on order forwarding and withdrawing stay passkey actions.
 */
export function perplPermissions(exchange: Address, guard: Address): Permission[] {
  if (exchange === NO_GUARD || guard === NO_GUARD) return [];
  return [
    { target: exchange, selector: toFunctionSelector(`execOrder(${PERPL_ORDER})`), recipientArg: 0, guard },
    { target: exchange, selector: toFunctionSelector(`execOrders(${PERPL_ORDER}[],bool)`), recipientArg: 0, guard },
    { target: exchange, selector: toFunctionSelector("createAccount(uint256)"), recipientArg: 0, guard: NO_GUARD },
    { target: exchange, selector: toFunctionSelector("depositCollateral(uint256)"), recipientArg: 0, guard: NO_GUARD },
    { target: exchange, selector: toFunctionSelector("increasePositionCollateral(uint256,uint256)"), recipientArg: 0, guard: NO_GUARD },
    { target: exchange, selector: ZERO_SELECTOR, recipientArg: 0, guard: NO_GUARD },
  ];
}

/** Perpl permissions for a deployment, with its order guard. */
export function deploymentPerplPermissions(d: Deployment): Permission[] {
  return perplPermissions(d.perplExchange ?? NO_GUARD, d.perplOrderGuard ?? NO_GUARD);
}

/**
 * Permissions for an everyday trading session: outcome sets, attention perps, UP and DOWN spot
 * trades through TrendrSpot and Perpl perpetuals, with every recipient argument pinned to the
 * account and approvals only to those contracts. Adding margin is a passkey action: the Testnet
 * AttentionPerp lets anyone top up any position, so a stolen session key could fund one its holder
 * owns (later deployments limit addMargin to the position's owner).
 *
 * Every price a session trades at is anchored: sets mint and redeem at 1 AUSD, perps open and
 * close at the index, TrendrSpot's `buy` and `sell` trade only within 0.10 AUSD of the
 * attention-implied value, and Perpl orders only immediately and within PERPL_ORDER_BAND_BPS of
 * Perpl's mark, opening at no more than perplSessionMaxLeverage (the order guard). Trend coins have no such anchor (a stolen key could sell them into
 * its holder's bid or buy them from its holder's ask), so trading them on the curve or on Kuru is a
 * passkey action, as are TrendrSpot's `buyWithLimit` and `sellWithLimit`. The daily limit counts
 * every call's AUSD outflow (gross), so what a batch brings in never pays for more spending.
 */
export function tradingPermissions(d: Deployment): Permission[] {
  const p = (target: Address, sel: Hex, recipientArg: number): Permission => ({ target, selector: sel, recipientArg, guard: NO_GUARD });
  return [
    p(d.outcomeMarkets, selector(outcomeMarketsAbi, "mint"), 3),
    p(d.outcomeMarkets, selector(outcomeMarketsAbi, "redeemSets"), 3),
    p(d.outcomeMarkets, selector(outcomeMarketsAbi, "redeemWinnings"), 4),
    p(d.outcomeMarkets, ZERO_SELECTOR, 0),
    p(d.attentionPerp, selector(attentionPerpAbi, "open"), 0),
    p(d.attentionPerp, selector(attentionPerpAbi, "close"), 0),
    p(d.attentionPerp, ZERO_SELECTOR, 0),
    p(d.trendrSpot, selector(trendrSpotAbi, "buy"), 4),
    p(d.trendrSpot, selector(trendrSpotAbi, "sell"), 4),
    p(d.trendrSpot, ZERO_SELECTOR, 0),
    ...deploymentPerplPermissions(d),
  ];
}

/**
 * A permission only sessions carrying the current tradingPermissions hold. Adding a session
 * replaces all of its permissions, so a session without this one was added under an older set
 * (before TrendrSpot's band, or naming a replaced Perpl order guard) and needs renewing before it
 * can trade. Where Perpl is deployed it is the guarded `execOrder`, so a session holds it only if
 * `guardOf` names the deployment's current guard; elsewhere `isPermitted` checks TrendrSpot's `sell`.
 */
export function sessionMarker(d: Deployment): Permission {
  return deploymentPerplPermissions(d)[0] ?? { target: d.trendrSpot, selector: selector(trendrSpotAbi, "sell"), recipientArg: 4, guard: NO_GUARD };
}

export function encodeInitialize(
  owner: { x: Hex; y: Hex },
  session: SessionConfig,
  deadline: bigint,
  eoaSignature: Hex,
): Hex {
  return encodeFunctionData({
    abi: passkeyAccountAbi,
    functionName: "initialize",
    args: [owner.x, owner.y, session, deadline, eoaSignature],
  });
}

/** `upgrade(sessions, deadline, eoaSignature)`, sent with the EIP-7702 authorization to this version. */
export function encodeUpgrade(sessions: readonly SessionConfig[], deadline: bigint, eoaSignature: Hex): Hex {
  return encodeFunctionData({
    abi: passkeyAccountAbi,
    functionName: "upgrade",
    args: [sessions, deadline, eoaSignature],
  });
}

export function encodeExecuteWithSession(calls: readonly Call[], sessionKey: Address, deadline: bigint, signature: Hex): Hex {
  return encodeFunctionData({
    abi: passkeyAccountAbi,
    functionName: "executeWithSession",
    args: [calls, sessionKey, deadline, signature],
  });
}

export interface WebAuthnAuth {
  authenticatorData: Hex;
  clientDataJSON: string;
  challengeIndex: bigint;
  typeIndex: bigint;
  r: Hex;
  s: Hex;
}

export function encodeExecuteAsOwner(calls: readonly Call[], deadline: bigint, auth: WebAuthnAuth): Hex {
  return encodeFunctionData({
    abi: passkeyAccountAbi,
    functionName: "executeAsOwner",
    args: [calls, deadline, auth],
  });
}
