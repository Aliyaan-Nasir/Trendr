import { describe, expect, test } from "bun:test";
import { describeRevert } from "../src/lib/account/AccountProvider";

describe("session refusals in plain words", () => {
  test("the gross daily allowance names what the trade needs and what is left", () => {
    const text = describeRevert("SpendLimitExceeded(35000000, 30000000)");
    expect(text).toContain("35 AUSD");
    expect(text).toContain("30 AUSD");
    expect(text).toContain("midnight UTC");
  });

  test("Perpl orders outside the band, on a stale mark, or resting", () => {
    expect(describeRevert("GuardRejected(0, PriceOutsideBand(0, 871896, 830377))")).toContain("more than 2% from Perpl's mark");
    expect(describeRevert("GuardRejected(0, StaleMark(16, 1791657885))")).toContain("has not updated");
    expect(describeRevert("GuardRejected(0, MustBeImmediate(0))")).toContain("immediate");
  });

  test("Perpl openings above the session's leverage cap point to the passkey", () => {
    expect(describeRevert("GuardRejected(0, LeverageNotAllowed(0, 2000, 1000))")).toBe(
      "A trading session opens Perpl positions at up to 10x. Lower the leverage, or confirm a higher one with your passkey.",
    );
  });

  test("anything else as the chain said it", () => {
    expect(describeRevert("CallNotAllowed(1)")).toBe("The transaction would fail: CallNotAllowed(1)");
  });
});

describe("Autopilot failures in plain words", () => {
  test("the gross daily cap and the order guard", async () => {
    const { humanReason } = await import("../src/features/autopilot/shared/rule-text");
    expect(humanReason("simulation_failed: SpendLimitExceeded(40000000, 10000000)")).toMatchObject({ needsGrant: true, text: expect.stringContaining("daily AUSD cap") });
    expect(humanReason("GuardRejected(0, PriceOutsideBand(0, 871280, 829791))").text).toContain("more than 2% from its mark");
    expect(humanReason("GuardRejected(0, StaleMark(16, 1))").needsGrant).toBe(false);
    expect(humanReason("relayer refused: GuardRejected(0, LeverageNotAllowed(0, 2000, 1000))")).toEqual({
      text: "Autopilot's key opens Perpl positions at up to 10x, and this order asked for 20x. Lower the leverage, then resume.",
      needsFunds: false,
      needsGrant: false,
    });
  });
});
