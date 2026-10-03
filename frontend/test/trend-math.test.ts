import { describe, expect, test } from "bun:test";
import { OUTCOME_MARKET, quoteBuy, quoteSell } from "@trendr/contracts";
import { acceptableIndex, formatAmount, fundingPerHourPct, fundingRate, kuruQuoteBuy, kuruQuoteSell, parseAmount, perpPreview } from "../src/features/trend/math";

const UNIT = 10n ** 6n;

describe("perp preview", () => {
  test("matches AttentionPerp's fee, size and PnL per point", () => {
    // 100 AUSD at 2x on an index of 50: net = 100 / (1 + 2 x 0.001), notional = 2 x net.
    const p = perpPreview({ margin: 100n * UNIT, leverage: 2, index: 50, isLong: true, longQty: 0n, shortQty: 0n, unit: UNIT })!;
    expect(p.net).toBe(99_800_399n);
    expect(p.fee).toBe(199_601n);
    expect(p.notional).toBe(199_600_798n);
    // A point is 1/50 of notional.
    expect(p.perPoint).toBeCloseTo(199.600798 / 50, 5);
    expect(p.closeFee).toBe(199_600n);
  });

  test("liquidation indexes solve equity = 10% of notional at that index", () => {
    const long = perpPreview({ margin: 100n * UNIT, leverage: 3, index: 60, isLong: true, longQty: 0n, shortQty: 0n, unit: UNIT })!;
    const net = Number(long.net) / 1e6;
    const i = long.liquidationIndex!;
    expect(net + long.perPoint * (i - 60)).toBeCloseTo(0.1 * long.perPoint * i, 6);
    const short = perpPreview({ margin: 100n * UNIT, leverage: 3, index: 60, isLong: false, longQty: 0n, shortQty: 0n, unit: UNIT })!;
    const j = short.liquidationIndex!;
    expect(Number(short.net) / 1e6 + short.perPoint * (60 - j)).toBeCloseTo(0.1 * short.perPoint * j, 6);
    // At 1x a long cannot be liquidated by the index alone; a 1x short only above 100.
    expect(perpPreview({ margin: 100n * UNIT, leverage: 1, index: 60, isLong: true, longQty: 0n, shortQty: 0n, unit: UNIT })!.liquidationIndex).toBeNull();
    expect(perpPreview({ margin: 100n * UNIT, leverage: 1, index: 60, isLong: false, longQty: 0n, shortQty: 0n, unit: UNIT })!.liquidationIndex).toBeNull();
  });

  test("rejects what the contract rejects", () => {
    expect(perpPreview({ margin: 0n, leverage: 2, index: 50, isLong: true, longQty: 0n, shortQty: 0n, unit: UNIT })).toBeNull();
    expect(perpPreview({ margin: UNIT, leverage: 3.5, index: 50, isLong: true, longQty: 0n, shortQty: 0n, unit: UNIT })).toBeNull();
  });

  test("acceptable index moves against the trader", () => {
    expect(acceptableIndex(50, true, 100)).toBe(50_500_000n);
    expect(acceptableIndex(50, false, 100)).toBe(49_500_000n);
  });
});

describe("funding", () => {
  test("the crowded side pays in proportion to the skew, capped", () => {
    expect(fundingRate(0n, 0n)).toBe(0n);
    expect(fundingRate(3n, 1n)).toBe(10n ** 11n);
    expect(fundingRate(1n, 0n)).toBe(2n * 10n ** 11n);
    expect(fundingRate(1n, 3n)).toBe(-(10n ** 11n));
    // Half skew: 1e-7 per block, 9,000 blocks an hour.
    expect(fundingPerHourPct(3n, 1n, true)).toBeCloseTo(0.09, 9);
    // Shorts share what three times as many longs pay.
    expect(fundingPerHourPct(3n, 1n, false)).toBeCloseTo(-0.27, 9);
    expect(fundingPerHourPct(1n, 0n, false)).toBe(0);
  });
});

describe("kuru quotes", () => {
  const outcome = { pricePrecision: BigInt(OUTCOME_MARKET.pricePrecision), sizePrecision: BigInt(OUTCOME_MARKET.sizePrecision), baseDecimals: 6, quoteDecimals: 6, takerFeeBps: BigInt(OUTCOME_MARKET.takerFeeBps) };
  const book = { bids: [{ price: 5_200, size: 1_000n }, { price: 5_100, size: 5_000n }], asks: [{ price: 5_400, size: 1_000n }, { price: 5_600, size: 5_000n }] };

  test("agree with the outcome-market quotes for outcome parameters", () => {
    for (const amount of [1n, 3_000_000n, 25_000_000n, 1_000_000_000n]) {
      for (const [ours, theirs] of [[kuruQuoteBuy(book, outcome, amount), quoteBuy(book, amount)], [kuruQuoteSell(book, outcome, amount), quoteSell(book, amount)]] as const) {
        expect({ out: ours.out, filled: ours.filled, complete: ours.complete }).toEqual({ out: theirs.out, filled: theirs.filled, complete: theirs.complete });
        expect(ours.averagePrice).toBeCloseTo(theirs.averagePrice, 12);
      }
    }
  });

  test("handle an 18-decimal coin priced with a fine precision", () => {
    // 0.00012 AUSD per coin at pricePrecision 1e9; one size unit is one coin.
    const coin = { pricePrecision: 10n ** 9n, sizePrecision: 1n, baseDecimals: 18, quoteDecimals: 6, takerFeeBps: 30n };
    const asks = { bids: [], asks: [{ price: 120_000, size: 1_000_000n }] };
    const q = kuruQuoteBuy(asks, coin, 12_000_000n); // 12 AUSD
    expect(q.filled).toBe(12_000_000n);
    expect(q.out).toBe((100_000n * 10n ** 18n * 9_970n) / 10_000n);
    expect(q.averagePrice).toBeCloseTo(12 / (100_000 * 0.997), 12);
  });
});

describe("amounts", () => {
  test("parse and format decimal input", () => {
    expect(parseAmount("12.5", 6)).toBe(12_500_000n);
    expect(parseAmount("0.0000001", 6)).toBeNull();
    expect(parseAmount("1,000", 6)).toBe(1_000_000_000n);
    expect(parseAmount("abc", 6)).toBeNull();
    expect(parseAmount("", 6)).toBeNull();
    expect(formatAmount(12_500_000n, 6)).toBe("12.5");
    expect(formatAmount(10n ** 18n + 5n, 18, 4)).toBe("1");
  });
});
