import { describe, expect, test } from "bun:test";
import { allocate, decide, freeListing, type LiveTrend, sampleSlots } from "../src/plan";
import type { Candidate } from "../src/sources/candidates";

const trend = (n: number, over: Partial<LiveTrend> = {}): LiveTrend => ({
  id: `0x${n.toString(16).padStart(64, "0")}`,
  index: 40_000_000n,
  updatedAt: 1_000 + n,
  status: 1,
  assetClass: 6,
  pendingExpiry: 0,
  nextExpiry: 0,
  ...over,
});
const candidate = (identifier: string, assetClass = 6): Candidate => ({
  identifier,
  assetClass,
  keywords: [],
  surfacer: "0x0000000000000000000000000000000000000000",
  priority: 1,
});
const params = { now: 2_000, heartbeatSec: 240, deviationBps: 100, minCreateIndexPoints: 5, minConfirmNetflowUsd: 100_000 };

describe("plan", () => {
  test("slots fit the HTTP budget", () => {
    expect(sampleSlots(4, 2, 12)).toBe(5);
    expect(sampleSlots(2, 2, 3)).toBe(3);
    expect(sampleSlots(15, 2, 6)).toBe(0);
    // Collector mode: no per-trend calls, so only the cap applies.
    expect(sampleSlots(2, 0, 6)).toBe(6);
    expect(sampleSlots(16, 0, 6)).toBe(0);
  });

  test("pending settlements first, then candidates, then the stalest trends", () => {
    const live = [trend(1), trend(2, { pendingExpiry: 900 }), trend(3, { updatedAt: 10 }), trend(4, { pendingExpiry: 800 })];
    const plan = allocate(live, [candidate("topic:a"), candidate("topic:b")], 4, 1);
    expect(plan.trends.map((t) => t.id)).toEqual([trend(4).id, trend(2).id, trend(3).id]);
    expect(plan.candidates.map((c) => c.identifier)).toEqual(["topic:a"]);
    // Pending trends always win slots.
    expect(allocate(live, [candidate("topic:a")], 1, 1).trends.map((t) => t.id)).toEqual([trend(4).id]);
  });

  test("free listing skips retired versions and refuses live ones", () => {
    expect(freeListing("topic:x", [0])).toBe("topic:x");
    expect(freeListing("topic:x", [3, 3, 0])).toBe("topic:x.3");
    expect(freeListing("topic:x", [3, 1, 0])).toBeNull();
    expect(freeListing("topic:x", [2])).toBeNull();
  });

  test("updates on heartbeat, deviation or pending settlement only", () => {
    const fresh = trend(1, { updatedAt: 1_950 });
    const d = decide(
      [
        { trend: fresh, m: { points: 40.2, netflowUsd: null } }, // 0.5% move, heartbeat not due
        { trend: trend(2, { updatedAt: 1_950 }), m: { points: 44, netflowUsd: null } }, // 10% move
        { trend: trend(3, { updatedAt: 1_700 }), m: { points: 40, netflowUsd: null } }, // heartbeat due
        { trend: trend(4, { updatedAt: 1_990, pendingExpiry: 1_980 }), m: { points: 40, netflowUsd: null } },
        { trend: trend(5, { updatedAt: 1_000 }), m: { points: null, netflowUsd: null } }, // never re-reported unmeasured
      ],
      [],
      params,
    );
    expect(d.updates.map((u) => u.id)).toEqual([trend(2).id, trend(3).id, trend(4).id]);
    expect(d.settlements).toEqual([{ id: trend(4).id, expiry: 1_980n }]);
  });

  test("a report carries trends past half their heartbeat; nothing due means no report", () => {
    const half = trend(6, { updatedAt: 1_870 }); // 130 s old, heartbeat 240
    const young = trend(7, { updatedAt: 1_950 });
    const due = trend(8, { updatedAt: 1_700 });
    const unchanged = { points: 40, netflowUsd: null };
    const d = decide(
      [
        { trend: half, m: unchanged },
        { trend: young, m: unchanged },
        { trend: due, m: unchanged },
      ],
      [],
      params,
    );
    expect(d.updates.map((u) => u.id)).toEqual([due.id, half.id]);
    const quiet = decide(
      [
        { trend: half, m: unchanged },
        { trend: young, m: unchanged },
      ],
      [],
      params,
    );
    expect(quiet.updates).toEqual([]);
  });

  test("candidates need attention, crypto also needs smart money", () => {
    const d = decide(
      [],
      [
        { candidate: candidate("topic:a"), identifier: "topic:a", m: { points: 12, netflowUsd: null } },
        { candidate: candidate("topic:b"), identifier: "topic:b.2", m: { points: 4.99, netflowUsd: null } },
        { candidate: candidate("crypto:x", 0), identifier: "crypto:x", m: { points: 30, netflowUsd: 50_000 } },
        { candidate: candidate("crypto:y", 0), identifier: "crypto:y", m: { points: 30, netflowUsd: 250_000 } },
        { candidate: candidate("crypto:z", 0), identifier: "crypto:z", m: { points: 30, netflowUsd: null } },
      ],
      params,
    );
    expect(d.newTrends.map((t) => [t.identifier, t.smartMoneyConfirmed])).toEqual([
      ["topic:a", false],
      ["crypto:y", true],
    ]);
    expect(d.newTrends[0]?.index).toBe(12_000_000n);
  });
});
