import { describe, expect, test } from "bun:test";
import { decodeAbiParameters } from "viem";
import type { Decisions } from "../src/plan";
import { encodeReport, gasLimit, REPORT_ABI } from "../src/report";

const decisions: Decisions = {
  newTrends: [
    {
      identifier: "topic:world-cup",
      assetClass: 6,
      index: 12_340_000n,
      surfacer: "0x00000000000000000000000000000000000000a1",
      smartMoneyConfirmed: false,
    },
  ],
  updates: [{ id: `0x${"11".repeat(32)}`, index: 40_000_000n }],
  settlements: [{ id: `0x${"11".repeat(32)}`, expiry: 1_791_600_000n }],
};

describe("report", () => {
  test("round-trips through the TrendRegistry.Report ABI", () => {
    const hex = encodeReport(1_791_522_400n, 1_791_522_400n, decisions);
    const [r] = decodeAbiParameters(REPORT_ABI, hex);
    expect(r.runId).toBe(1_791_522_400n);
    expect(r.newTrends[0]?.identifier).toBe("topic:world-cup");
    expect(r.newTrends[0]?.surfacer.toLowerCase()).toBe("0x00000000000000000000000000000000000000a1");
    expect(r.updates[0]?.index).toBe(40_000_000n);
    expect(r.settlements[0]?.expiry).toBe(1_791_600_000n);
  });

  test("gas scales with items and is capped", () => {
    const g = { base: 100, perNewTrend: 10, perUpdate: 5, perSettlement: 3, max: 1_000 };
    expect(gasLimit(decisions, g)).toBe(118);
    expect(gasLimit(decisions, { ...g, max: 110 })).toBe(110);
  });

  // Each update appends a checkpoint, two to a storage slot, so every other update pays for a fresh
  // slot. On 2026-10-14 a 13-update report sized at 52k an update ran out of gas inside onReport
  // (the forwarder swallowed it, so every later report failed the same way until the trends retired):
  // the worst case measured was about 55k an update, the forwarder's overhead included.
  test("the configs fit a report updating every live trend at the worst measured cost", async () => {
    const worstPerUpdate = 55_000;
    for (const name of ["testnet", "mainnet"]) {
      const cfg = (await Bun.file(`${import.meta.dir}/../config.${name}.json`).json()) as { discovery: { maxLiveTrends: number }; gas: Parameters<typeof gasLimit>[1] };
      const full: Decisions = { newTrends: [], settlements: [], updates: Array.from({ length: cfg.discovery.maxLiveTrends }, () => decisions.updates[0]!) };
      expect(gasLimit(full, cfg.gas)).toBeGreaterThanOrEqual(Math.ceil(cfg.discovery.maxLiveTrends * worstPerUpdate * 1.2));
    }
  });
});

describe("contracts fixture", () => {
  test("matches the encoder (regenerate with bun scripts/report-fixture.ts)", async () => {
    const { FIXTURE_PATH, fixtureReport } = await import("../scripts/report-fixture");
    expect((await Bun.file(FIXTURE_PATH).text()).trim()).toBe(fixtureReport());
  });
});
