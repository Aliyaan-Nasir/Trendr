import { createHash, timingSafeEqual } from "node:crypto";
import { endpointPool } from "@trendr/chain";
import { Hono } from "hono";
import type { TopUp } from "./topup";

const json = (value: unknown) => JSON.parse(JSON.stringify(value, (_k, v) => (typeof v === "bigint" ? v.toString() : v)));
const digest = (s: string) => createHash("sha256").update(s).digest();

export interface ServerOptions {
  chainId: number;
  store: string;
  rpcUrls?: readonly string[];
  /** Enables POST /targets/:name/release. */
  adminToken?: string;
}

export function buildServer(topup: TopUp, o: ServerOptions) {
  const app = new Hono();
  // Liveness for the platform's deploy check: the process serves, whatever the treasury holds.
  app.get("/live", (c) => c.json({ live: true }));
  // 503 when checks stop succeeding or the treasury is below its floor.
  app.get("/health", (c) => {
    const ok = topup.healthy();
    return c.json(json({ ok, chainId: o.chainId, store: o.store, ...topup.view(), rpc: endpointPool(o.rpcUrls ?? [])?.report() ?? [] }), ok ? 200 : 503);
  });
  app.post("/targets/:name/release", async (c) => {
    if (!o.adminToken) return c.json({ error: "release is off: set ADMIN_TOKEN" }, 404);
    const given = (c.req.header("authorization") ?? "").replace(/^Bearer\s+/i, "");
    if (!timingSafeEqual(digest(given), digest(o.adminToken))) return c.json({ error: "unauthorized" }, 401);
    const result = await topup.release(c.req.param("name"));
    const status = result === "released" ? 200 : result === "unknown-target" ? 404 : 409;
    return c.json({ result }, status);
  });
  return app;
}
