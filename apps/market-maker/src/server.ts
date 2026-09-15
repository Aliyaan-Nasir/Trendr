import { type Alerts, endpointPool } from "@trendr/chain";
import { Hono } from "hono";
import type { MarketMaker } from "./engine";

const json = (value: unknown) => JSON.parse(JSON.stringify(value, (_k, v) => (typeof v === "bigint" ? v.toString() : v)));

export function buildServer(mm: MarketMaker, alerts: Alerts, chainId: number, rpcUrls: readonly string[] = []) {
  const app = new Hono();
  // Liveness for the platform's deploy check: the process serves, whatever the key holds.
  app.get("/live", (c) => c.json({ live: true }));
  app.get("/health", (c) => {
    const ok = mm.healthy();
    const s = mm.status;
    const pnl = s.baselineEquity === null ? null : s.equity - s.baselineEquity;
    return c.json(json({ ok, chainId, maker: mm.me, ...s, pnl, alerts: alerts.active(), rpc: endpointPool(rpcUrls)?.report() ?? [] }), ok ? 200 : 503);
  });
  return app;
}
