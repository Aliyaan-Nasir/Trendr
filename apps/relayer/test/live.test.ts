import { describe, expect, test } from "bun:test";
import pino from "pino";
import { buildServer } from "../src/server";
import type { RelayerService } from "../src/service";

const log = pino({ level: "silent" });

describe("live", () => {
  test("answers while every sponsor key is broke and the balances cannot be read", async () => {
    let reads = 0;
    const service = { usage: async () => null } as unknown as RelayerService;
    const broke = buildServer({ service, allowedOrigins: [], log, funds: async () => [{ address: "0x0000000000000000000000000000000000000001", balanceWei: 0n }], minBalanceWei: 1n });
    const unreadable = buildServer({
      service,
      allowedOrigins: [],
      log,
      funds: async () => {
        reads++;
        throw new Error("rpc down");
      },
    });
    expect((await broke.request("/v1/health")).status).toBe(503);
    for (const app of [broke, unreadable]) {
      const res = await app.request("/live");
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ live: true });
    }
    expect(reads).toBe(0);
  });
});
