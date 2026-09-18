import {
  type AuroraClient,
  AuroraHttpError,
  type AuroraToken,
  chainName,
  type DepositState,
  depositFromQuote,
  depositQuoteRequest,
  describeDeposit,
  isSettled,
  MONAD_BLOCKCHAIN,
  monadAsset,
  withClock,
  withDepositTx,
  withStatus,
} from "@trendr/aurora";
import { Hono } from "hono";
import { isAddress } from "viem";
import { z } from "zod";
import type { Sql } from "../db";
import { type AccountKeys, userAuth } from "../api/user-auth";
import { byIp, rateLimit } from "../api/rate-limit";
import type { Log } from "../log";

/**
 * Any-chain deposits through Aurora Intents' Swap API: the user picks an asset on any supported
 * chain, sees a real quote, and on Mainnet gets a one-time deposit address that lands USDC in their
 * Trendr account on Monad, refunding to their own sending address if anything fails. The API key
 * stays on the server. Aurora supports Monad Mainnet only, so live addresses are Mainnet only.
 */

export interface DepositDeps {
  sql: Sql;
  aurora: AuroraClient;
  /** True on Monad Mainnet, where deposit addresses can be created. */
  live: boolean;
  sessionSecret: string;
  isRevoked: (tokenHash: string) => Promise<boolean>;
  keys: Pick<AccountKeys, "stillActive">;
  /** Proxies that append to X-Forwarded-For in front of the backend (see TRUSTED_PROXY_HOPS). */
  trustedProxyHops: number;
  log: Log;
  now?: () => number;
}

const quoteBody = z.object({
  originAssetId: z.string().min(1).max(200),
  /** Raw units of the origin asset. */
  amount: z.string().regex(/^\d{1,40}$/),
  refundTo: z.string().min(1).max(120),
  account: z.string().refine((a) => isAddress(a), "bad account"),
});
const txBody = z.object({ txHash: z.string().min(16).max(120) });

const issues = (e: z.ZodError) => e.issues.map((i) => `${i.path.join(".") || "body"}: ${i.message}`).join("; ");

export function depositRoutes(d: DepositDeps) {
  const now = d.now ?? Date.now;
  const app = new Hono<{ Variables: { user: string; token: string } }>();
  const auth = userAuth(d.sessionSecret, d.isRevoked, d.keys, now);

  const tokens = async () => {
    const list = await d.aurora.tokens();
    return { list, usdc: monadAsset(list, "USDC") };
  };
  const view = (id: number | null, state: DepositState) => ({ id, state, message: describeDeposit(state) });
  const failure = (e: unknown) => {
    if (e instanceof AuroraHttpError) return { status: 502 as const, error: `Aurora: ${e.message}` };
    return { status: 400 as const, error: e instanceof Error ? e.message : "could not quote" };
  };

  /** Where deposits can come from: every Aurora asset outside Monad, grouped by chain. */
  app.get("/deposits/tokens", async (c) => {
    const { list } = await tokens();
    const chains = list.chains().filter((b) => b !== MONAD_BLOCKCHAIN);
    return c.json({
      live: d.live,
      chains: chains.map((b) => ({
        blockchain: b,
        name: chainName(b),
        tokens: list.onChain(b).map((t: AuroraToken) => ({ assetId: t.assetId, symbol: t.symbol, decimals: t.decimals, price: t.price })),
      })),
    });
  });

  /** A real quote without a deposit address (dry): what arrives and how long it takes. */
  app.post("/deposits/quote", rateLimit(30, 60_000, byIp(d.trustedProxyHops), now), async (c) => {
    const b = quoteBody.safeParse(await c.req.json().catch(() => null));
    if (!b.success) return c.json({ error: issues(b.error) }, 400);
    try {
      const { list, usdc } = await tokens();
      const origin = list.byAssetId(b.data.originAssetId);
      if (!origin) return c.json({ error: "Aurora does not support that asset" }, 400);
      const req = depositQuoteRequest({ origin, destination: usdc, amount: BigInt(b.data.amount), account: b.data.account, refundTo: b.data.refundTo, dry: true, now });
      return c.json(view(null, depositFromQuote(await d.aurora.quote(req), { origin, destination: usdc }, now())));
    } catch (e) {
      const f = failure(e);
      return c.json({ error: f.error }, f.status);
    }
  });

  /** A live quote: a one-time deposit address for the signed-in account (Mainnet only). */
  app.post("/deposits", auth, async (c) => {
    if (!d.live) return c.json({ error: "Any-chain deposits run on Monad Mainnet; this is Testnet." }, 409);
    const b = quoteBody.safeParse(await c.req.json().catch(() => null));
    if (!b.success) return c.json({ error: issues(b.error) }, 400);
    if (b.data.account.toLowerCase() !== c.get("user").toLowerCase()) return c.json({ error: "deposits go to your own account" }, 403);
    try {
      const { list, usdc } = await tokens();
      const origin = list.byAssetId(b.data.originAssetId);
      if (!origin) return c.json({ error: "Aurora does not support that asset" }, 400);
      const req = depositQuoteRequest({ origin, destination: usdc, amount: BigInt(b.data.amount), account: b.data.account, refundTo: b.data.refundTo, dry: false, now });
      const state = depositFromQuote(await d.aurora.quote(req), { origin, destination: usdc }, now());
      if (!state.depositAddress) return c.json({ error: "Aurora returned no deposit address" }, 502);
      const rows = await d.sql<{ id: string }[]>`
        INSERT INTO deposits (account, deposit_address, deposit_memo, state, phase)
        VALUES (${c.get("user").toLowerCase()}, ${state.depositAddress}, ${state.depositMemo ?? null}, ${d.sql.json(state as never)}, ${state.phase})
        RETURNING id`;
      d.log.info({ account: c.get("user"), origin: origin.symbol, chain: origin.blockchain }, "deposit address created");
      return c.json(view(Number(rows[0]!.id), state), 201);
    } catch (e) {
      const f = failure(e);
      return c.json({ error: f.error }, f.status);
    }
  });

  const load = async (id: number, account: string) => {
    const rows = await d.sql<{ id: string; state: DepositState }[]>`SELECT id, state FROM deposits WHERE id = ${id} AND account = ${account.toLowerCase()}`;
    return rows[0] ? { id: Number(rows[0].id), state: rows[0].state } : null;
  };
  const save = (id: number, state: DepositState) =>
    d.sql`UPDATE deposits SET state = ${d.sql.json(state as never)}, phase = ${state.phase}, updated_at = now() WHERE id = ${id}`;

  app.get("/deposits", auth, async (c) => {
    const rows = await d.sql<{ id: string; state: DepositState }[]>`SELECT id, state FROM deposits WHERE account = ${c.get("user").toLowerCase()} ORDER BY created_at DESC LIMIT 20`;
    return c.json({ deposits: rows.map((r) => view(Number(r.id), r.state)) });
  });

  /** A deposit's state, refreshed from Aurora until it settles. */
  app.get("/deposits/:id", auth, async (c) => {
    const found = await load(Number(c.req.param("id")), c.get("user"));
    if (!found) return c.json({ error: "no such deposit" }, 404);
    let state = withClock(found.state, now());
    if (!isSettled(state) && state.depositAddress && state.phase !== "expired") {
      try {
        state = withStatus(state, await d.aurora.status(state.depositAddress, state.depositMemo), now());
      } catch (e) {
        d.log.warn({ id: found.id, error: e instanceof Error ? e.message : String(e) }, "deposit status failed");
      }
    }
    if (state !== found.state) await save(found.id, state);
    return c.json(view(found.id, state));
  });

  /** The user's deposit transaction, so Aurora detects it sooner. */
  app.post("/deposits/:id/tx", auth, async (c) => {
    const b = txBody.safeParse(await c.req.json().catch(() => null));
    if (!b.success) return c.json({ error: issues(b.error) }, 400);
    const found = await load(Number(c.req.param("id")), c.get("user"));
    if (!found || !found.state.depositAddress) return c.json({ error: "no such deposit" }, 404);
    let state = withDepositTx(found.state, b.data.txHash, now());
    try {
      state = withStatus(state, await d.aurora.submitDeposit({ txHash: b.data.txHash, depositAddress: found.state.depositAddress, ...(found.state.depositMemo ? { memo: found.state.depositMemo } : {}) }), now());
    } catch (e) {
      d.log.warn({ id: found.id, error: e instanceof Error ? e.message : String(e) }, "deposit submit failed");
    }
    await save(found.id, state);
    return c.json(view(found.id, state));
  });

  return app;
}
