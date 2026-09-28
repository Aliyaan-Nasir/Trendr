import type { WebAuthnClient } from "@category-labs/mera";
import { p256PublicKey } from "@trendr/contracts";
import type { Hex } from "viem";

/**
 * Trendr's WebAuthn client for Mera. Mera still runs every ceremony and derives every key; this
 * client only adds what the account contract needs:
 * - ES256 credentials only, so the passkey's key is P256 and PasskeyAccount can verify it.
 * - The passkey's public key, which WebAuthn reveals only at creation.
 * - A second PRF salt in the same ceremony, for the private-data namespace.
 * - An optional challenge, so one ceremony can also sign an owner action.
 */

export interface Assertion {
  authenticatorData: Uint8Array;
  clientDataJSON: Uint8Array;
  signature: Uint8Array;
}

export interface Captured {
  /** P256 public key of a passkey created in this ceremony. */
  publicKey?: { x: Hex; y: Hex };
  /** PRF output for the private-data salt. */
  privateDataPrf?: Uint8Array;
  /** The assertion, when the ceremony signed a chosen challenge. */
  assertion?: Assertion;
}

type PrfResults = { enabled?: boolean; results?: { first?: BufferSource; second?: BufferSource } };

function bytes(source: BufferSource | undefined): Uint8Array | undefined {
  if (!source) return undefined;
  return source instanceof ArrayBuffer ? new Uint8Array(source) : new Uint8Array(source.buffer, source.byteOffset, source.byteLength).slice();
}

function prfOf(credential: PublicKeyCredential): PrfResults | undefined {
  return (credential.getClientExtensionResults() as { prf?: PrfResults }).prf;
}

/**
 * ES256 (P256 with SHA-256) only. Chrome logs a warning when a request leaves out RS256 (-257),
 * and that warning is expected here: PasskeyAccount verifies P256 signatures alone, so listing
 * RS256 would let an RSA-only authenticator (some Windows Hello setups) create a passkey the
 * account could never use. Without it such an authenticator refuses up front, before any passkey
 * exists.
 */
const ES256 = -7;

export function createTrendrWebAuthnClient(privateDataSalt: Uint8Array<ArrayBuffer>) {
  let captured: Captured = {};
  let challenge: Uint8Array<ArrayBuffer> | null = null;

  const client: WebAuthnClient = {
    async createCredential(req) {
      const credential = (await navigator.credentials.create({
        publicKey: {
          rp: req.rp,
          user: req.user,
          challenge: req.challenge,
          pubKeyCredParams: [{ type: "public-key", alg: ES256 }],
          authenticatorSelection: { residentKey: "required", requireResidentKey: true, userVerification: "required" },
          attestation: "none",
          timeout: req.timeout,
          extensions: { prf: { eval: { first: req.prfSalt, second: privateDataSalt } } } as AuthenticationExtensionsClientInputs,
        },
      })) as PublicKeyCredential | null;
      if (!credential) throw new Error("The passkey was not created.");
      const response = credential.response as AuthenticatorAttestationResponse;
      const spki = response.getPublicKey();
      if (!spki) throw new Error("The authenticator did not return a public key.");
      const prf = prfOf(credential);
      captured = { publicKey: p256PublicKey(new Uint8Array(spki)), privateDataPrf: bytes(prf?.results?.second) };
      return {
        credentialId: new Uint8Array(credential.rawId),
        transports: response.getTransports?.() as WebAuthnClient.CreateCredentialResult["transports"],
        prfEnabled: prf?.enabled ?? prf?.results?.first !== undefined,
        prfOutput: bytes(prf?.results?.first),
      };
    },

    async getCredential(req) {
      const credential = (await navigator.credentials.get({
        publicKey: {
          rpId: req.rpId,
          challenge: challenge ?? req.challenge,
          allowCredentials: req.allowCredential
            ? [{ type: "public-key", id: req.allowCredential.credentialId, transports: req.allowCredential.transports as AuthenticatorTransport[] | undefined }]
            : [],
          userVerification: "required",
          timeout: req.timeout,
          extensions: { prf: { eval: { first: req.prfSalt, second: privateDataSalt } } } as AuthenticationExtensionsClientInputs,
        },
      })) as PublicKeyCredential | null;
      if (!credential) throw new Error("The passkey did not answer.");
      const response = credential.response as AuthenticatorAssertionResponse;
      const prf = prfOf(credential);
      captured = {
        ...captured,
        privateDataPrf: bytes(prf?.results?.second) ?? captured.privateDataPrf,
        assertion: challenge
          ? {
              authenticatorData: new Uint8Array(response.authenticatorData),
              clientDataJSON: new Uint8Array(response.clientDataJSON),
              signature: new Uint8Array(response.signature),
            }
          : undefined,
      };
      return { credentialId: new Uint8Array(credential.rawId), prfOutput: bytes(prf?.results?.first) };
    },
  };

  return {
    client,
    /** Clears captured data before a ceremony. */
    reset() {
      captured = {};
    },
    captured: () => captured,
    /** Runs `fn` with assertions signing `value` instead of a random challenge. */
    async withChallenge<T>(value: Uint8Array<ArrayBuffer>, fn: () => Promise<T>): Promise<T> {
      challenge = value;
      try {
        return await fn();
      } finally {
        challenge = null;
      }
    },
  };
}
