import { type OwnerAction, type OwnerApproval, type OwnerAssertion, type OwnerChallenge, ownerApprovalDigest, type OwnerRequest } from "@trendr/contracts";
import type { Address, Hex } from "viem";

/**
 * Approving a backend action with the passkey: following (or resuming a follow), enabling a rule
 * and linking a caller identity outlive the session that asks for them, so the backend wants the
 * account's passkey to sign each one. The backend issues a single-use nonce, the passkey signs the
 * digest of exactly this request with it (one prompt), and the request carries both.
 */

export interface ApproveDeps {
  account: Address;
  chainId: number;
  /** Asks the backend for a nonce (signed in). */
  challenge: (action: OwnerAction) => Promise<OwnerChallenge>;
  /** The passkey prompt: signs the digest as its WebAuthn challenge. */
  sign: (digest: Hex) => Promise<OwnerAssertion>;
}

export async function approveAsOwner(d: ApproveDeps, request: OwnerRequest): Promise<OwnerApproval> {
  const challenge = await d.challenge(request.action);
  // An approval names its chain; one for another network would only be refused after the prompt.
  if (challenge.chainId !== d.chainId) throw new Error(`Trendr's server runs on chain ${challenge.chainId}, but this app is on chain ${d.chainId}.`);
  const digest = ownerApprovalDigest({ chainId: d.chainId, account: d.account, request, nonce: challenge.nonce, expiresAt: challenge.expiresAt });
  return { nonce: challenge.nonce, ...(await d.sign(digest)) };
}
