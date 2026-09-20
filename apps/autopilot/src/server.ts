import { endpointPool } from "@trendr/chain";
import { Hono } from "hono";
import type { ExecutorDb } from "./db";
import type { Executor } from "./executor";

/** GET /health: the loop's last tick, the kill switch, rules, orders in flight and RPC health. */
export function healthServer(executor: Executor, db: ExecutorDb, info: { chainId: number; rpcUrls: string[]; botVenue: string | null; tickSec: number; alerts: () => Record<string, string> }) {
  const app = new Hono();
  // Liveness for the platform's deploy check: the process serves, whatever the database or the chain says.
  app.get("/live", (c) => c.json({ live: true }));
  app.get("/health", async (c) => {
    const s = executor.status;
    const stale = Date.now() / 1000 - s.lastTickAt > info.tickSec * 4;
    const kill = await db.killSwitch().catch(() => ({ engaged: true, reason: "database unreachable" }));
    const ok = !stale && s.lastError === null;
    return c.json({ ok, chainId: info.chainId, botVenue: info.botVenue, kill, ...s, alerts: info.alerts(), rpc: endpointPool(info.rpcUrls)?.report() ?? [] }, ok ? 200 : 503);
  });
  return app;
}
