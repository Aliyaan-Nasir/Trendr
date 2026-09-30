import { seal } from "@trendr/autopilot";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

/**
 * A new Autopilot grant key, made on this device and sealed at once to the executor's public key,
 * bound to the account and the key's address. Only the address and the sealed box leave here: the
 * key itself is never stored or sent in clear, so neither the app nor Trendr's API keeps it, and
 * only the executor can open it.
 */
export async function sealGrantKey(owner: string, executorPublicKey: string): Promise<{ sessionKey: `0x${string}`; sealedKey: string }> {
  const key = generatePrivateKey();
  const sessionKey = privateKeyToAccount(key).address;
  return { sessionKey, sealedKey: await seal(key, executorPublicKey, { owner: owner.toLowerCase(), sessionKey: sessionKey.toLowerCase() }) };
}
