import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { configSchema } from "../attention-index/src/config";
import { syncConfig } from "./sync-config";
import { configPath, deploymentPath, type OracleDeployment } from "./targets";

const mainnetText = readFileSync(configPath("mainnet"), "utf8");
const deployed: OracleDeployment = {
  chainId: 143,
  creMode: "mock",
  trendRegistry: "0x1111111111111111111111111111111111111111",
  trendrLens: "0x2222222222222222222222222222222222222222",
};

const changedLines = (a: string, b: string) => {
  const x = a.split("\n");
  const y = b.split("\n");
  expect(y.length).toBe(x.length);
  return y.filter((line, i) => line !== x[i]);
};

describe("sync-config", () => {
  test("writes the deployment's registry and lens and changes nothing else", () => {
    const out = syncConfig(mainnetText, deployed, { target: "mainnet" });
    expect(changedLines(mainnetText, out)).toEqual([
      `  "registry": "${deployed.trendRegistry}",`,
      `  "lens": "${deployed.trendrLens}",`,
    ]);
    const cfg = configSchema.parse(JSON.parse(out));
    expect(cfg.registry).toBe(deployed.trendRegistry);
    expect(cfg.lens).toBe(deployed.trendrLens);
    // Running it again is a no-op.
    expect(syncConfig(out, deployed, { target: "mainnet" })).toBe(out);
  });

  test("fills the backend's collector and candidate URLs when given", () => {
    const out = syncConfig(mainnetText, deployed, { target: "mainnet", backendUrl: "https://api.trendr.example/" });
    const cfg = configSchema.parse(JSON.parse(out));
    expect(cfg.collector.measurementsUrl).toBe("https://api.trendr.example/v1/oracle/measurements");
    expect(cfg.discovery.candidatesUrl).toBe("https://api.trendr.example/v1/oracle/candidates");
    expect(changedLines(mainnetText, out)).toHaveLength(4);
  });

  test("refuses a backend the workflow could not call", () => {
    expect(() => syncConfig(mainnetText, deployed, { target: "mainnet", backendUrl: "http://api.trendr.example" })).toThrow();
  });

  test("refuses a deployment for another chain or without addresses", () => {
    expect(() => syncConfig(mainnetText, { ...deployed, chainId: 10_143 }, { target: "mainnet" })).toThrow("not mainnet");
    expect(() => syncConfig(mainnetText, { ...deployed, trendRegistry: `0x${"0".repeat(40)}` }, { target: "mainnet" })).toThrow("no trendRegistry");
    expect(() => syncConfig(mainnetText, { ...deployed, trendrLens: "" }, { target: "mainnet" })).toThrow("no trendrLens");
  });

  test("refuses to write Mainnet addresses into the Testnet config", () => {
    const testnetText = readFileSync(configPath("testnet"), "utf8");
    expect(() => syncConfig(testnetText, { ...deployed, chainId: 10_143 }, { target: "mainnet" })).toThrow();
  });

  test("the Testnet config matches contracts/deployments/10143.json", () => {
    const testnetText = readFileSync(configPath("testnet"), "utf8");
    const deployment = JSON.parse(readFileSync(deploymentPath("testnet"), "utf8")) as OracleDeployment;
    expect(syncConfig(testnetText, deployment, { target: "testnet" })).toBe(testnetText);
  });
});
