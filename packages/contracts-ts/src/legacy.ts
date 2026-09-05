import { type Address, type Hex, isAddressEqual } from "viem";
import type { Deployment } from "./deployments";

/**
 * OutcomeMarkets deployments a chain has replaced whose series still hold tokens. Nothing new is
 * opened or minted there; holders only redeem (complete sets at any time, winnings once settled),
 * so the app reads their holdings and the relayer sponsors those two calls in owner batches. The
 * indexer's config.yaml lists the same addresses.
 */
const LEGACY_OUTCOME_MARKETS: Record<number, readonly Address[]> = {
  10143: ["0xAA875b308669Dd8ed64044DD48F2286E939b54C2"],
};

export function legacyOutcomeMarkets(chainId: number): readonly Address[] {
  return LEGACY_OUTCOME_MARKETS[chainId] ?? [];
}

/**
 * PasskeyAccount version 1 implementations a chain has replaced. Accounts delegating to one keep
 * working (owner batches, their version 1 sessions) until they move to the deployment's
 * PasskeyAccount with one `upgrade`, which the relayer sponsors for them alone. The indexer's
 * constants list the same addresses.
 */
const LEGACY_PASSKEY_ACCOUNTS: Record<number, readonly Address[]> = {
  10143: ["0xdF6C6019C70fC321211A0483E74E2DDe839fa955"],
};

export function legacyPasskeyAccounts(chainId: number): readonly Address[] {
  return LEGACY_PASSKEY_ACCOUNTS[chainId] ?? [];
}

/**
 * The PasskeyAccount version an EIP-7702 delegate runs on this deployment's chain: 2 for the
 * deployment's own, 1 for a replaced version 1, null for anything else.
 */
export function passkeyAccountVersion(
  d: Pick<Deployment, "chainId" | "passkeyAccount">,
  delegate: Address | null,
  legacy: readonly Address[] = legacyPasskeyAccounts(d.chainId),
): 1 | 2 | null {
  if (!delegate) return null;
  if (isAddressEqual(delegate, d.passkeyAccount)) return 2;
  return legacy.some((a) => isAddressEqual(a, delegate)) ? 1 : null;
}

/** The delegate an EIP-7702 account's code names (0xef0100 || address), or null. */
export function delegateOf(code: Hex | undefined | null): Address | null {
  const c = code?.toLowerCase();
  return c && c.length === 48 && c.startsWith("0xef0100") ? (`0x${c.slice(8)}` as Address) : null;
}
