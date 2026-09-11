import { describe, expect, test } from "bun:test";
import { periodSec, runNumber } from "../src/schedule";

describe("schedule", () => {
  test("reads fixed-interval schedules", () => {
    expect(periodSec("0 */1 * * * *")).toBe(60);
    expect(periodSec("0 */5 * * * *")).toBe(300);
    expect(periodSec("*/30 * * * * *")).toBe(30);
    expect(() => periodSec("0 0 * * * *")).toThrow();
  });

  test("consecutive runs get consecutive numbers in the schedule's period", () => {
    const at = 1_791_522_000;
    expect(runNumber(at + 60, "0 */1 * * * *") - runNumber(at, "0 */1 * * * *")).toBe(1);
    expect(runNumber(at + 300, "0 */5 * * * *") - runNumber(at, "0 */5 * * * *")).toBe(1);
    expect(runNumber(at + 30, "*/30 * * * * *") - runNumber(at, "*/30 * * * * *")).toBe(1);
    // Without a fixed interval runs count minutes.
    expect(runNumber(at + 60, "0 0 * * * *") - runNumber(at, "0 0 * * * *")).toBe(1);
  });
});
