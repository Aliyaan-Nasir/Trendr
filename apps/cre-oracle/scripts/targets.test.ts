import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { configSchema } from "../attention-index/src/config";
import { syncConfig } from "./sync-config";
import { configPath, loopSetup, type OracleDeployment, periodSec, type Target } from "./targets";

describe("periodSec", () => {
  test("reads fixed-interval schedules", () => {
    expect(periodSec("0 */1 * * * *")).toBe(60);
    expect(periodSec("0 * * * * *")).toBe(60);
    expect(periodSec("0 */5 * * * *")).toBe(300);
    expect(periodSec("*/30 * * * * *")).toBe(30);
  });

  test("refuses schedules without a fixed interval", () => {
    expect(() => periodSec("0 0 * * * *")).toThrow();
    expect(() => periodSec("0 */5 9 * * *")).toThrow();
    expect(() => periodSec("*/5 * * * *")).toThrow();
  });
});

/**
 * The registry's staleness limit per chain, read from Deploy.s.sol so the oracle cadence and the
 * contracts cannot drift apart.
 */
function stalenessSec(): Record<Target, number> {
  const script = readFileSync(join(import.meta.dir, "..", "..", "..", "contracts", "script", "Deploy.s.sol"), "utf8");
  const source = script.slice(script.indexOf("function network()"));
  const unit = { seconds: 1, minutes: 60, hours: 3600 } as const;
  const out: Partial<Record<Target, number>> = {};
  for (const m of source.matchAll(/chainid == (TESTNET|MAINNET)\)[\s\S]*?stalenessLimit:\s*(\d+)\s*(seconds|minutes|hours)/g)) {
    out[m[1] === "MAINNET" ? "mainnet" : "testnet"] = Number(m[2]) * unit[m[3] as keyof typeof unit];
  }
  if (!out.mainnet || !out.testnet) throw new Error("staleness limits not found in Deploy.s.sol");
  return out as Record<Target, number>;
}

const config = (target: Target) => configSchema.parse(JSON.parse(readFileSync(configPath(target), "utf8")));

describe("oracle cadence", () => {
  const limits = stalenessSec();
  /** Seconds from a run's observation until its transaction lands (simulation runs take about 10 s). */
  const LANDING_SEC = 30;

  for (const target of ["testnet", "mainnet"] as const) {
    test(`${target}: every trend stays fresh even when one run fails`, () => {
      const c = config(target);
      // A trend is re-reported at the first run at or past its heartbeat; a failed run defers it
      // one more period. Each run must measure every live trend for that to hold.
      expect(c.sampling.heartbeatSec + 2 * periodSec(c.schedule) + LANDING_SEC).toBeLessThanOrEqual(limits[target]);
      expect(c.sampling.maxSamplesPerRun).toBeGreaterThanOrEqual(c.discovery.maxLiveTrends);
    });
  }

  test("Mainnet re-reports less often than Testnet: one report a heartbeat carries every trend", () => {
    expect(config("mainnet").sampling.heartbeatSec).toBe(720);
    expect(config("mainnet").sampling.heartbeatSec).toBeGreaterThan(config("testnet").sampling.heartbeatSec);
    expect(limits.mainnet).toBe(900);
  });
});

describe("loopSetup", () => {
  const dir = mkdtempSync(join(tmpdir(), "trendr-loop-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  const deployed: OracleDeployment = {
    chainId: 143,
    creMode: "mock",
    trendRegistry: "0x1111111111111111111111111111111111111111",
    trendrLens: "0x2222222222222222222222222222222222222222",
  };
  /** A project root and a repo with the given Mainnet deployment (or none), the config synced to `synced`. */
  const workspace = (name: string, deployment: OracleDeployment | null, synced: OracleDeployment = deployed) => {
    const root = join(dir, name, "apps", "cre-oracle");
    const repo = join(dir, name);
    mkdirSync(join(root, "attention-index"), { recursive: true });
    mkdirSync(join(repo, "contracts", "deployments"), { recursive: true });
    writeFileSync(configPath("mainnet", root), syncConfig(readFileSync(configPath("mainnet"), "utf8"), synced, { target: "mainnet" }));
    if (deployment) writeFileSync(join(repo, "contracts", "deployments", "143.json"), JSON.stringify(deployment));
    return { root, repo };
  };
  const confirmed = { CONFIRM_MAINNET: "yes", CRE_ETH_PRIVATE_KEY: "set" };

  test("Testnet runs as before, every minute with the default env file", () => {
    expect(loopSetup({ target: "testnet", env: {} })).toEqual({ everySec: 60, envArgs: [] });
    expect(loopSetup({ target: "testnet", everySec: 90, env: {} }).everySec).toBe(90);
  });

  test("Mainnet in mock mode runs every minute with its own keys", () => {
    const w = workspace("ok", deployed);
    expect(loopSetup({ target: "mainnet", env: confirmed, ...w })).toEqual({ everySec: 60, envArgs: ["--env", ".env.mainnet"] });
    // A local .env.mainnet stands in for exported keys.
    writeFileSync(join(w.root, ".env.mainnet"), "");
    expect(loopSetup({ target: "mainnet", env: { CONFIRM_MAINNET: "yes" }, ...w }).envArgs).toEqual(["--env", ".env.mainnet"]);
  });

  test("Mainnet needs explicit confirmation", () => {
    const w = workspace("confirm", deployed);
    expect(() => loopSetup({ target: "mainnet", env: { CRE_ETH_PRIVATE_KEY: "set" }, ...w })).toThrow("CONFIRM_MAINNET=yes");
  });

  test("Mainnet refuses before the deploy, on a production registry and on a stale config", () => {
    expect(() => loopSetup({ target: "mainnet", env: confirmed, ...workspace("none", null) })).toThrow("not deployed on Mainnet");
    expect(() => loopSetup({ target: "mainnet", env: confirmed, ...workspace("prod", { ...deployed, creMode: "production" }) })).toThrow(
      "the DON reports",
    );
    const moved = { ...deployed, trendrLens: "0x3333333333333333333333333333333333333333" };
    expect(() => loopSetup({ target: "mainnet", env: confirmed, ...workspace("stale", moved) })).toThrow("sync-config --target mainnet");
  });

  test("Mainnet never falls back to the Testnet keys in .env", () => {
    const w = workspace("keys", deployed);
    writeFileSync(join(w.root, ".env"), "");
    expect(() => loopSetup({ target: "mainnet", env: { CONFIRM_MAINNET: "yes" }, ...w })).toThrow(".env.mainnet");
  });

  test("unknown targets and short intervals are refused", () => {
    expect(() => loopSetup({ target: "base", env: {} })).toThrow("unknown target");
    expect(() => loopSetup({ target: "testnet", everySec: 5, env: {} })).toThrow("at least 15 seconds");
  });
});
