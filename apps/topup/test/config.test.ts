import { describe, expect, test } from "bun:test";
import { parseEther } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { loadConfig, parseTargets } from "../src/config";

const KEY = `0x${"11".repeat(32)}` as const;
const A = "0x00000000000000000000000000000000000000a1";
const B = "0x00000000000000000000000000000000000000B2";
const base = {
  RPC_URL: "https://testnet-rpc.monad.xyz",
  CHAIN_ID: "10143",
  TREASURY_PRIVATE_KEY: KEY,
  TARGETS: `oracle:${A}:5:20:20:60, keeper:${B}:3:12:12:30`,
};

describe("parseTargets", () => {
  test("reads entries in priority order, amounts in MON, addresses lowercased", () => {
    const targets = parseTargets(`oracle:${A}:5:20:20:60;\nkeeper:${B}:1.5:5:5:20`);
    expect(targets.map((t) => t.name)).toEqual(["oracle", "keeper"]);
    expect(targets[1]).toEqual({
      name: "keeper",
      address: B.toLowerCase() as `0x${string}`,
      min: parseEther("1.5"),
      target: parseEther("5"),
      maxPerTransfer: parseEther("5"),
      maxPerDay: parseEther("20"),
    });
  });

  test.each([
    [`oracle:${A}:5:20:20`, "needs name:address"],
    [`oracle:0x1234:5:20:20:60`, "invalid address"],
    [`oracle:${A}:5:abc:20:60`, "invalid MON amount"],
    [`oracle:${A}:0:20:20:60`, "min must be above zero"],
    [`oracle:${A}:20:20:20:60`, "target must be above min"],
    [`oracle:${A}:5:20:20:10`, "maxPerDay must be at least maxPerTransfer"],
    [`oracle:${A}:5:20:20:60,oracle:${B}:5:20:20:60`, "listed twice"],
    [`oracle:${A}:5:20:20:60,keeper:${A.toUpperCase().replace("0X", "0x")}:5:20:20:60`, "listed twice"],
    [`bad name:${A}:5:20:20:60`, "name"],
    [" , ", "no wallets"],
  ])("rejects %s", (text, message) => {
    expect(() => parseTargets(text)).toThrow(message);
  });
});

describe("loadConfig", () => {
  test("applies defaults and Monad's 10 MON reserve on Testnet", () => {
    const cfg = loadConfig({ ...base, DATABASE_URL: "", ALERT_WEBHOOK_URL: "", ADMIN_TOKEN: "" });
    expect(cfg.CHECK_INTERVAL_SEC).toBe(120);
    expect(cfg.COOLDOWN_SEC).toBe(600);
    expect(cfg.DRY_RUN).toBe(false);
    expect(cfg.DATABASE_URL).toBeUndefined();
    expect(cfg.monadReserve).toBe(parseEther("10"));
    expect(cfg.floor).toBe(parseEther("12"));
    expect(cfg.treasury).toBe(privateKeyToAccount(KEY).address.toLowerCase() as `0x${string}`);
    expect(cfg.rpcUrls).toEqual(["https://testnet-rpc.monad.xyz"]);
  });

  test("has no chain reserve off Monad unless set", () => {
    expect(loadConfig({ ...base, CHAIN_ID: "31337" }).floor).toBe(parseEther("2"));
    expect(loadConfig({ ...base, CHAIN_ID: "31337", MONAD_RESERVE_MON: "10", TREASURY_RESERVE_MON: "0.5" }).floor).toBe(parseEther("10.5"));
  });

  test("refuses Mainnet unless ALLOW_MAINNET=1", () => {
    expect(() => loadConfig({ ...base, CHAIN_ID: "143" })).toThrow("ALLOW_MAINNET");
    expect(() => loadConfig({ ...base, CHAIN_ID: "143", ALLOW_MAINNET: "0" })).toThrow("ALLOW_MAINNET");
    const cfg = loadConfig({ ...base, CHAIN_ID: "143", ALLOW_MAINNET: "1" });
    expect(cfg.CHAIN_ID).toBe(143);
    expect(cfg.monadReserve).toBe(parseEther("10"));
  });

  test("reads DRY_RUN as a flag", () => {
    expect(loadConfig({ ...base, DRY_RUN: "1" }).DRY_RUN).toBe(true);
    expect(loadConfig({ ...base, DRY_RUN: "0" }).DRY_RUN).toBe(false);
  });

  test("refuses the treasury as a target", () => {
    const self = privateKeyToAccount(KEY).address;
    expect(() => loadConfig({ ...base, TARGETS: `me:${self}:1:2:2:4` })).toThrow("treasury itself");
  });

  test("refuses a transfer cap below the smallest transfer", () => {
    expect(() => loadConfig({ ...base, TARGETS: `tiny:${A}:0.01:0.05:0.05:1` })).toThrow("MIN_TRANSFER_MON");
  });

  test("refuses a malformed key or target list", () => {
    expect(() => loadConfig({ ...base, TREASURY_PRIVATE_KEY: "0x12" })).toThrow();
    expect(() => loadConfig({ ...base, TARGETS: "oracle:nope" })).toThrow("needs name:address");
  });
});
