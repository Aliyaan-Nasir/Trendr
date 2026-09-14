import { describe, expect, test } from "bun:test";
import type { Alerts } from "@trendr/chain";
import type { Executor } from "../src/executor";
import type { Keeper } from "../src/keeper";
import { buildServer } from "../src/server";

describe("server", () => {
  test("/live answers while /health is red, so a low balance never blocks a deploy", async () => {
    const keeper = { healthy: () => false, address: "0x00000000000000000000000000000000000000aa", status: { balanceWei: 0n } } as unknown as Keeper;
    const executor = { stats: {} } as unknown as Executor;
    const alerts = { active: () => ({}) } as unknown as Alerts;
    const app = buildServer(keeper, executor, alerts, 10143);
    const health = await app.request("/health");
    expect(health.status).toBe(503);
    expect(await health.json()).toMatchObject({ ok: false, chainId: 10143, balanceWei: "0" });
    const live = await app.request("/live");
    expect(live.status).toBe(200);
    expect(await live.json()).toEqual({ live: true });
  });
});
