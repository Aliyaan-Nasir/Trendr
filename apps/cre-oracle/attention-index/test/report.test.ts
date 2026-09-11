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
});

describe("contracts fixture", () => {
  test("matches the encoder (regenerate with bun scripts/report-fixture.ts)", async () => {
    const { FIXTURE_PATH, fixtureReport } = await import("../scripts/report-fixture");
    expect((await Bun.file(FIXTURE_PATH).text()).trim()).toBe(fixtureReport());
  });
});
