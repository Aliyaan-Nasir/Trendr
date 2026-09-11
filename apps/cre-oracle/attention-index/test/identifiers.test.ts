import { describe, expect, test } from "bun:test";
import {
  articleFor,
  assetClassOf,
  baseOf,
  isNormalized,
  keywordsFor,
  normalizeIdentifier,
  tickerOf,
  versioned,
} from "../src/identifiers";

describe("identifiers", () => {
  test("normalizes free text into registry identifiers", () => {
    expect(normalizeIdentifier("  Topic:World Cup  ")).toBe("topic:world-cup");
    expect(normalizeIdentifier("person:Taylor--Swift!")).toBe("person:taylor-swift");
    expect(normalizeIdentifier("!!!")).toBeNull();
    expect(normalizeIdentifier("a".repeat(80))?.length).toBe(64);
    expect(isNormalized("topic:Hantavirus")).toBe(false);
  });

  test("versions a returning trend", () => {
    expect(versioned("topic:hantavirus", 1)).toBe("topic:hantavirus");
    expect(versioned("topic:hantavirus", 2)).toBe("topic:hantavirus.2");
    expect(baseOf("topic:hantavirus.3")).toBe("topic:hantavirus");
    expect(versioned("x".repeat(63), 2)).toBeNull();
  });

  test("derives class, ticker and keywords", () => {
    expect(assetClassOf("crypto:mon")).toBe(0);
    expect(assetClassOf("person:jane")).toBe(4);
    expect(assetClassOf("e2e-123")).toBe(6);
    expect(assetClassOf("unknown:thing")).toBe(6);
    expect(tickerOf("crypto:mon.2")).toBe("MON");
    expect(tickerOf("topic:mon")).toBeNull();
    expect(keywordsFor("crypto:btc", {})).toEqual(["$BTC"]);
    expect(keywordsFor("topic:world-cup", {})).toEqual(["world cup"]);
    expect(keywordsFor("topic:world-cup.2", { "topic:world-cup": ["World Cup"] })).toEqual(["World Cup"]);
  });

  test("derives Wikipedia titles", () => {
    expect(articleFor("person:taylor-swift", ["taylor swift"], {})).toBe("Taylor_Swift");
    expect(articleFor("topic:climate-change", ["climate change"], {})).toBe("Climate_change");
    expect(articleFor("crypto:mon", ["$MON"], {})).toBeNull();
    expect(articleFor("crypto:mon", ["$MON"], { "crypto:mon": "Monad_(blockchain)" })).toBe("Monad_(blockchain)");
    expect(articleFor("topic:x", [], {})).toBeNull();
  });
});
