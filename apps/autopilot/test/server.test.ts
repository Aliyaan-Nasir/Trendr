import { describe, expect, test } from "bun:test";
import type { ExecutorDb } from "../src/db";
import type { Executor } from "../src/executor";
import { healthServer } from "../src/server";

describe("server", () => {
  test("/live answers without the database, while /health is red", async () => {
    let dbReads = 0;
    const executor = { status: { lastTickAt: 0, lastError: "rpc down" } } as unknown as Executor;
    const db = {
      killSwitch: async () => {
        dbReads++;
        throw new Error("database unreachable");
      },
    } as unknown as ExecutorDb;
    const app = healthServer(executor, db, { chainId: 10143, rpcUrls: [], botVenue: null, tickSec: 30, alerts: () => ({}) });
    const live = await app.request("/live");
    expect(live.status).toBe(200);
    expect(await live.json()).toEqual({ live: true });
    expect(dbReads).toBe(0);
    const health = await app.request("/health");
    expect(health.status).toBe(503);
    expect(await health.json()).toMatchObject({ ok: false, kill: { engaged: true, reason: "database unreachable" } });
  });
});
