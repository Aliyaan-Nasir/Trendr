import { type Alerts, endpointPool } from "@trendr/chain";
import { Hono } from "hono";
import type { Executor } from "./executor";
import type { Keeper } from "./keeper";

const json = (value: unknown) => JSON.parse(JSON.stringify(value, (_k, v) => (typeof v === "bigint" ? v.toString() : v)));

export function buildServer(keeper: Keeper, executor: Executor, alerts: Alerts, chainId: number, rpcUrls: readonly string[] = []) {
  const app = new Hono();
  // Liveness for the platform's deploy check: the process serves, whatever the key holds.
  app.get("/live", (c) => c.json({ live: true }));
  app.get("/health", (c) => {
    const ok = keeper.healthy();
    return c.json(
      json({ ok, chainId, keeper: keeper.address, ...keeper.status, alerts: alerts.active(), actions: executor.stats, rpc: endpointPool(rpcUrls)?.report() ?? [] }),
      ok ? 200 : 503,
    );
  });
  return app;
}
