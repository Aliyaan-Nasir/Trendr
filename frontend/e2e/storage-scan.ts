import { expect } from "@playwright/test";
import { generatePrivateKey, privateKeyToAddress } from "viem/accounts";

/**
 * Finds secret keys stored in plaintext: every 32-byte window of every stored value (raw bytes,
 * hex and base64 text) is tried as a secp256k1 private key, and none may belong to an address the
 * app uses. Stored WebCrypto keys must be non-extractable.
 */

export interface Dump {
  /** Every string and byte value in localStorage, sessionStorage and IndexedDB, bytes as hex. */
  strings: string[];
  bytes: string[];
  /** Stored CryptoKeys, by where they sit. */
  keys: Array<{ at: string; type: string; algorithm: string; extractable: boolean }>;
  databases: string[];
}

/** Every address that some 32-byte window of the stored values would be the private key of. */
export function keyCandidates(d: Dump): Map<string, string> {
  const blobs = [...d.bytes];
  for (const s of d.strings) {
    for (const m of s.matchAll(/(?:0x)?([0-9a-fA-F]{64,})/g)) blobs.push(m[1]!.toLowerCase());
    for (const m of s.matchAll(/[A-Za-z0-9+/_-]{43,}={0,2}/g)) {
      try {
        const raw = atob(m[0].replace(/-/g, "+").replace(/_/g, "/").replace(/=+$/, "").padEnd(Math.ceil(m[0].replace(/=+$/, "").length / 4) * 4, "="));
        blobs.push(Array.from(raw, (c) => c.charCodeAt(0).toString(16).padStart(2, "0")).join(""));
      } catch {
        // Not base64.
      }
    }
  }
  const found = new Map<string, string>();
  for (const b of blobs) {
    for (let i = 0; i + 64 <= b.length; i += 2) {
      const window = `0x${b.slice(i, i + 64)}` as `0x${string}`;
      try {
        found.set(privateKeyToAddress(window).toLowerCase(), window);
      } catch {
        // Not a valid secp256k1 scalar.
      }
    }
  }
  return found;
}

export function assertNoPlaintextKeys(d: Dump, label: string, addresses: string[]) {
  const candidates = keyCandidates(d);
  const known = new Set([...addresses.map((a) => a.toLowerCase()), ...d.strings.flatMap((s) => [...s.matchAll(/0x[0-9a-fA-F]{40}(?![0-9a-fA-F])/g)].map((m) => m[0].toLowerCase()))]);
  for (const a of known) expect(candidates.has(a), `${label}: the private key of ${a} is stored in plaintext`).toBe(false);
  for (const k of d.keys) expect(k.extractable, `${label}: ${k.algorithm} key at ${k.at} must be non-extractable`).toBe(false);
  console.log(`${label}: scanned ${d.databases.length} databases, ${d.strings.length} strings, ${d.bytes.length} byte values, ${d.keys.length} CryptoKeys; ${known.size} addresses checked`);
}


/** The detector finds a key planted as hex, as base64 and as raw bytes inside a longer value. */
export function selfCheck() {
  const key = generatePrivateKey();
  const address = privateKeyToAddress(key).toLowerCase();
  const raw = key.slice(2);
  const b64 = Buffer.from(raw, "hex").toString("base64url");
  for (const dump of [
    { strings: [`{"k":"${key}"}`], bytes: [], keys: [], databases: [] },
    { strings: [`token.${b64}.sig`], bytes: [], keys: [], databases: [] },
    { strings: [], bytes: [`00ff${raw}ab`], keys: [], databases: [] },
  ] satisfies Dump[]) {
    expect(keyCandidates(dump).has(address), "the plaintext-key detector missed a planted key").toBe(true);
  }
}
