import { bytesToHex, type Hex, hexToBytes } from "viem";
import type { WebAuthnAuth } from "./account";

/**
 * Converting WebAuthn assertions into PasskeyAccount's `WebAuthnAuth`. The passkey signs
 * sha256(authenticatorData || sha256(clientDataJSON)), where clientDataJSON carries the
 * base64url challenge; the contract checks that challenge against the EIP-712 digest and
 * verifies the P256 signature with Monad's precompile.
 */

const P256_N = 0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551n;

export function base64url(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function fromBase64url(text: string): Uint8Array {
  const b64 = text.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(text.length / 4) * 4, "=");
  const bin = atob(b64);
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

/** The WebAuthn challenge for an owner digest: the digest's 32 bytes. */
export function challengeFor(digest: Hex): Uint8Array {
  return hexToBytes(digest);
}

function toBigInt(bytes: Uint8Array): bigint {
  return bytes.length === 0 ? 0n : BigInt(bytesToHex(bytes));
}

function word(n: bigint): Hex {
  return `0x${n.toString(16).padStart(64, "0")}`;
}

/** r and s from a DER ECDSA signature (what WebAuthn returns) or a 64-byte raw one. */
export function signatureRs(signature: Uint8Array): { r: bigint; s: bigint } {
  if (signature.length === 64) return { r: toBigInt(signature.slice(0, 32)), s: toBigInt(signature.slice(32)) };
  // DER: 0x30 len 0x02 rlen r 0x02 slen s
  if (signature[0] !== 0x30) throw new Error("webauthn: signature is not DER");
  let i = 2;
  if (signature[i] !== 0x02) throw new Error("webauthn: malformed DER r");
  const rLen = signature[i + 1]!;
  const r = signature.slice(i + 2, i + 2 + rLen);
  i += 2 + rLen;
  if (signature[i] !== 0x02) throw new Error("webauthn: malformed DER s");
  const sLen = signature[i + 1]!;
  const s = signature.slice(i + 2, i + 2 + sLen);
  return { r: toBigInt(r), s: toBigInt(s) };
}

/** Builds the contract struct from an assertion; s is moved to the low half of the curve order. */
export function toWebAuthnAuth(a: {
  authenticatorData: Uint8Array;
  clientDataJSON: Uint8Array;
  signature: Uint8Array;
}): WebAuthnAuth {
  const clientDataJSON = new TextDecoder().decode(a.clientDataJSON);
  const challengeIndex = clientDataJSON.indexOf('"challenge":"');
  const typeIndex = clientDataJSON.indexOf('"type":"webauthn.get"');
  if (challengeIndex < 0 || typeIndex < 0) throw new Error("webauthn: unexpected clientDataJSON");
  const { r, s } = signatureRs(a.signature);
  return {
    authenticatorData: bytesToHex(a.authenticatorData),
    clientDataJSON,
    challengeIndex: BigInt(challengeIndex),
    typeIndex: BigInt(typeIndex),
    r: word(r),
    s: word(s > P256_N / 2n ? P256_N - s : s),
  };
}

/**
 * The P256 public key (x, y) from a credential's SubjectPublicKeyInfo, as returned by
 * `AuthenticatorAttestationResponse.getPublicKey()` for ES256 credentials.
 */
export function p256PublicKey(spki: Uint8Array): { x: Hex; y: Hex } {
  // The SPKI for P256 ends with the 65-byte uncompressed point 0x04 || x || y.
  const point = spki.slice(spki.length - 65);
  if (point[0] !== 0x04) throw new Error("webauthn: not an uncompressed P256 key");
  return { x: bytesToHex(point.slice(1, 33)), y: bytesToHex(point.slice(33)) };
}
