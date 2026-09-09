import { type Hex, hexToBytes, size } from "viem";
import { z } from "zod";
import { base58Encode } from "../base58";
import { AuroraError } from "../errors";

/**
 * What an EVM origin wallet signs for Intents Connect, and how the signature goes on the wire.
 *
 * The payload (`details.payload.payload_json`) is a NEAR Intents message: signer, nonce, deadline,
 * and one `auth_call` intent per destination transaction, asking the chain-signatures proxy to sign
 * a given 32-byte digest for the intermediary derived from the wallet (`path`). The wallet signs
 * the JSON string verbatim with EIP-191 personal_sign; the service recovers the signer with
 * ecrecover and compares it to `signer_id`, so the signer must be an EOA key (ERC-1271 contract
 * signatures are not accepted).
 *
 * A Trendr account is an EIP-7702 EOA whose key Mera derives from the passkey's PRF output, so it
 * can sign this after one passkey ceremony, with the same key that signs the 7702 delegation.
 */

export const intentPayloadSchema = z.object({
  deadline: z.string(),
  nonce: z.string(),
  signer_id: z.string(),
  verifying_contract: z.string(),
  intents: z.array(
    z.object({
      intent: z.string(),
      contract_id: z.string().optional(),
      min_gas: z.string().optional(),
      msg: z.string().optional(),
    }),
  ),
});
export type IntentPayload = z.infer<typeof intentPayloadSchema>;

const authCallMsgSchema = z.object({
  request: z.object({
    domain_id: z.number(),
    path: z.string(),
    payload_v2: z.object({ Ecdsa: z.string().regex(/^[0-9a-fA-F]{64}$/) }),
  }),
});

export class SigningPayloadError extends AuroraError {
  override name = "SigningPayloadError";
}

export interface AuthorizedCall {
  /** The NEAR contract asked to sign (the chain-signatures proxy). */
  contract: string;
  /** Derivation path: the origin wallet, which is why the intermediary belongs to it. */
  path: string;
  /** The digest of the destination transaction the proxy will sign for the intermediary. */
  digest: Hex;
}

export interface CheckedPayload {
  signer: string;
  deadline: string;
  nonce: string;
  calls: AuthorizedCall[];
}

/**
 * Parses and checks a payload before the wallet signs it: it must be for `wallet`, verified by
 * intents.near, unexpired, and made only of auth_call intents for `wallet`'s path. Returns the
 * digests being authorized so the app can show what is signed.
 */
export function checkIntentPayload(
  payloadJson: string,
  options: { wallet: string; now?: number; allowedContracts?: readonly string[] },
): CheckedPayload {
  let raw: unknown;
  try {
    raw = JSON.parse(payloadJson);
  } catch {
    throw new SigningPayloadError("the payload is not JSON");
  }
  const parsed = intentPayloadSchema.safeParse(raw);
  if (!parsed.success) throw new SigningPayloadError(`unexpected payload: ${z.prettifyError(parsed.error)}`);
  const p = parsed.data;
  const wallet = options.wallet.toLowerCase();
  if (p.signer_id.toLowerCase() !== wallet) throw new SigningPayloadError(`the payload is for ${p.signer_id}, not ${options.wallet}`);
  if (p.verifying_contract !== "intents.near") throw new SigningPayloadError(`unexpected verifying contract ${p.verifying_contract}`);
  if (Date.parse(p.deadline) <= (options.now ?? Date.now())) throw new SigningPayloadError("the payload has expired");
  const calls = p.intents.map((intent): AuthorizedCall => {
    if (intent.intent !== "auth_call" || !intent.contract_id || !intent.msg) throw new SigningPayloadError(`unexpected intent ${intent.intent}`);
    if (options.allowedContracts && !options.allowedContracts.includes(intent.contract_id)) {
      throw new SigningPayloadError(`unexpected signer contract ${intent.contract_id}`);
    }
    let msg: z.infer<typeof authCallMsgSchema>;
    try {
      msg = authCallMsgSchema.parse(JSON.parse(intent.msg));
    } catch {
      throw new SigningPayloadError("unexpected auth_call message");
    }
    if (msg.request.path.toLowerCase() !== wallet) throw new SigningPayloadError(`an auth_call derives from ${msg.request.path}, not the wallet`);
    return { contract: intent.contract_id, path: msg.request.path, digest: `0x${msg.request.payload_v2.Ecdsa.toLowerCase()}` };
  });
  if (calls.length === 0) throw new SigningPayloadError("the payload authorizes nothing");
  return { signer: p.signer_id, deadline: p.deadline, nonce: p.nonce, calls };
}

/**
 * A 65-byte personal_sign signature in the form the API takes: "secp256k1:" + base58(r || s || v),
 * with v normalized to 0 or 1.
 */
export function toIntentsSignature(signature: Hex): string {
  if (size(signature) !== 65) throw new SigningPayloadError("expected a 65-byte secp256k1 signature");
  const bytes = hexToBytes(signature);
  const v = bytes[64]!;
  bytes[64] = v >= 27 ? v - 27 : v;
  if (bytes[64] > 1) throw new SigningPayloadError("unexpected recovery id");
  return `secp256k1:${base58Encode(bytes)}`;
}

/** Signs a payload (verbatim, EIP-191) with any personal_sign signer and encodes it for submit. */
export async function signIntentPayload(signMessage: (message: string) => Promise<Hex>, payloadJson: string): Promise<string> {
  return toIntentsSignature(await signMessage(payloadJson));
}

/** The message a wallet signs to delete one of its executions. */
export const deleteExecutionMessage = (executionId: string) => `delete_execution:${executionId}`;
