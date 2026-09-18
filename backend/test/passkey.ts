import { createHash } from "node:crypto";
import { base64url, type OwnerApproval, type OwnerAssertion, type OwnerChallenge, ownerApprovalDigest, type OwnerRequest } from "@trendr/contracts";
import { type Address, bytesToHex, type Hex, hexToBytes } from "viem";

/**
 * A software passkey for tests: a P256 key that answers WebAuthn assertions the way a platform
 * authenticator does (user present and verified, a "webauthn.get" client data), with switches to
 * break each property the backend checks.
 */

const P256_N = 0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551n;
const word = (n: bigint): Hex => `0x${n.toString(16).padStart(64, "0")}`;

export interface AssertOptions {
  /** authenticatorData flags; 0x05 is user present and user verified. */
  flags?: number;
  type?: string;
  crossOrigin?: boolean;
  /** Sends s in the high half of the curve order (still a valid ECDSA signature). */
  highS?: boolean;
}

export async function testPasskey(rpId = "localhost") {
  const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
  const point = new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey));
  const x = bytesToHex(point.slice(1, 33));
  const y = bytesToHex(point.slice(33, 65));
  let signCount = 0;

  async function assert(challenge: Hex, o: AssertOptions = {}): Promise<OwnerAssertion> {
    signCount++;
    const authenticatorData = new Uint8Array([...createHash("sha256").update(rpId).digest(), o.flags ?? 0x05, 0, 0, signCount >> 8, signCount & 0xff]);
    const clientDataJSON = JSON.stringify({ type: o.type ?? "webauthn.get", challenge: base64url(hexToBytes(challenge)), origin: `http://${rpId}:3000`, crossOrigin: o.crossOrigin ?? false });
    const signed = new Uint8Array([...authenticatorData, ...createHash("sha256").update(clientDataJSON).digest()]);
    const signature = new Uint8Array(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, pair.privateKey, signed));
    const r = BigInt(bytesToHex(signature.slice(0, 32)));
    const raw = BigInt(bytesToHex(signature.slice(32)));
    const low = raw > P256_N / 2n ? P256_N - raw : raw;
    return { authenticatorData: bytesToHex(authenticatorData), clientDataJSON, r: word(r), s: word(o.highS ? P256_N - low : low) };
  }

  /** The approval of `request` for `account` with a challenge the backend issued. */
  async function approve(account: Address, request: OwnerRequest, challenge: OwnerChallenge, o?: AssertOptions): Promise<OwnerApproval> {
    const digest = ownerApprovalDigest({ chainId: challenge.chainId, account, request, nonce: challenge.nonce, expiresAt: challenge.expiresAt });
    return { nonce: challenge.nonce, ...(await assert(digest, o)) };
  }

  return { x, y, owner: [x, y] as const, assert, approve };
}

export type TestPasskey = Awaited<ReturnType<typeof testPasskey>>;
