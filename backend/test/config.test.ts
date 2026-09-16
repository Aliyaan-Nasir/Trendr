import { describe, expect, test } from "bun:test";
import { loadConfig } from "../src/config";
import { assetClassOf, baseOf, defaultKeywords, defaultName, makeIdentifier, slugify, tickerOf } from "../src/identifiers";

const env = { DATABASE_URL: "postgres://x", ORACLE_TOKEN: "0123456789abcdef" };

describe("config", () => {
  test("reads lists, treats empty optional values as unset, and loads the chain's deployment", () => {
    const cfg = loadConfig({ ...env, MONAD_RPC_URLS: " https://a.example , https://b.example ,", GEMINI_API_KEY: "", ELFA_API_KEYS: "k1, k2", ADMIN_ADDRESSES: "0x00000000000000000000000000000000000000AA" });
    expect(cfg.rpcUrls).toEqual(["https://a.example", "https://b.example"]);
    expect(cfg.GEMINI_API_KEY).toBeUndefined();
    expect(cfg.ELFA_API_KEYS).toEqual(["k1", "k2"]);
    expect(cfg.ADMIN_ADDRESSES).toEqual(["0x00000000000000000000000000000000000000aa"]);
    expect(cfg.deployment.chainId).toBe(10143);
  });

  test("trusts no proxy unless told how many append to X-Forwarded-For, and budgets AI and the faucet", () => {
    const base = { ...env, MONAD_RPC_URL: "https://a.example" };
    expect(loadConfig(base)).toMatchObject({ TRUSTED_PROXY_HOPS: 0, AI_DAILY_CALLS: 400, FAUCET_DAILY_CAP: 200 });
    expect(loadConfig({ ...base, TRUSTED_PROXY_HOPS: "1" }).TRUSTED_PROXY_HOPS).toBe(1);
    expect(() => loadConfig({ ...base, TRUSTED_PROXY_HOPS: "-1" })).toThrow();
    expect(() => loadConfig({ ...base, TRUSTED_PROXY_HOPS: "1.5" })).toThrow();
  });

  test("merges the services the system view probes, with their flags, and refuses an unknown flag", () => {
    const base = { ...env, MONAD_RPC_URL: "https://a.example" };
    const cfg = loadConfig({
      ...base,
      STATUS_SERVICES: "keeper=http://k:4200/health|staleMin=5, relayer=http://r:4100/v1/health",
      ADMIN_SERVICES: "worker=http://w:4600/health|optional|staleMin=120,gateway=http://g:4601/health|staleMin=0.5,keeper=http://other/health",
    });
    expect(cfg.systemServices).toEqual([
      { name: "keeper", url: "http://k:4200/health", staleMs: 300_000 },
      { name: "relayer", url: "http://r:4100/v1/health" },
      { name: "worker", url: "http://w:4600/health", optional: true, staleMs: 7_200_000 },
      { name: "gateway", url: "http://g:4601/health", staleMs: 30_000 },
    ]);
    expect(loadConfig(base).systemServices).toEqual([]);
    expect(() => loadConfig({ ...base, ADMIN_SERVICES: "worker=http://w/health|optinal" })).toThrow('unknown flag "optinal"');
    expect(() => loadConfig({ ...base, STATUS_SERVICES: "worker=http://w/health|staleMin=0" })).toThrow("unknown flag");
  });

  test("refuses missing RPC, short tokens and bad admin addresses", () => {
    expect(() => loadConfig(env)).toThrow("MONAD_RPC_URLS");
    expect(() => loadConfig({ ...env, MONAD_RPC_URL: "https://a.example", ORACLE_TOKEN: "short" })).toThrow();
    expect(() => loadConfig({ ...env, MONAD_RPC_URL: "https://a.example", ADMIN_ADDRESSES: "0x123" })).toThrow();
    expect(() => loadConfig({ ...env, MONAD_RPC_URL: "https://a.example", CHAIN_ID: "1" })).toThrow("no deployment");
  });
});

describe("identifiers", () => {
  test("make registry identifiers from free text", () => {
    expect(slugify("Café & Crème: The Story!")).toBe("cafe-and-creme-the-story");
    expect(makeIdentifier("topic", "Starlink Mobile")).toBe("topic:starlink-mobile");
    expect(makeIdentifier("topic", "!!!")).toBeNull();
    expect(makeIdentifier("topic", "x".repeat(100))!.length).toBe(64);
  });

  test("match the workflow's conventions", () => {
    expect(baseOf("topic:openai.2")).toBe("topic:openai");
    expect(assetClassOf("crypto:strk")).toBe(0);
    expect(assetClassOf("unknown:x")).toBe(6);
    expect(tickerOf("crypto:strk.3")).toBe("STRK");
    expect(tickerOf("topic:strk")).toBeNull();
    expect(defaultKeywords("crypto:strk")).toEqual(["$STRK"]);
    expect(defaultKeywords("topic:world-cup")).toEqual(["world cup"]);
    expect(defaultName("topic:world-cup.2")).toBe("World Cup");
  });
});
