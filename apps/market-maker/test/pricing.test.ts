import { describe, expect, test } from "bun:test";
import { DEFAULT_PRIOR, estimateDynamics, fairUp, MAX_PROBABILITY, MIN_PROBABILITY, normCdf } from "../src/pricing";

describe("normCdf", () => {
  test("matches known values", () => {
    expect(normCdf(0)).toBeCloseTo(0.5, 7);
    expect(normCdf(1)).toBeCloseTo(0.8413447, 6);
    expect(normCdf(-1.96)).toBeCloseTo(0.0249979, 6);
    expect(normCdf(3)).toBeCloseTo(0.9986501, 6);
  });
});

describe("estimateDynamics", () => {
  test("returns the prior without history", () => {
    const d = estimateDynamics([]);
    expect(d.variancePerSec).toBeCloseTo(DEFAULT_PRIOR.variancePerSec, 12);
    expect(d.changesPerSec).toBeCloseTo(DEFAULT_PRIOR.changesPerSec, 12);
  });

  test("moves towards the data as history accumulates", () => {
    // A flat index for two days: almost no variance, no changes.
    const flat = Array.from({ length: 200 }, (_, i) => ({ at: i * 864, index: 40 }));
    const d = estimateDynamics(flat);
    expect(d.changesPerSec).toBeLessThan(DEFAULT_PRIOR.changesPerSec / 5);
    expect(d.variancePerSec).toBeLessThan(DEFAULT_PRIOR.variancePerSec / 5);

    // A jumpy index: every observation moves 10%.
    const jumpy = Array.from({ length: 200 }, (_, i) => ({ at: i * 60, index: i % 2 ? 44 : 40 }));
    const j = estimateDynamics(jumpy);
    expect(j.changesPerSec).toBeGreaterThan(DEFAULT_PRIOR.changesPerSec);
    expect(j.variancePerSec).toBeGreaterThan(DEFAULT_PRIOR.variancePerSec);
  });
});

describe("fairUp", () => {
  const dynamics = { variancePerSec: 0.36 / 86_400, changesPerSec: 1 / 600 };
  test("is a coin flip at the opening level far from expiry, and DOWN-leaning when the index is sticky", () => {
    expect(fairUp({ index: 40, opening: 40, tau: 86_400, dynamics })).toBeCloseTo(0.5, 2);
    // If the index rarely changes, an unchanged index most likely settles as a tie: DOWN.
    const sticky = { variancePerSec: dynamics.variancePerSec, changesPerSec: 1 / 86_400 };
    expect(fairUp({ index: 40, opening: 40, tau: 3600, dynamics: sticky })).toBeLessThan(0.1);
  });

  test("rises with the index and sharpens as expiry nears", () => {
    const far = fairUp({ index: 44, opening: 40, tau: 86_400, dynamics });
    const near = fairUp({ index: 44, opening: 40, tau: 600, dynamics });
    expect(far).toBeGreaterThan(0.5);
    expect(near).toBeGreaterThan(far);
    // The mirror image in log space is exactly the complement.
    expect(fairUp({ index: 1600 / 44, opening: 40, tau: 86_400, dynamics })).toBeCloseTo(1 - far, 6);
  });

  test("is bounded away from certainty, also at and after expiry", () => {
    expect(fairUp({ index: 80, opening: 40, tau: 60, dynamics })).toBe(MAX_PROBABILITY);
    expect(fairUp({ index: 40, opening: 40, tau: 0, dynamics })).toBe(MIN_PROBABILITY);
    expect(fairUp({ index: 41, opening: 40, tau: -5, dynamics })).toBe(MAX_PROBABILITY);
  });
});
