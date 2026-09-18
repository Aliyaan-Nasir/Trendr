import { createHash, randomBytes } from "node:crypto";
import { base64url, OWNER_ACTIONS, type OwnerAction, type OwnerAssertion, type OwnerChallenge, ownerApprovalDigest, type OwnerRequest, passkeyAccountAbi } from "@trendr/contracts";
import { Hono, type MiddlewareHandler } from "hono";
import { getAddress, type Hex, hexToBytes, type PublicClient } from "viem";
import { z } from "zod";
import type { Sql } from "../db";
import { rateLimit } from "./rate-limit";
import { ChainUnavailableError, readAccount } from "./user-auth";

/**
 * Owner approvals (see @trendr/contracts owner-approval): following a leader, enabling an Autopilot
 * rule and linking a caller identity keep acting after the session that asked for them is revoked,
 * so a session token alone cannot make them. The app asks for a nonce, the passkey signs the
 * action's digest with it, and the action's route verifies that assertion against the account's
 * on-chain owner key (the same P256 key and the same checks PasskeyAccount's owner path uses), then
 * spends the nonce.
 */

/** How long the app has between asking for a nonce and sending the approved request. */
export const OWNER_APPROVAL_SEC = 300;
/** Unspent nonces one account may hold at once. */
export const MAX_OPEN_APPROVALS = 20;

/** The approval is missing, malformed, stale, spent, or not the passkey's for this request. */
export class OwnerApprovalError extends Error {}

const P256_N = 0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551n;
const USER_PRESENT = 0x01;
const USER_VERIFIED = 0x04;

const bytes32 = z.string().regex(/^0x[0-9a-fA-F]{64}$/);
const approvalSchema = z.object({
  nonce: bytes32,
  // rpIdHash (32 bytes), flags and the sign count (4), then any extensions.
  authenticatorData: z.string().regex(/^0x(?:[0-9a-fA-F]{2}){37,1024}$/),
  clientDataJSON: z.string().min(1).max(4096),
  r: bytes32,
  s: bytes32,
});

const word = (n: bigint) => hexToBytes(`0x${n.toString(16).padStart(64, "0")}`);

/**
 * Verifies a WebAuthn assertion over `challenge` by the P256 key (x, y), as Solady's WebAuthn
 * verifier does for PasskeyAccount: a "webauthn.get" ceremony for exactly this challenge, with the
 * user present and verified, and a low-s signature over authenticatorData || sha256(clientDataJSON).
 * It also refuses assertions made inside a cross-origin frame.
 */
export async function verifyAssertion(challenge: Hex, a: OwnerAssertion, owner: { x: Hex; y: Hex }): Promise<boolean> {
  let client: { type?: unknown; challenge?: unknown; crossOrigin?: unknown } | null;
  try {
    client = JSON.parse(a.clientDataJSON) as typeof client;
  } catch {
    return false;
  }
  if (!client || typeof client !== "object") return false;
  if (client.type !== "webauthn.get" || client.challenge !== base64url(hexToBytes(challenge)) || client.crossOrigin === true) return false;
  const authenticatorData = hexToBytes(a.authenticatorData);
  const flags = authenticatorData[32] ?? 0;
  if (authenticatorData.length < 37 || (flags & (USER_PRESENT | USER_VERIFIED)) !== (USER_PRESENT | USER_VERIFIED)) return false;
  const r = BigInt(a.r);
  const s = BigInt(a.s);
  if (r === 0n || r >= P256_N || s === 0n || s > P256_N / 2n) return false;
  const point = new Uint8Array([0x04, ...hexToBytes(owner.x), ...hexToBytes(owner.y)]);
  const key = await crypto.subtle.importKey("raw", point, { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]).catch(() => null);
  if (!key) return false;
  const signed = new Uint8Array([...authenticatorData, ...createHash("sha256").update(a.clientDataJSON, "utf8").digest()]);
  return crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, key, new Uint8Array([...word(r), ...word(s)]), signed).catch(() => false);
}

/** A refusal for a route to send as is. */
export interface Refusal {
  body: { error: string; code?: "owner_approval" };
  status: 403 | 503;
}

export class OwnerApprovals {
  constructor(
    private readonly sql: Sql,
    private readonly client: Pick<PublicClient, "readContract">,
    private readonly chainId: number,
    private readonly now: () => number = Date.now,
  ) {}

  private nowSec() {
    return Math.floor(this.now() / 1000);
  }

  /** A single-use nonce for `action` on `account`; null while the account holds too many unspent ones. */
  async issue(account: string, action: OwnerAction): Promise<OwnerChallenge | null> {
    const nowSec = this.nowSec();
    const owner = account.toLowerCase();
    await this.sql`DELETE FROM owner_approvals WHERE expires_at <= ${nowSec}`;
    const open = await this.sql<{ n: number }[]>`SELECT count(*)::int AS n FROM owner_approvals WHERE account = ${owner}`;
    if ((open[0]?.n ?? 0) >= MAX_OPEN_APPROVALS) return null;
    const nonce: Hex = `0x${randomBytes(32).toString("hex")}`;
    const expiresAt = nowSec + OWNER_APPROVAL_SEC;
    await this.sql`INSERT INTO owner_approvals (nonce, account, action, expires_at) VALUES (${nonce}, ${owner}, ${action}, ${expiresAt})`;
    return { nonce, expiresAt, chainId: this.chainId };
  }

  /**
   * Checks that the account's passkey approved `request` with a nonce issued to this account for
   * this action, then spends the nonce. Throws OwnerApprovalError when refused, and
   * ChainUnavailableError when the owner key cannot be read.
   */
  async verify(account: string, request: OwnerRequest, approval: unknown): Promise<void> {
    if (approval === undefined || approval === null) throw new OwnerApprovalError("approve this with your passkey");
    const a = approvalSchema.safeParse(approval);
    if (!a.success) throw new OwnerApprovalError("the passkey approval is malformed");
    const nonce = a.data.nonce.toLowerCase() as Hex;
    const nowSec = this.nowSec();
    const row = (await this.sql<{ account: string; action: string; expires_at: string }[]>`SELECT account, action, expires_at FROM owner_approvals WHERE nonce = ${nonce}`)[0];
    if (!row) throw new OwnerApprovalError("this passkey approval is no longer valid; try again");
    if (Number(row.expires_at) <= nowSec) throw new OwnerApprovalError("this passkey approval expired; try again");
    if (row.account !== account.toLowerCase() || row.action !== request.action) throw new OwnerApprovalError("the passkey approval does not match this request");
    const owner = await readAccount(this.client.readContract({ address: getAddress(account), abi: passkeyAccountAbi, functionName: "owner" }));
    if (!owner || (BigInt(owner[0]) === 0n && BigInt(owner[1]) === 0n)) throw new OwnerApprovalError("this account has no passkey on chain");
    const digest = ownerApprovalDigest({ chainId: this.chainId, account: getAddress(account), request, nonce, expiresAt: Number(row.expires_at) });
    if (!(await verifyAssertion(digest, a.data as OwnerAssertion, { x: owner[0], y: owner[1] }))) throw new OwnerApprovalError("the passkey approval does not match this request");
    // Spent here, so two requests racing with one approval cannot both pass.
    const spent = await this.sql`DELETE FROM owner_approvals WHERE nonce = ${nonce} AND expires_at > ${nowSec} RETURNING nonce`;
    if (spent.length === 0) throw new OwnerApprovalError("this passkey approval is no longer valid; try again");
  }

  /** `verify` for a route: null when approved, otherwise the refusal to send. */
  async check(account: string, request: OwnerRequest, approval: unknown): Promise<Refusal | null> {
    try {
      await this.verify(account, request, approval);
      return null;
    } catch (e) {
      if (e instanceof OwnerApprovalError) return { body: { error: e.message, code: "owner_approval" }, status: 403 };
      if (e instanceof ChainUnavailableError) return { body: { error: "could not check the account on chain; try again" }, status: 503 };
      throw e;
    }
  }
}

type Vars = { Variables: { user: string; token: string } };

/** POST /owner-approvals: a nonce for the signed-in account to approve one action with its passkey. */
export function ownerApprovalRoutes(approvals: OwnerApprovals, signedIn: MiddlewareHandler<Vars>, now: () => number = Date.now) {
  const app = new Hono<Vars>();
  const perAccount = rateLimit<Vars>(30, 600_000, (c) => `approvals:${c.get("user")}`, now);
  app.post("/owner-approvals", signedIn, perAccount, async (c) => {
    const body = z.object({ action: z.enum(OWNER_ACTIONS) }).safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: `action: one of ${OWNER_ACTIONS.join(", ")}` }, 400);
    const challenge = await approvals.issue(c.get("user"), body.data.action);
    if (!challenge) return c.json({ error: "too many passkey approvals in progress; wait a few minutes" }, 429);
    return c.json(challenge);
  });
  return app;
}
