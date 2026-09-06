import * as ed from "@noble/ed25519";
import { type Address, type Hex, hashTypedData, hexToBytes } from "viem";
import { type ApiCredentials, generateApiKeyPair } from "./api";
import type { PerplNetwork } from "./networks";

/** Whatever signs EIP-712 typed data for the account: a Mera-derived account key, or a wallet. */
export interface TypedDataSigner {
  address: Address;
  signTypedData(typedData: { domain: Record<string, unknown>; types: Record<string, unknown>; primaryType: string; message: Record<string, unknown> }): Promise<Hex>;
}

export interface EnrollOptions {
  network: PerplNetwork;
  signer: TypedDataSigner;
  label: string;
  /** 1 read, 2 trade (implies read), 3 both. */
  scope: 1 | 2 | 3;
  /** Milliseconds since epoch, or 0 for no expiry. */
  expiresAt?: number;
  /** A builder code and the largest fee (per 100k) the user authorizes for it. */
  builder?: { id: number; maxFeePer100k: number };
  /** Required from a server; a browser sets it. Perpl must have whitelisted it. */
  origin?: string;
  fetchFn?: typeof fetch;
}

export interface EnrolledKey extends ApiCredentials {
  info: Record<string, unknown>;
}

interface PayloadResponse {
  typed_data: { domain: Record<string, unknown>; types: Record<string, unknown>; primaryType: string; message: Record<string, unknown> };
  mac: string;
}

/**
 * Enrolls a fresh Ed25519 API key for the signer's Perpl account. Perpl generates the EIP-712
 * payload, the account signs it exactly as returned, and the API key proves possession by signing
 * the payload's digest. The secret key never leaves this process.
 */
export async function enrollApiKey(o: EnrollOptions): Promise<EnrolledKey> {
  const fetchFn = o.fetchFn ?? fetch;
  const headers: Record<string, string> = { "Content-Type": "application/json", ...(o.origin ? { Origin: o.origin } : {}) };
  const { secretKey, publicKeyHex } = await generateApiKeyPair();

  const payloadRes = await fetchFn(`${o.network.rest}/v1/api-key/payload`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      chain_id: o.network.chainId,
      address: o.signer.address,
      public_key: publicKeyHex,
      scope_mask: o.scope,
      label: o.label,
      ...(o.expiresAt ? { expires_at: o.expiresAt } : {}),
      ...(o.builder ? { builder_id: o.builder.id, max_builder_fee_per_100k: o.builder.maxFeePer100k } : {}),
    }),
  });
  if (!payloadRes.ok) throw new Error(`Perpl key payload: HTTP ${payloadRes.status}`);
  const { typed_data, mac } = (await payloadRes.json()) as PayloadResponse;

  const { EIP712Domain: _domain, ...types } = typed_data.types as Record<string, unknown>;
  const typed = { domain: typed_data.domain, types, primaryType: typed_data.primaryType, message: typed_data.message };
  const signature = await o.signer.signTypedData(typed);
  const digest = hashTypedData(typed as never);
  const pop = await ed.signAsync(hexToBytes(digest), secretKey);

  const enrollRes = await fetchFn(`${o.network.rest}/v1/api-key/enroll`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      chain_id: o.network.chainId,
      address: o.signer.address,
      typed_data,
      mac,
      signature,
      pop_signature: `0x${Array.from(pop, (b) => b.toString(16).padStart(2, "0")).join("")}`,
    }),
  });
  if (!enrollRes.ok) throw new Error(`Perpl key enrollment: HTTP ${enrollRes.status}`);
  const { api_key } = (await enrollRes.json()) as { api_key: Record<string, unknown> & { api_key: string } };
  return { token: api_key.api_key, secretKey, info: api_key };
}
