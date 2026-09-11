import { describe, expect, test } from "bun:test";
import pino from "pino";
import { buildServer } from "../src/server";
import type { RelayerService } from "../src/service";

const log = pino({ level: "silent" });
const MON = 10n ** 18n;
const usage = {
  limits: { accountGasPerDay: 40_000_000, totalGasPerHour: 300_000_000, activationsPerHour: 60 },
  lastHour: { gas: 1_200_000, activations: 1 },
  today: { accounts: 1, busiestAccountGas: 1_200_000, reverts: 0 },
  coolingDown: 0,
  busyAccounts: 0,
};
const service = { usage: async () => usage } as unknown as RelayerService;

function server(balances: bigint[]) {
  return buildServer({
    service,
    allowedOrigins: ["http://localhost:3000"],
    log,
    funds: async () => balances.map((b, i) => ({ address: `0x${String(i).padStart(40, "0")}`, balanceWei: b })),
    minBalanceWei: MON,
  });
}

describe("health", () => {
  test("is red only when no sponsor key can pay", async () => {
    const funded = await server([MON / 10n, 2n * MON]).request("/v1/health");
    expect(funded.status).toBe(200);
    expect(await funded.json()).toMatchObject({ ok: true, keys: [{ mon: 0.1 }, { mon: 2 }], budget: usage });
    const broke = await server([MON / 10n, 0n]).request("/v1/health");
    expect(broke.status).toBe(503);
    expect(await broke.json()).toMatchObject({ ok: false, budget: usage });
  });

  test("a spent budget is reported but does not turn health red", async () => {
    const spent = { ...usage, lastHour: { gas: 300_000_000, activations: 60 }, coolingDown: 3 };
    const res = await buildServer({ service: { usage: async () => spent } as unknown as RelayerService, allowedOrigins: [], log }).request("/v1/health");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, budget: spent });
  });

  test("reports each RPC endpoint by provider when given them", async () => {
    const rpc = [{ provider: "monad.xyz", requests: 4, failures: 1, healthy: true }];
    const res = await buildServer({ service, allowedOrigins: [], log, rpc: () => rpc }).request("/v1/health");
    expect(await res.json()).toEqual({ ok: true, budget: usage, rpc });
  });

  test("without a balance source it reports the process and the budgets", async () => {
    const res = await buildServer({ service, allowedOrigins: [], log }).request("/v1/health");
    expect(await res.json()).toEqual({ ok: true, budget: usage });
  });
});
