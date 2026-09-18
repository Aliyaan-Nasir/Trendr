import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { AuroraClient } from "@trendr/aurora";
import type { Sql } from "../src/db";
import { issueUserToken } from "../src/api/user-auth";
import { depositRoutes } from "../src/deposits/routes";
import { quietLog, testDb } from "./helpers";

/**
 * Any-chain deposit routes against Aurora's recorded responses (packages/aurora/test/fixtures):
 * dry quotes for anyone, deposit addresses only on Mainnet and only for the signed-in account,
 * status refreshes that move the deposit forward, and no reading another account's deposits.
 */

const fixtures = join(import.meta.dir, "../../packages/aurora/test/fixtures/swap");
const body = (name: string) => (JSON.parse(readFileSync(join(fixtures, name), "utf8")) as { body: Record<string, unknown> }).body;
const SECRET = "s".repeat(64);
const ME = "0x2222222222222222222222222222222222222222";
const OTHER = "0x3333333333333333333333333333333333333333";
const REFUND = "0x1111111111111111111111111111111111111111";
const BASE_USDC = "nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near";
const DEPOSIT_ADDRESS = "0x4444444444444444444444444444444444444444";
const NOW = Date.parse("2026-10-09T19:50:00.000Z");

let sql: Sql;
let status = "PENDING_DEPOSIT";

/** Aurora answering from the fixtures; a live quote gets a deposit address, as Aurora's do. */
const auroraFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = String(input);
  const json = (v: unknown) => new Response(JSON.stringify(v), { status: 200, headers: { "content-type": "application/json" } });
  if (url.includes("/api/tokens/")) return json(body("tokens.json"));
  if (url.includes("/api/quote/")) {
    const q = structuredClone(body("quote-dry-exact-input.json")) as { quote: Record<string, unknown>; quoteRequest: Record<string, unknown> };
    const req = JSON.parse(String(init?.body)) as Record<string, unknown>;
    q.quoteRequest = { ...q.quoteRequest, ...req };
    if (req.dry === false) q.quote = { ...q.quote, depositAddress: DEPOSIT_ADDRESS, deadline: "2026-10-09T21:00:00.000Z" };
    return json(q);
  }
  if (url.includes("/api/status/")) return json({ ...body("status-pending-deposit.json"), status });
  return new Response("not found", { status: 404 });
}) as typeof fetch;

const app = (live: boolean) =>
  depositRoutes({
    sql,
    aurora: new AuroraClient({ apiKey: "test-key", fetch: auroraFetch }),
    live,
    sessionSecret: SECRET,
    isRevoked: async () => false,
    keys: { stillActive: async () => true },
    trustedProxyHops: 0,
    log: quietLog,
    now: () => NOW,
  });
const token = (account: string) => issueUserToken(SECRET, account, account, Math.floor(NOW / 1000) + 3600);
const post = (a: ReturnType<typeof app>, path: string, payload: unknown, auth?: string) =>
  a.request(path, { method: "POST", headers: { "content-type": "application/json", ...(auth ? { authorization: `Bearer ${auth}` } : {}) }, body: JSON.stringify(payload) });
const request = { originAssetId: BASE_USDC, amount: "10000000", refundTo: REFUND, account: ME };

beforeAll(async () => {
  sql = await testDb();
  await sql`TRUNCATE deposits RESTART IDENTITY`;
});
afterAll(async () => {
  await sql.end();
});

describe("deposits", () => {
  test("lists where deposits can come from, Monad excluded", async () => {
    const res = (await (await app(false).request("/deposits/tokens")).json()) as { live: boolean; chains: Array<{ blockchain: string; tokens: Array<{ symbol: string }> }> };
    expect(res.live).toBe(false);
    expect(res.chains.some((c) => c.blockchain === "monad")).toBe(false);
    expect(res.chains.find((c) => c.blockchain === "base")?.tokens.map((t) => t.symbol)).toContain("USDC");
  });

  test("anyone gets a dry quote; an invalid refund address is refused before Aurora is asked", async () => {
    const res = await post(app(false), "/deposits/quote", request);
    expect(res.status).toBe(200);
    const view = (await res.json()) as { id: null; state: { phase: string; amountOutFormatted: string; destination: { blockchain: string } }; message: { title: string } };
    expect(view).toMatchObject({ id: null, state: { phase: "quoted", amountOutFormatted: "9.995317", destination: { blockchain: "monad" } }, message: { title: "Review your deposit" } });
    expect((await post(app(false), "/deposits/quote", { ...request, refundTo: "not-an-address" })).status).toBe(400);
  });

  test("deposit addresses exist only on Mainnet, for the signed-in account's own deposits", async () => {
    expect((await post(app(false), "/deposits", request, token(ME))).status).toBe(409);
    expect((await post(app(true), "/deposits", request)).status).toBe(401);
    expect((await post(app(true), "/deposits", request, token(OTHER))).status).toBe(403);
    const res = await post(app(true), "/deposits", request, token(ME));
    expect(res.status).toBe(201);
    const view = (await res.json()) as { id: number; state: { phase: string; depositAddress: string }; message: { requirements: string[] } };
    expect(view.state).toMatchObject({ phase: "awaiting_deposit", depositAddress: DEPOSIT_ADDRESS });
    expect(view.message.requirements.join(" ")).toContain(REFUND);
  });

  test("status refreshes move a deposit forward, and other accounts cannot see it", async () => {
    const a = app(true);
    const auth = { headers: { authorization: `Bearer ${token(ME)}` } };
    status = "PROCESSING";
    const view = (await (await a.request("/deposits/1", auth)).json()) as { state: { phase: string } };
    expect(view.state.phase).toBe("processing");
    const listed = (await (await a.request("/deposits", auth)).json()) as { deposits: Array<{ state: { phase: string } }> };
    expect(listed.deposits.map((d) => d.state.phase)).toEqual(["processing"]);
    expect((await a.request("/deposits/1", { headers: { authorization: `Bearer ${token(OTHER)}` } })).status).toBe(404);
  });
});
