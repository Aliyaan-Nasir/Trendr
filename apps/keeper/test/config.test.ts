import { describe, expect, test } from "bun:test";
import { loadConfig } from "../src/config";

const base = {
  RPC_URL: "https://testnet-rpc.monad.xyz",
  CHAIN_ID: "10143",
  KEEPER_PRIVATE_KEY: `0x${"11".repeat(32)}`,
};

describe("loadConfig", () => {
  test("treats empty optional settings as unset and applies defaults", () => {
    const cfg = loadConfig({ ...base, WS_URL: "", ALERT_WEBHOOK_URL: "", DEPLOYMENT_JSON: "" });
    expect(cfg.WS_URL).toBeUndefined();
    expect(cfg.ALERT_WEBHOOK_URL).toBeUndefined();
    expect(cfg.SERIES_WINDOWS).toEqual([86400, 604800]);
    expect(cfg.deployment.chainId).toBe(10143);
  });

  test("rejects a listed window that is not opened", () => {
    expect(() => loadConfig({ ...base, SERIES_WINDOWS: "86400", LIST_WINDOWS: "86400,900" })).toThrow("LIST_WINDOWS");
  });

  test("opens and lists no series when both window lists are empty (Mainnet before Up/Down goes live)", () => {
    const cfg = loadConfig({ ...base, SERIES_WINDOWS: "", LIST_WINDOWS: "" });
    expect(cfg.SERIES_WINDOWS).toEqual([]);
    expect(cfg.LIST_WINDOWS).toEqual([]);
  });

  test("rejects a malformed key", () => {
    expect(() => loadConfig({ ...base, KEEPER_PRIVATE_KEY: "0x12" })).toThrow();
  });
});
