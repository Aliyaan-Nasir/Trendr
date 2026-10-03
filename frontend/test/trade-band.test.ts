import { describe, expect, test } from "bun:test";
import type { Quote } from "@trendr/contracts";
import { needsPasskey, passkeyReason } from "../src/features/trend/band";

const band = { fair: 0.52, low: 0.42, high: 0.62 };
const at = (averagePrice: number): Quote => ({ out: 1_000_000n, filled: 1_000_000n, complete: true, averagePrice });

describe("session or passkey for an UP or DOWN trade", () => {
  test("a session trades inside TrendrSpot's band", () => {
    expect(needsPasskey(at(0.55), band, true)).toBe(false);
    expect(needsPasskey(at(0.45), band, false)).toBe(false);
  });

  test("outside the band, or with no band, the passkey confirms", () => {
    expect(needsPasskey(at(0.7), band, true)).toBe(true);
    expect(needsPasskey(at(0.3), band, false)).toBe(true);
    // TrendrSpot gives no band while the oracle is stale or the series closes.
    expect(needsPasskey(at(0.55), null, true)).toBe(true);
  });

  test("while the band loads, and before there is a quote, the session is tried", () => {
    expect(needsPasskey(at(0.9), undefined, true)).toBe(false);
    expect(needsPasskey(null, band, true)).toBe(false);
  });

  test("says why", () => {
    expect(passkeyReason(band)).toBe("Session trades stay within 10.0c of the 52.0c the attention index implies. This price is further out, so your passkey confirms it.");
    // At the edges the band is cut at 0 or 1 AUSD; the reach is still the full deviation.
    expect(passkeyReason({ fair: 0.98, low: 0.88, high: 1 })).toContain("within 10.0c of the 98.0c");
    expect(passkeyReason(null)).toContain("paused until the attention index updates");
  });
});
