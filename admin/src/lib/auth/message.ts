/**
 * The message an admin wallet signs, byte for byte what adminMessage() in
 * backend/src/api/admin-auth.ts rebuilds and verifies. It binds the method, the path with its
 * query string, a unix timestamp, a random nonce and the SHA-256 of the raw body (empty for GET).
 * Wallets sign deterministically, so the nonce is what keeps two requests in the same second from
 * producing the same, once-only signature.
 */
export async function adminMessage(method: string, pathWithQuery: string, timestampSec: number, nonce: string, body: string): Promise<string> {
  return `Trendr admin request\n${method.toUpperCase()} ${pathWithQuery}\ntimestamp: ${timestampSec}\nnonce: ${nonce}\nbody: ${await sha256Hex(body)}`;
}

/** 32 characters of base64url randomness, inside the backend's [A-Za-z0-9_-]{16,64}. */
export function randomNonce(): string {
  const bytes = globalThis.crypto.getRandomValues(new Uint8Array(24));
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Lowercase hex SHA-256 of a UTF-8 string, via WebCrypto (secure origins only: HTTPS or localhost). */
export async function sha256Hex(text: string): Promise<string> {
  if (!globalThis.crypto?.subtle) throw new Error("Signing in needs a secure origin: serve the panel over HTTPS or from localhost.");
  const digest = await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

/** 0x-prefixed hex of a UTF-8 string, the form personal_sign expects. */
export function utf8ToHex(text: string): string {
  return `0x${Array.from(new TextEncoder().encode(text), (b) => b.toString(16).padStart(2, "0")).join("")}`;
}
