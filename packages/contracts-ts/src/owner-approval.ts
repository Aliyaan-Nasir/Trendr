import { type Address, getAddress, type Hex, hashTypedData, keccak256, stringToBytes } from "viem";

/**
 * Owner approvals for backend actions. A few records keep acting for an account after the session
 * that created them is gone: following a leader (and resuming a follow), enabling an Autopilot rule,
 * and linking a caller identity. The backend accepts those only with a fresh assertion from the
 * account's passkey, verified against PasskeyAccount's `owner()` key, so a stolen session key cannot
 * make them.
 *
 * The passkey signs, as its WebAuthn challenge, the EIP-712 digest of an `OwnerApproval`: the
 * action, the account, a hash of the action's parameters, and a single-use nonce the backend issued
 * with an expiry, under a domain bound to the chain. The domain is not the account's own, so an
 * approval can never pass for an on-chain owner batch, and the reverse.
 */

export const OWNER_ACTIONS = ["follow", "enable-rule", "link-identity"] as const;
export type OwnerAction = (typeof OWNER_ACTIONS)[number];

/** One action to approve: its kind and exactly the parameters the backend will act on. */
export interface OwnerRequest {
  action: OwnerAction;
  params: unknown;
}

/** What the backend issues before the prompt. */
export interface OwnerChallenge {
  nonce: Hex;
  expiresAt: number;
  chainId: number;
}

/** A WebAuthn assertion as the backend verifies it: s is in the low half of the curve order. */
export interface OwnerAssertion {
  authenticatorData: Hex;
  clientDataJSON: string;
  r: Hex;
  s: Hex;
}

/** What an approved request carries: the nonce it was issued with and the passkey's assertion. */
export interface OwnerApproval extends OwnerAssertion {
  nonce: Hex;
}

/** The request each action's approval covers. The backend builds the same from what it receives. */
export const ownerRequests = {
  /** Starting a follow or changing its caps: the leader and the settings exactly as sent, slippage limit and loss cap included. */
  follow: (leader: string, settings: unknown): OwnerRequest => ({ action: "follow", params: { leader: leader.toLowerCase(), settings } }),
  /** Resuming a paused follow. */
  resumeFollow: (followId: number): OwnerRequest => ({ action: "follow", params: { follow: followId, status: "active" } }),
  /** Enabling (or resuming) a rule, pinned to the exact rule that was backtested. */
  enableRule: (ruleId: number, ruleHash: string): OwnerRequest => ({ action: "enable-rule", params: { rule: ruleId, ruleHash: ruleHash.toLowerCase() } }),
  /** Linking a caller identity to the account. */
  linkIdentity: (identity: string): OwnerRequest => ({ action: "link-identity", params: { identity: identity.toLowerCase() } }),
};

/** JSON with object keys sorted at every level, so both ends hash the same bytes for the same value. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("canonicalJson: numbers must be finite");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map((v) => canonicalJson(v ?? null)).join(",")}]`;
  if (typeof value === "object") {
    const o = value as Record<string, unknown>;
    const keys = Object.keys(o)
      .filter((k) => o[k] !== undefined)
      .sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(o[k])}`).join(",")}}`;
  }
  throw new Error(`canonicalJson: cannot encode a ${typeof value}`);
}

export const ownerParamsHash = (params: unknown): Hex => keccak256(stringToBytes(canonicalJson(params)));

export function ownerApprovalDomain(chainId: number) {
  return { name: "Trendr API", version: "1", chainId } as const;
}

export const ownerApprovalTypes = {
  OwnerApproval: [
    { name: "action", type: "string" },
    { name: "account", type: "address" },
    { name: "paramsHash", type: "bytes32" },
    { name: "nonce", type: "bytes32" },
    { name: "expiresAt", type: "uint256" },
  ],
} as const;

/** The digest the passkey signs (as its WebAuthn challenge) to approve `request` for `account`. */
export function ownerApprovalDigest(a: { chainId: number; account: Address; request: OwnerRequest; nonce: Hex; expiresAt: number }): Hex {
  return hashTypedData({
    domain: ownerApprovalDomain(a.chainId),
    types: ownerApprovalTypes,
    primaryType: "OwnerApproval",
    message: { action: a.request.action, account: getAddress(a.account), paramsHash: ownerParamsHash(a.request.params), nonce: a.nonce, expiresAt: BigInt(a.expiresAt) },
  });
}
