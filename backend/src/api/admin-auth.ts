import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { Context, MiddlewareHandler } from "hono";
import { type Hex, isAddress, type PublicClient } from "viem";

/**
 * Admin requests are signed by an allowlisted wallet (EIP-191 personal_sign; smart accounts via
 * ERC-1271 and ERC-6492). The signed message binds the method, path, body and a timestamp, and a
 * signature is accepted once, so a captured request cannot be replayed or altered.
 *
 * Signing every click would mean a wallet prompt per action, so a signed `POST /v1/admin/session`
 * returns a session token (HMAC over the address and expiry) that later requests send as a bearer
 * token. The allowlist is checked again on every request, so removing an address revokes its
 * sessions at once.
 */

export const ADMIN_WINDOW_SEC = 300;
export const ADMIN_SESSION_SEC = 12 * 3600;

const b64url = (b: Buffer) => b.toString("base64url");

/** Who a token speaks for: an admin wallet, an app account, or a caller identity. A token of one never passes as another. */
export type Role = "admin" | "user" | "identity";

/**
 * A session token for `address` in `role`, valid until `expiresAt` (seconds). A random id makes
 * every token unique, so signing one out never ends another issued in the same second. App tokens
 * also name the key that signed in (`signer`), so each request can check that key is still active.
 */
export function issueSession(secret: string, address: string, expiresAt: number, role: Role = "admin", signer?: string): string {
  const id = randomBytes(9).toString("base64url");
  const fields = [role, address.toLowerCase(), String(expiresAt), id, ...(signer ? [signer.toLowerCase()] : [])];
  const payload = b64url(Buffer.from(fields.join(".")));
  return `${payload}.${b64url(createHmac("sha256", secret).update(payload).digest())}`;
}

/** What a genuine, unexpired token of `role` says, or null when it is forged, expired or for another role. */
export function readSession(secret: string, token: string, nowSec: number, role: Role = "admin"): { address: string; expiresAt: number; signer: string | null } | null {
  const [payload, mac] = token.split(".");
  if (!payload || !mac) return null;
  const expected = createHmac("sha256", secret).update(payload).digest();
  const given = Buffer.from(mac, "base64url");
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  const [tokenRole, address, expiry, , signer] = Buffer.from(payload, "base64url").toString().split(".");
  const expiresAt = Number(expiry);
  if (tokenRole !== role || !address || !isAddress(address) || !(expiresAt > nowSec)) return null;
  return { address, expiresAt, signer: signer && isAddress(signer) ? signer : null };
}

/** The address a session token belongs to, or null when it is forged, expired or for another role. */
export function verifySession(secret: string, token: string, nowSec: number, role: Role = "admin"): string | null {
  return readSession(secret, token, nowSec, role)?.address ?? null;
}

/**
 * The message an admin wallet signs. The random nonce keeps two requests in the same second from
 * signing identically (wallets sign deterministically), so each signature is unique.
 */
export function adminMessage(method: string, pathWithQuery: string, timestampSec: number, nonce: string, body: string): string {
  const digest = createHash("sha256").update(body).digest("hex");
  return `Trendr admin request\n${method.toUpperCase()} ${pathWithQuery}\ntimestamp: ${timestampSec}\nnonce: ${nonce}\nbody: ${digest}`;
}

export const NONCE_RE = /^[A-Za-z0-9_-]{16,64}$/;

/** Fingerprint of a token, as stored when it is signed out. */
export const tokenHash = (token: string) => createHash("sha256").update(token).digest("hex");

/** Whether a token was signed out; backed by the revoked_tokens table. */
export type IsRevoked = (tokenHash: string) => Promise<boolean>;

export function adminAuth(
  client: Pick<PublicClient, "verifyMessage">,
  allowlist: readonly string[],
  sessionSecret: string,
  isRevoked: IsRevoked,
  now: () => number = Date.now,
): MiddlewareHandler<{ Variables: { admin: string; token: string | null } }> {
  const used = new Map<string, number>();
  return async (c, next) => {
    const deny = (reason: string) => c.json({ error: reason }, 401);
    const nowSec = Math.floor(now() / 1000);
    const bearerToken = (c.req.header("authorization") ?? "").match(/^Bearer\s+(.+)$/i)?.[1];
    if (bearerToken) {
      const address = verifySession(sessionSecret, bearerToken, nowSec);
      if (!address || (await isRevoked(tokenHash(bearerToken)))) return deny("session expired; sign in again");
      if (!allowlist.includes(address)) return deny("not an admin wallet");
      c.set("admin", address);
      c.set("token", bearerToken);
      return next();
    }
    const address = c.req.header("x-trendr-address")?.toLowerCase() ?? "";
    const ts = Number(c.req.header("x-trendr-timestamp"));
    const signature = c.req.header("x-trendr-signature") ?? "";
    const nonce = c.req.header("x-trendr-nonce") ?? "";
    if (!isAddress(address) || !allowlist.includes(address)) return deny("not an admin wallet");
    if (!NONCE_RE.test(nonce)) return deny("missing nonce");
    if (!Number.isInteger(ts) || Math.abs(nowSec - ts) > ADMIN_WINDOW_SEC) return deny("signature expired; check the clock");
    if (!/^0x[0-9a-fA-F]+$/.test(signature)) return deny("missing signature");
    for (const [sig, at] of used) if (at < nowSec - 2 * ADMIN_WINDOW_SEC) used.delete(sig);
    if (used.has(signature)) return deny("signature already used");
    const body = c.req.method === "GET" || c.req.method === "HEAD" ? "" : await c.req.raw.clone().text();
    const url = new URL(c.req.url);
    const message = adminMessage(c.req.method, `${url.pathname}${url.search}`, ts, nonce, body);
    const valid = await client.verifyMessage({ address: address as Hex, message, signature: signature as Hex }).catch(() => false);
    if (!valid) return deny("bad signature");
    used.set(signature, nowSec);
    c.set("admin", address);
    c.set("token", null);
    await next();
  };
}

/** Constant-time bearer token check for the CRE workflow's endpoints. */
export function bearer(token: string): MiddlewareHandler {
  const expected = createHash("sha256").update(token).digest();
  return async (c: Context, next) => {
    const given = (c.req.header("authorization") ?? "").replace(/^Bearer\s+/i, "");
    const digest = createHash("sha256").update(given).digest();
    // Both sides are SHA-256 digests, so the lengths always match.
    if (!timingSafeEqual(digest, expected)) return c.json({ error: "unauthorized" }, 401);
    await next();
  };
}

