import { describe, expect, test } from "bun:test";
import { DEFAULT_LIMITS } from "../src/budget";
import { loadConfig } from "../src/config";

/** A placeholder key: the config only checks its shape. */
const env = { RPC_URL: "http://127.0.0.1:8545", CHAIN_ID: "10143", RELAYER_PRIVATE_KEYS: `0x${"11".repeat(32)}` };

describe("config", () => {
  test("defaults to no trusted proxy and the default budgets", () => {
    const cfg = loadConfig(env);
    expect(cfg.TRUSTED_PROXY_HOPS).toBe(0);
    expect(cfg.ACTIVATIONS_PER_IP_PER_HOUR).toBe(5);
    expect(cfg.limits).toEqual(DEFAULT_LIMITS);
  });

  test("reads proxy hops and budgets from the environment", () => {
    const cfg = loadConfig({
      ...env,
      TRUSTED_PROXY_HOPS: "1",
      ACCOUNT_GAS_PER_DAY: "20000000",
      RELAYER_GAS_PER_HOUR: "100000000",
      ACTIVATIONS_PER_HOUR: "10",
      ACTIVATIONS_PER_IP_PER_HOUR: "2",
      REVERTS_BEFORE_COOLDOWN: "5",
      REVERT_COOLDOWN_SECONDS: "900",
    });
    expect(cfg.TRUSTED_PROXY_HOPS).toBe(1);
    expect(cfg.ACTIVATIONS_PER_IP_PER_HOUR).toBe(2);
    expect(cfg.limits).toEqual({
      accountGasPerDay: 20_000_000n,
      totalGasPerHour: 100_000_000n,
      activationsPerHour: 10,
      revertsBeforeCooldown: 5,
      revertCooldownSeconds: 900,
    });
  });

  test("refuses nonsense", () => {
    expect(() => loadConfig({ ...env, TRUSTED_PROXY_HOPS: "-1" })).toThrow();
    expect(() => loadConfig({ ...env, ACCOUNT_GAS_PER_DAY: "0" })).toThrow();
    expect(() => loadConfig({ ...env, ACTIVATIONS_PER_HOUR: "0" })).toThrow();
  });
});
