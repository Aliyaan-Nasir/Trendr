/**
 * Notes sealed on this device with the passkey-derived vault key (AES-256-GCM, non-extractable).
 * The server stores base64url ciphertext and a 12-byte IV, nothing else. The item's kind and id are
 * bound in as associated data, so the server cannot swap one sealed item for another.
 */

export interface Note {
  title: string;
  body: string;
  /** Unix milliseconds of the last edit, inside the sealed payload. */
  editedAt: number;
}

export function toBase64Url(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]!);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function fromBase64Url(s: string): Uint8Array<ArrayBuffer> {
  const raw = atob(s.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (s.length % 4)) % 4));
  const out = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

const aad = (kind: string, id: string) => new TextEncoder().encode(`trendr-vault/${kind}/${id}`);

export async function seal(key: CryptoKey, kind: "note" | "strategy", id: string, value: unknown): Promise<{ ciphertext: string; iv: string }> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const plain = new TextEncoder().encode(JSON.stringify(value));
  const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: aad(kind, id) }, key, plain);
  return { ciphertext: toBase64Url(new Uint8Array(ct)), iv: toBase64Url(iv) };
}

export async function unseal<T>(key: CryptoKey, kind: "note" | "strategy", id: string, item: { ciphertext: string; iv: string }): Promise<T> {
  const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: fromBase64Url(item.iv), additionalData: aad(kind, id) }, key, fromBase64Url(item.ciphertext));
  return JSON.parse(new TextDecoder().decode(plain)) as T;
}

/** A random item id: 16 base64url characters. */
export const newItemId = () => toBase64Url(crypto.getRandomValues(new Uint8Array(12)));

/**
 * The public half of the passkey-derived Perpl API key (Ed25519), as Perpl takes it (0x hex), via
 * WebCrypto. Null where the browser has no Ed25519.
 */
export async function ed25519PublicKey(seed: Uint8Array): Promise<`0x${string}` | null> {
  const prefix = [0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x04, 0x22, 0x04, 0x20];
  const pkcs8 = new Uint8Array(new ArrayBuffer(prefix.length + 32));
  pkcs8.set(prefix, 0);
  pkcs8.set(seed.subarray(0, 32), prefix.length);
  try {
    const key = await crypto.subtle.importKey("pkcs8", pkcs8, { name: "Ed25519" }, true, ["sign"]);
    const jwk = await crypto.subtle.exportKey("jwk", key);
    if (!jwk.x) return null;
    const pub = fromBase64Url(jwk.x);
    return `0x${Array.from(pub, (b) => b.toString(16).padStart(2, "0")).join("")}`;
  } catch {
    return null;
  } finally {
    pkcs8.fill(0);
  }
}
