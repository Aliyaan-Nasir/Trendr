import { ACTIVATION_TICKET_TTL_SEC, type ActivationTicket, activationTicketTypedData, passkeyAccountAbi } from "@trendr/contracts";
import { Hono } from "hono";
import { type Address, getAddress, type Hex, isAddress, type PublicClient } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { z } from "zod";
import { clientIp, rateLimit } from "../api/rate-limit";
import type { Sql } from "../db";
import { delegatesToOneOf } from "../faucet/faucet";

/**
 * Activation tickets (see @trendr/contracts activation-ticket). The relayer pays about 0.1 MON to
 * activate an account, and fresh accounts cost nothing to make, so it activates only accounts this
 * API vouched for. A ticket goes to an account that is not active yet, and only while the caller's
 * network and everyone together are within the sign-up caps. They are counted in Postgres, so a
 * restart does not reset them. Asking again for the same account (a sign-up retried after a network
 * failure) renews its ticket without counting twice.
 */

export interface TicketLimits {
  perIpPerHour: number;
  perIpPerDay: number;
  perHour: number;
  perDay: number;
}

export class TicketError extends Error {
  constructor(
    message: string,
    readonly status: 409 | 429 | 503,
  ) {
    super(message);
  }
}

export class ActivationTickets {
  private readonly signer;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly sql: Sql,
    private readonly client: Pick<PublicClient, "getCode" | "readContract">,
    privateKey: Hex,
    private readonly chainId: number,
    /** PasskeyAccount implementations (the deployment's and replaced ones): an account delegating to one and initialized is active. */
    private readonly delegates: readonly Address[],
    private readonly limits: TicketLimits,
    private readonly now: () => number = Date.now,
  ) {
    this.signer = privateKeyToAccount(privateKey);
  }

  /** The key the relayer's ACTIVATION_TICKET_SIGNER names. */
  get address(): Address {
    return this.signer.address;
  }

  /** A ticket for `account`, asked for from client address `ip`. One at a time, so concurrent requests cannot pass a cap together. */
  issue(account: Address, ip: string): Promise<ActivationTicket> {
    const run = this.queue.then(() => this.issueNow(getAddress(account), ip));
    this.queue = run.catch(() => undefined);
    return run;
  }

  private async issueNow(account: Address, ip: string): Promise<ActivationTicket> {
    const active = await this.isActive(account).catch(() => {
      throw new TicketError("Could not check the account on chain; try again.", 503);
    });
    if (active) throw new TicketError("This account is already active. Sign in with its passkey instead.", 409);
    const key = account.toLowerCase();
    const expiresAt = Math.floor(this.now() / 1000) + ACTIVATION_TICKET_TTL_SEC;
    const renewed = await this.sql`UPDATE activation_tickets SET expires_at = ${expiresAt} WHERE account = ${key} RETURNING account`;
    if (renewed.length === 0) {
      const [n] = await this.sql<{ ipHour: number; ipDay: number; hour: number; day: number }[]>`
        SELECT count(*) FILTER (WHERE ip = ${ip} AND issued_at > now() - interval '1 hour')::int AS "ipHour",
               count(*) FILTER (WHERE ip = ${ip})::int AS "ipDay",
               count(*) FILTER (WHERE issued_at > now() - interval '1 hour')::int AS "hour",
               count(*)::int AS "day"
        FROM activation_tickets WHERE issued_at > now() - interval '24 hours'`;
      const l = this.limits;
      if (n!.ipHour >= l.perIpPerHour || n!.ipDay >= l.perIpPerDay) {
        throw new TicketError("Too many new accounts from this network for now. Try again later, or sign in with a passkey you already have.", 429);
      }
      if (n!.hour >= l.perHour || n!.day >= l.perDay) throw new TicketError("Trendr is opening a lot of accounts right now. Try again in a little while.", 429);
      await this.sql`INSERT INTO activation_tickets (account, ip, expires_at) VALUES (${key}, ${ip}, ${expiresAt})`;
    }
    const signature = await this.signer.signTypedData(activationTicketTypedData(this.chainId, account, expiresAt));
    return { expiresAt, signature };
  }

  /** Delegated to a Trendr PasskeyAccount and initialized (a version 1 account upgrades instead of activating). */
  private async isActive(account: Address): Promise<boolean> {
    const code = await this.client.getCode({ address: account });
    if (!delegatesToOneOf(code, this.delegates)) return false;
    return (await this.client.readContract({ address: account, abi: passkeyAccountAbi, functionName: "isInitialized" })) as boolean;
  }
}

/**
 * `POST /activation-ticket` with `{ account }`: the app asks during sign-up, between the passkey
 * prompt and the relayer. Without a ticket key the API answers 503 and the app goes on without one
 * (a relayer that needs tickets then refuses). An in-memory limit per address keeps chain reads cheap.
 */
export function activationTicketRoutes(tickets: ActivationTickets | null, trustedProxyHops: number, now: () => number = Date.now) {
  const app = new Hono();
  const body = z.object({ account: z.string().refine((a) => isAddress(a), "account must be an address") });
  app.post("/activation-ticket", rateLimit(20, 3_600_000, (c) => `tickets:${clientIp(c, trustedProxyHops)}`, now), async (c) => {
    if (!tickets) return c.json({ error: "activation tickets are not configured" }, 503);
    const b = body.safeParse(await c.req.json().catch(() => null));
    if (!b.success) return c.json({ error: b.error.issues[0]?.message ?? "bad request" }, 400);
    try {
      return c.json(await tickets.issue(b.data.account as Address, clientIp(c, trustedProxyHops)));
    } catch (e) {
      if (e instanceof TicketError) return c.json({ error: e.message }, e.status);
      throw e;
    }
  });
  return app;
}
