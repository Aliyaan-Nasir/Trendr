import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { ACTIVATION_TICKET_TTL_SEC, activationTicketTypedData } from "@trendr/contracts";
import { type Address, type Hex, recoverTypedDataAddress } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { ActivationTickets, activationTicketRoutes, type TicketLimits, TicketError } from "../src/activation/tickets";
import type { Sql } from "../src/db";
import { delegationCode } from "../src/faucet/faucet";
import { testDb } from "./helpers";

/**
 * The relayer activates only accounts with a ticket from the API. A ticket goes to an account that
 * is not active yet, within the sign-up caps per client address and in total; a retried sign-up
 * renews its account's ticket without counting twice.
 */

/** PasskeyAccount version 1, which accounts keep running until they upgrade, and version 2. */
const DELEGATE = "0xdF6C6019C70fC321211A0483E74E2DDe839fa955" as Address;
const V2 = "0xa3023591e43085c782444937F96f2B82E98B2524" as Address;
const KEY = generatePrivateKey();
const NOW = 1_800_000_000_000;
const LIMITS: TicketLimits = { perIpPerHour: 2, perIpPerDay: 3, perHour: 4, perDay: 5 };

let sql: Sql;
let code: Hex | undefined;
let initialized: boolean;
let down: boolean;

const client = {
  getCode: async () => {
    if (down) throw new Error("fetch failed");
    return code;
  },
  readContract: async () => initialized,
};
const tickets = (limits = LIMITS) => new ActivationTickets(sql, client as never, KEY, 10143, [V2, DELEGATE], limits, () => NOW);
const account = (n: number) => `0x${n.toString(16).padStart(40, "0")}` as Address;
const refusal = async (p: Promise<unknown>): Promise<unknown> => p.then(() => null, (e: Error) => (e instanceof TicketError ? [e.status, e.message] : e.message));

beforeAll(async () => {
  sql = await testDb();
});
afterAll(async () => {
  await sql.end();
});
beforeEach(async () => {
  await sql`TRUNCATE activation_tickets`;
  code = undefined;
  initialized = false;
  down = false;
});

describe("activation tickets", () => {
  test("sign the account and a ten-minute expiry with the ticket key, on the chain", async () => {
    const t = await tickets().issue(account(1), "192.0.2.1");
    expect(t.expiresAt).toBe(NOW / 1000 + ACTIVATION_TICKET_TTL_SEC);
    const signer = await recoverTypedDataAddress({ ...activationTicketTypedData(10143, account(1), t.expiresAt), signature: t.signature });
    expect(signer).toBe(privateKeyToAccount(KEY).address);
    expect(tickets().address).toBe(privateKeyToAccount(KEY).address);
  });

  test("go only to accounts that are not active yet", async () => {
    code = delegationCode(DELEGATE);
    initialized = true;
    expect(await refusal(tickets().issue(account(1), "192.0.2.1"))).toEqual([409, "This account is already active. Sign in with its passkey instead."]);
    // Delegated elsewhere, or delegated but never initialized: not a Trendr account yet.
    code = delegationCode("0x00000000000000000000000000000000000000ff");
    expect(await refusal(tickets().issue(account(1), "192.0.2.1"))).toBeNull();
    code = delegationCode(DELEGATE);
    initialized = false;
    expect(await refusal(tickets().issue(account(2), "192.0.2.1"))).toBeNull();
    // Version 2 accounts are active too; version 1 ones above upgrade rather than activate.
    code = delegationCode(V2);
    initialized = true;
    expect(await refusal(tickets().issue(account(3), "192.0.2.1"))).toEqual([409, "This account is already active. Sign in with its passkey instead."]);
  });

  test("an unreadable chain is a retry, not a refusal", async () => {
    down = true;
    expect(await refusal(tickets().issue(account(1), "192.0.2.1"))).toEqual([503, "Could not check the account on chain; try again."]);
    expect(await sql`SELECT 1 FROM activation_tickets`).toHaveLength(0);
  });

  test("are capped per client address per hour and per day", async () => {
    const t = tickets();
    await t.issue(account(1), "192.0.2.1");
    await t.issue(account(2), "192.0.2.1");
    const tooMany = [429, "Too many new accounts from this network for now. Try again later, or sign in with a passkey you already have."];
    expect(await refusal(t.issue(account(3), "192.0.2.1"))).toEqual(tooMany);
    // An hour later the hourly cap has room, but the daily one (3) stops the fourth.
    await sql`UPDATE activation_tickets SET issued_at = now() - interval '2 hours'`;
    await t.issue(account(3), "192.0.2.1");
    expect(await refusal(t.issue(account(4), "192.0.2.1"))).toEqual(tooMany);
    // Another address is counted on its own.
    expect(await refusal(t.issue(account(4), "198.51.100.7"))).toBeNull();
    // A day later the address starts over.
    await sql`UPDATE activation_tickets SET issued_at = now() - interval '25 hours'`;
    expect(await refusal(t.issue(account(5), "192.0.2.1"))).toBeNull();
  });

  test("are capped for everyone per hour and per day", async () => {
    const t = tickets();
    for (let i = 1; i <= 4; i++) await t.issue(account(i), `192.0.2.${i}`);
    const busy = [429, "Trendr is opening a lot of accounts right now. Try again in a little while."];
    expect(await refusal(t.issue(account(5), "192.0.2.5"))).toEqual(busy);
    await sql`UPDATE activation_tickets SET issued_at = now() - interval '2 hours'`;
    await t.issue(account(5), "192.0.2.5");
    expect(await refusal(t.issue(account(6), "192.0.2.6"))).toEqual(busy);
  });

  test("a retried sign-up renews its ticket without counting twice", async () => {
    const t = tickets({ ...LIMITS, perIpPerHour: 1 });
    const first = await t.issue(account(1), "192.0.2.1");
    const again = await t.issue(account(1), "192.0.2.1");
    expect(again.expiresAt).toBe(first.expiresAt);
    expect(await sql`SELECT 1 FROM activation_tickets`).toHaveLength(1);
    expect(((await refusal(t.issue(account(2), "192.0.2.1"))) as unknown[])[0]).toBe(429);
  });

  test("concurrent requests cannot pass a cap together", async () => {
    const t = tickets({ ...LIMITS, perIpPerHour: 1 });
    const results = await Promise.all([1, 2, 3].map((i) => refusal(t.issue(account(i), "192.0.2.1"))));
    expect(results.filter((r) => r === null)).toHaveLength(1);
  });
});

describe("POST /v1/activation-ticket", () => {
  const post = (app: ReturnType<typeof activationTicketRoutes>, body: unknown, ip = "192.0.2.1") =>
    app.request("/activation-ticket", { method: "POST", headers: { "content-type": "application/json", "x-forwarded-for": ip }, body: JSON.stringify(body) });

  test("issues a ticket for the caller's address, keyed on the trusted proxy hop", async () => {
    const app = activationTicketRoutes(tickets(), 1, () => NOW);
    const res = await post(app, { account: account(1) }, "203.0.113.9, 192.0.2.1");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { expiresAt: number; signature: Hex };
    expect(body.expiresAt).toBe(NOW / 1000 + ACTIVATION_TICKET_TTL_SEC);
    // The entry the proxy appended counts, not what the client wrote before it.
    expect((await sql<{ ip: string }[]>`SELECT ip FROM activation_tickets`).map((r) => r.ip)).toEqual(["192.0.2.1"]);
  });

  test("refuses bad bodies, maps refusals, and answers 503 without a ticket key", async () => {
    const app = activationTicketRoutes(tickets(), 1, () => NOW);
    expect((await post(app, { account: "nope" })).status).toBe(400);
    code = delegationCode(DELEGATE);
    initialized = true;
    const active = await post(app, { account: account(1) });
    expect(active.status).toBe(409);
    expect(((await active.json()) as { error: string }).error).toContain("already active");
    expect((await post(activationTicketRoutes(null, 1, () => NOW), { account: account(1) })).status).toBe(503);
  });

  test("limits requests per address in memory before reading the chain", async () => {
    const app = activationTicketRoutes(tickets(), 1, () => NOW);
    down = true;
    for (let i = 0; i < 20; i++) expect((await post(app, { account: account(1) }, "192.0.2.77")).status).toBe(503);
    expect((await post(app, { account: account(1) }, "192.0.2.77")).status).toBe(429);
  });
});
