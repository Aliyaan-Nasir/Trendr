import { describe, expect, test } from "bun:test";
import { describeHealth, parseServices, serviceDetails } from "../src/status";

const TREASURY = "0x0000000000000000000000000000000000001001";
const ORACLE = "0x0000000000000000000000000000000000001002";
const HASH = `0x${"ab".repeat(32)}`;

/** Bodies as each service's /health answers them (trimmed). */
const bodies: Record<string, unknown> = {
  keeper: { ok: true, keeper: "0x0000000000000000000000000000000000001003", balanceWei: "4006024950000000000", lastError: null, alerts: {} },
  "market-maker": { ok: true, maker: "0x8b81C6fcB4B37417184F81A207a4D9104E07f9FA", balanceWei: "15000000000000000000", lastError: "quote failed", alerts: { lowBalance: "below 4 MON" } },
  relayer: { ok: true, keys: [{ address: "0x0000000000000000000000000000000000001004", mon: 8 }], budget: {} },
  autopilot: { ok: true, botVenue: "api", lastError: null, alerts: {} },
  topup: {
    ok: true,
    lastCheck: { at: 1, durationMs: 5, error: null },
    treasury: { address: TREASURY, balance: "456.67", floor: "12", spendable: "444.67", burnPerDay: "40.5", runwayDays: 10.98 },
    targets: [
      { name: "oracle", address: ORACLE, balance: "30", min: "10", target: "30", state: "ok", lastTransfer: { amount: "21.06", at: 1791719143560, status: "confirmed", hash: HASH } },
      { name: "faucet", address: "0x0000000000000000000000000000000000001005", balance: "1.04", min: "0.5", target: "2", state: "ok", lastTransfer: null },
    ],
    alerts: {},
  },
};

describe("service details", () => {
  test("names each service's wallets and the top-up treasury", () => {
    expect(describeHealth(bodies.keeper).wallets).toEqual([{ label: "Keeper", address: "0x0000000000000000000000000000000000001003", mon: "4.00602495" }]);
    const mm = describeHealth(bodies["market-maker"]);
    expect(mm.wallets[0]).toMatchObject({ label: "Maker", mon: "15" });
    expect(mm.lastError).toBe("quote failed");
    expect(mm.alerts).toEqual(["lowBalance: below 4 MON"]);
    expect(describeHealth(bodies.relayer).wallets).toEqual([{ label: "Sponsor key 1", address: "0x0000000000000000000000000000000000001004", mon: "8" }]);
    expect(describeHealth(bodies.autopilot)).toEqual({ lastError: null, alerts: [], wallets: [], treasury: null });

    const t = describeHealth(bodies.topup).treasury!;
    expect(t).toMatchObject({ address: TREASURY, balanceMon: "456.67", floorMon: "12", spendableMon: "444.67", burnPerDayMon: "40.5", runwayDays: 10.98 });
    expect(t.targets.map((x) => [x.name, x.lastTransfer?.hash ?? null])).toEqual([
      ["oracle", HASH],
      ["faucet", null],
    ]);
  });

  test("anything unexpected reads as up or down only", () => {
    expect(describeHealth(null)).toEqual({ lastError: null, alerts: [], wallets: [], treasury: null });
    expect(describeHealth({ ok: false, error: "could not read the sponsor balances", keys: "nope", treasury: { address: "x" } })).toEqual({ lastError: "could not read the sponsor balances", alerts: [], wallets: [], treasury: null });
  });

  test("probes every configured service and never throws", async () => {
    const services = parseServices("keeper=http://k/health,topup=http://t/health,relayer=http://r/v1/health");
    const fetchImpl = async (url: string) => {
      if (url.startsWith("http://r/")) throw new Error("connection refused");
      return new Response(JSON.stringify(url.startsWith("http://k/") ? bodies.keeper : bodies.topup), { status: url.startsWith("http://t/") ? 503 : 200 });
    };
    const out = await serviceDetails(services, fetchImpl);
    expect(out.map((s) => [s.name, s.ok, s.httpStatus])).toEqual([
      ["keeper", true, 200],
      ["topup", false, 503],
      ["relayer", false, null],
    ]);
    expect(out[1]!.treasury?.balanceMon).toBe("456.67");
    expect(out[2]!.lastError).toBe("no answer");
  });
});
