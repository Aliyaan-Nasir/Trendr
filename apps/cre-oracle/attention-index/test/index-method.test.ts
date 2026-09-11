import { describe, expect, test } from "bun:test";
import {
  attentionPoints,
  boostedPoints,
  MIN_INDEX_UNITS,
  normalizeCount,
  normalizeFlow,
  phasedWeight,
  seasonalFactor,
  toIndexUnits,
} from "../src/index-method";

const flat = Array(24).fill(1) as number[];

describe("index method", () => {
  test("seasonal factors average to one", () => {
    const profile = [...Array(12).fill(0.5), ...Array(12).fill(1.5)] as number[];
    expect(seasonalFactor(profile, 0)).toBeCloseTo(0.5);
    expect(seasonalFactor(profile, 23)).toBeCloseTo(1.5);
    expect(seasonalFactor(flat, 7)).toBe(1);
  });

  test("counts clip, deseasonalize and log-scale into [0, 1]", () => {
    expect(normalizeCount(0, 100, 50, 1)).toBe(0);
    expect(normalizeCount(50, 100, 50, 1)).toBeCloseTo(1);
    expect(normalizeCount(10_000, 100, 50, 1)).toBe(1);
    expect(normalizeCount(Number.NaN, 100, 50, 1)).toBe(0);
    // A busy hour (factor 2) counts for less than the same raw count at a quiet hour.
    expect(normalizeCount(20, 100, 50, 2)).toBeLessThan(normalizeCount(20, 100, 50, 0.5));
    // Monotonic in the raw count.
    expect(normalizeCount(10, 100, 50, 1)).toBeLessThan(normalizeCount(11, 100, 50, 1));
  });

  test("flows map around one half", () => {
    expect(normalizeFlow(0, 1000)).toBe(0.5);
    expect(normalizeFlow(1e12, 1000)).toBeCloseTo(1);
    expect(normalizeFlow(-1e12, 1000)).toBeCloseTo(0);
  });

  test("points renormalize over the components that answered", () => {
    expect(attentionPoints([])).toBeNull();
    expect(attentionPoints([{ value: 0.5, weight: 0.6 }])).toBeCloseTo(50);
    expect(attentionPoints([{ value: 1, weight: 3 }, { value: 0, weight: 1 }])).toBeCloseTo(75);
    expect(attentionPoints([{ value: Number.NaN, weight: 1 }])).toBeNull();
  });

  test("a boost enters only when it raises the index, continuously", () => {
    const base = [{ value: 0.5, weight: 1 }];
    expect(boostedPoints([], [{ value: 1, weight: 1 }])).toBeNull();
    expect(boostedPoints(base, [{ value: 0.2, weight: 1 }])).toBeCloseTo(50);
    expect(boostedPoints(base, [{ value: 0.9, weight: 1 }])).toBeCloseTo(70);
    // At the base value entering changes nothing, so there is no step either side of it.
    expect(boostedPoints(base, [{ value: 0.5, weight: 1 }])).toBeCloseTo(50);
    expect(boostedPoints(base, [{ value: 0.50001, weight: 1 }])!).toBeCloseTo(50, 2);
  });

  test("a phase-in ramps a weight from zero to full", () => {
    const ramp = { fromSec: 1_000, durationSec: 100 };
    expect(phasedWeight(0.4, undefined, 0)).toBe(0.4);
    expect(phasedWeight(0.4, ramp, 999)).toBe(0);
    expect(phasedWeight(0.4, ramp, 1_050)).toBeCloseTo(0.2);
    expect(phasedWeight(0.4, ramp, 5_000)).toBe(0.4);
  });

  test("units round to hundredths of a point inside registry bounds", () => {
    expect(toIndexUnits(42.123)).toBe(42_120_000n);
    expect(toIndexUnits(0)).toBe(MIN_INDEX_UNITS);
    expect(toIndexUnits(150)).toBe(100_000_000n);
  });
});
