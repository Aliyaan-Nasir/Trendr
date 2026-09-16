import { type Deployment, passkeyAccountAbi, tradingPermissions } from "@trendr/contracts";
import type { MiddlewareHandler } from "hono";
import {
  type Address,
  BaseError,
  ContractFunctionRevertedError,
  ContractFunctionZeroDataError,
  getAddress,
  type Hex,
  isAddress,
  type PublicClient,
  recoverMessageAddress,
} from "viem";
import { type IsRevoked, issueSession, readSession, tokenHash } from "./admin-auth";

/**
 * App sign-in. A Trendr account is an EIP-7702 account running PasskeyAccount; the app proves
 * control by signing a short message with either the account's own key or its active trading
 * session key (checked on chain), so signing in needs no passkey prompt. The answer is a bearer
 * token for the account that names the key that signed, never longer-lived than that session, and
 * every request checks again (cached briefly) that the session is still active, so revoking the
 * key on chain ends the token too.
 */

export const SIGN_IN_WINDOW_SEC = 300;
export const USER_SESSION_SEC = 12 * 3600;
/** How long an on-chain answer about a session key stands before a request reads it again. */
export const SIGNER_CHECK_TTL_MS = 30_000;

export function signInMessage(account: string, signer: string, issuedAt: number): string {
  return `Trendr sign-in\naccount: ${getAddress(account)}\nsigner: ${getAddress(signer)}\nissued: ${issuedAt}`;
}

export class SignInError extends Error {}

/** The chain could not be read; the request may be retried. */
export class ChainUnavailableError extends Error {}

/** A function on a contract, as PasskeyAccount's isPermitted takes it. */
export interface Selector {
  target: Address;
  selector: Hex;
}

/**
 * The calls that mark the app's everyday trading session: outcome sets, attention perps, trend
 * coins and spot trades. Autopilot's grant key holds Perpl permissions only, so it holds none.
 */
export function tradingSelectors(d: Deployment): Selector[] {
  const perpl = d.perplExchange?.toLowerCase();
  return tradingPermissions(d)
    .filter((p) => p.selector !== "0x00000000" && p.target.toLowerCase() !== perpl)
    .map(({ target, selector }) => ({ target, selector }));
}

/**
 * A read of the account: null when the account itself answered no (no code, or a revert), and
 * ChainUnavailableError when the RPC failed, so an outage never reads as a revoked key.
 */
export async function readAccount<T>(read: Promise<T>): Promise<T | null> {
  try {
    return await read;
  } catch (e) {
    if (e instanceof BaseError && e.walk((x) => x instanceof ContractFunctionZeroDataError || x instanceof ContractFunctionRevertedError) !== null) return null;
    throw new ChainUnavailableError(e instanceof Error ? e.message.slice(0, 200) : String(e));
  }
}

/** Which keys may act for an account in the API, checked on chain. */
export class AccountKeys {
  /** Per account and session key: when the chain was read, and until when the session is active (0: not active). */
  private readonly checked = new Map<string, { at: number; activeUntil: number }>();

  constructor(
    private readonly client: Pick<PublicClient, "readContract">,
    /** A session key must be permitted at least one of these to sign in. */
    private readonly trading: readonly Selector[],
    /** True for keys the account granted Autopilot: they belong to the executor. */
    private readonly isGrantKey: (account: string, key: string) => Promise<boolean>,
    private readonly ttlMs = SIGNER_CHECK_TTL_MS,
    private readonly now: () => number = Date.now,
  ) {}

  /**
   * Checks a sign-in (or any `message` the account signed). The signer must be the account's own
   * key, or an active trading session key of it that is not an Autopilot grant key. Returns the
   * account, the signer and when a token for them must expire. Throws SignInError, or
   * ChainUnavailableError when the chain cannot be read.
   */
  async verify(
    body: { account: string; signer: string; issuedAt: number; signature: Hex },
    nowSec: number,
    message?: string,
  ): Promise<{ account: Address; signer: Address; expiresAt: number }> {
    if (!isAddress(body.account) || !isAddress(body.signer)) throw new SignInError("bad address");
    if (!Number.isInteger(body.issuedAt) || Math.abs(nowSec - body.issuedAt) > SIGN_IN_WINDOW_SEC) throw new SignInError("sign-in expired; check the clock");
    const recovered = await recoverMessageAddress({ message: message ?? signInMessage(body.account, body.signer, body.issuedAt), signature: body.signature }).catch(() => null);
    if (!recovered || recovered.toLowerCase() !== body.signer.toLowerCase()) throw new SignInError("bad signature");
    const account = getAddress(body.account);
    const signer = getAddress(body.signer);
    const cap = nowSec + USER_SESSION_SEC;
    if (signer === account) return { account, signer, expiresAt: cap };
    if (await this.isGrantKey(account, signer)) throw new SignInError("Autopilot's session key cannot sign in");
    const session = await readAccount(this.client.readContract({ address: account, abi: passkeyAccountAbi, functionName: "sessionOf", args: [signer] }));
    if (!session || !session.active || Number(session.validUntil) <= nowSec) throw new SignInError("the signer is not an active session of this account");
    const permitted = await Promise.all(
      this.trading.map((p) => readAccount(this.client.readContract({ address: account, abi: passkeyAccountAbi, functionName: "isPermitted", args: [signer, p.target, p.selector] }))),
    );
    if (!permitted.some(Boolean)) throw new SignInError("only the app's trading session can sign in");
    this.remember(account, signer, Number(session.validUntil));
    return { account, signer, expiresAt: Math.min(cap, Number(session.validUntil)) };
  }

  /**
   * Whether `signer` may still act for `account`: always for the account's own key, and for a
   * session key while it is active on chain. Answers are cached for `ttlMs`. Throws
   * ChainUnavailableError when the chain cannot be read.
   */
  async stillActive(account: string, signer: string): Promise<boolean> {
    if (account.toLowerCase() === signer.toLowerCase()) return true;
    const key = `${account.toLowerCase()}:${signer.toLowerCase()}`;
    const t = this.now();
    const hit = this.checked.get(key);
    if (hit && t - hit.at < this.ttlMs) return hit.activeUntil * 1000 > t;
    const s = await readAccount(this.client.readContract({ address: getAddress(account), abi: passkeyAccountAbi, functionName: "sessionOf", args: [getAddress(signer)] }));
    const activeUntil = s?.active ? Number(s.validUntil) : 0;
    this.remember(account, signer, activeUntil);
    return activeUntil * 1000 > t;
  }

  private remember(account: string, signer: string, activeUntil: number): void {
    const t = this.now();
    if (this.checked.size > 10_000) for (const [k, v] of this.checked) if (t - v.at >= this.ttlMs) this.checked.delete(k);
    this.checked.set(`${account.toLowerCase()}:${signer.toLowerCase()}`, { at: t, activeUntil });
  }
}

export const issueUserToken = (secret: string, account: string, signer: string, expiresAt: number) => issueSession(secret, account, expiresAt, "user", signer);

/** The account and signing key of a genuine, unexpired user token; null for tokens without a signer. */
export function readUserToken(secret: string, token: string, nowSec: number): { account: string; signer: string; expiresAt: number } | null {
  const s = readSession(secret, token, nowSec, "user");
  return s?.signer ? { account: s.address, signer: s.signer, expiresAt: s.expiresAt } : null;
}

/**
 * Requires `Authorization: Bearer <user token>` whose signing key is still active on the account,
 * and exposes the account as `user`.
 */
export function userAuth(
  secret: string,
  isRevoked: IsRevoked,
  keys: Pick<AccountKeys, "stillActive">,
  now: () => number = Date.now,
): MiddlewareHandler<{ Variables: { user: string; token: string } }> {
  return async (c, next) => {
    const token = (c.req.header("authorization") ?? "").match(/^Bearer\s+(.+)$/i)?.[1];
    const session = token ? readUserToken(secret, token, Math.floor(now() / 1000)) : null;
    if (!token || !session || (await isRevoked(tokenHash(token)))) return c.json({ error: "sign in first" }, 401);
    let active: boolean;
    try {
      active = await keys.stillActive(session.account, session.signer);
    } catch (e) {
      if (e instanceof ChainUnavailableError) return c.json({ error: "could not check your session on chain; try again" }, 503);
      throw e;
    }
    if (!active) return c.json({ error: "the session key that signed in is no longer active; sign in again" }, 401);
    c.set("user", session.account);
    c.set("token", token);
    await next();
  };
}
