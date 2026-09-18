import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { rankQueue, READING_MAX_AGE_SEC, usable } from "../src/queue";
import type { Candidate, Reading, SourceName } from "../src/store";

const NOW = 1_791_720_000;
const candidate = (identifier: string, assetClass = 6, ticker: string | null = null): Candidate => ({
  id: 1,
  identifier,
  displayName: identifier,
  assetClass,
  keywords: [],
  article: null,
  ticker,
  summary: null,
  source: "elfa_trending",
  sourceRef: {},
  surfacer: "0x0000000000000000000000000000000000000000",
  status: "approved",
  confidence: 0.9,
  ai: {},
  decidedBy: "radar",
  createdAt: new Date(0),
  updatedAt: new Date(0),
});
const at = (value: number, ageSec: number): Reading => ({ value, windowSec: 86_400, observedAt: NOW - ageSec });
const opts = { nowSec: NOW, confirmNetflowUsd: 100_000, tradable: new Set(["BTC"]) };

describe("oracle queue", () => {
  test("offers only candidates with a reading the workflow still accepts", () => {
    const latest = new Map<string, Partial<Record<SourceName, Reading>>>([
      // Only an Elfa count from 13 hours ago: the workflow would measure nothing.
      ["equity:stale", { elfa: at(70, 46_800) }],
      // A day-old Wikipedia count is still within its two days.
      ["topic:wiki", { elfa: at(5, 46_800), wikipedia: at(90_000, 86_400) }],
      ["topic:loud", { elfa: at(900, 600) }],
      // Fresh, but zero everywhere: an index of 0 never lists.
      ["topic:silent", { elfa: at(0, 600), wikipedia: at(0, 600) }],
      // Smart money confirmed, but only by an expired reading.
      ["crypto:old-flow", { elfa: at(800, 600), nansen: at(500_000, 50_000) }],
      ["crypto:eth", { elfa: at(3_000, 600), nansen: at(1_200_000, 600) }],
      ["crypto:btc", { elfa: at(10, 600), nansen: at(150_000, 600) }],
      ["crypto:near", { elfa: at(5_000, 600), nansen: at(20_000, 600) }],
    ]);
    const approved = [...latest.keys(), "topic:unmeasured"].map((id) => candidate(id, id.startsWith("crypto:") ? 0 : 6, id.startsWith("crypto:") ? id.slice(7).toUpperCase() : null));
    // Perpl's listed assets first, then the most-mentioned.
    expect(rankQueue(approved, latest, opts).map((c) => c.identifier)).toEqual(["crypto:btc", "crypto:eth", "topic:loud", "topic:wiki"]);
  });

  test("Bluesky measures a candidate, and ranks it while Elfa is silent; Hacker News alone does not", () => {
    const latest = new Map<string, Partial<Record<SourceName, Reading>>>([
      ["topic:bsky-small", { bluesky: at(20, 600) }],
      ["topic:bsky-big", { bluesky: at(400, 600) }],
      // 3,000 X mentions rank between 400 and 20 Bluesky posts (a tenth of X's volume).
      ["topic:x", { elfa: at(3_000, 600) }],
      ["topic:hn-only", { hn: at(80, 600) }],
    ]);
    const approved = [...latest.keys()].map((id) => candidate(id));
    expect(rankQueue(approved, latest, opts).map((c) => c.identifier)).toEqual(["topic:bsky-big", "topic:x", "topic:bsky-small"]);
  });

  test("a reading is usable up to its source's age limit, inclusive", () => {
    expect(usable(at(5, READING_MAX_AGE_SEC.gdelt), "gdelt", NOW)).toBe(5);
    expect(usable(at(5, READING_MAX_AGE_SEC.gdelt + 1), "gdelt", NOW)).toBeNull();
    expect(usable(undefined, "elfa", NOW)).toBeNull();
  });

  test("the age limits are the workflow's", () => {
    for (const target of ["testnet", "mainnet"]) {
      const file = join(import.meta.dir, "..", "..", "apps", "cre-oracle", "attention-index", `config.${target}.json`);
      const sources = (JSON.parse(readFileSync(file, "utf8")) as { sources: Record<string, { maxAgeSec?: number }> }).sources;
      for (const [source, maxAge] of Object.entries(READING_MAX_AGE_SEC)) expect([target, source, sources[source]?.maxAgeSec]).toEqual([target, source, maxAge]);
    }
  });
});
