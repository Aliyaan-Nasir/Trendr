/**
 * Prints a new key pair for sealing Autopilot grants. Put the private key in this executor's
 * AUTOPILOT_SEAL_PRIVATE_KEY and the public key in the backend's AUTOPILOT_SEAL_PUBLIC_KEY.
 *   bun scripts/seal-keys.ts
 */
import { generateSealKeyPair } from "@trendr/autopilot";

const { privateKey, publicKey } = await generateSealKeyPair();
console.log(`AUTOPILOT_SEAL_PRIVATE_KEY=${privateKey}`);
console.log(`AUTOPILOT_SEAL_PUBLIC_KEY=${publicKey}`);
