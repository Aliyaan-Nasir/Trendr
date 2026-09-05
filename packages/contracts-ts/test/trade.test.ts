import { describe, expect, test } from "bun:test";
import { decodeFunctionData, encodePacked, type Hex, toFunctionSelector } from "viem";
import {
  decodeL2,
  type Deployment,
  insideBand,
  minimumOut,
  type OrderBook,
  quoteBuy,
  quoteSell,
  sessionMarker,
  spotBuyCalls,
  spotBuyWithLimitCalls,
  spotSellCalls,
  spotSellWithLimitCalls,
  toPriceBand,
  tradingPermissions,
  trendrSpotAbi,
} from "../src";

const book: OrderBook = {
  bids: [
    { price: 4700, size: 2000n },
    { price: 4600, size: 2000n },
  ],
  asks: [
    { price: 5300, size: 2000n },
    { price: 5400, size: 2000n },
  ],
};

describe("decodeL2", () => {
  test("reads bids, the separator and asks", () => {
    const words = [123n, 4700n, 2000n, 4600n, 2000n, 0n, 5300n, 2000n, 5400n, 2000n];
    expect(decodeL2(encodePacked(words.map(() => "uint256"), words) as Hex)).toEqual(book);
  });
});

describe("quoteBuy", () => {
  test("fills the best ask first, then the next, less the taker fee", () => {
    // 20 tokens at 0.53 cost 10.6 AUSD; 4.4 AUSD more buy 8.14 tokens at 0.54.
    const q = quoteBuy(book, 15_000_000n);
    expect(q.out).toBe(((20_000_000n + 8_140_000n) * 9990n) / 10_000n);
    expect(q.complete).toBe(true);
    // 10.6 AUSD for the first level and 814 size units at 5400 for the second.
    expect(q.filled).toBe(10_600_000n + 814n * 5400n);
  });

  test("reports a book too thin for the order", () => {
    const q = quoteBuy(book, 100_000_000n);
    expect(q.complete).toBe(false);
    expect(q.out).toBe((40_000_000n * 9990n) / 10_000n);
  });
});

describe("quoteSell", () => {
  test("sells into the bids in whole size units, less the taker fee", () => {
    const q = quoteSell(book, 25_005_000n);
    // 20 tokens at 0.47 and 5 at 0.46; the 0.005 token of dust is not sold.
    expect(q.out).toBe(((9_400_000n + 2_300_000n) * 9990n) / 10_000n);
    expect(q.filled).toBe(25_000_000n);
    expect(q.complete).toBe(true);
    expect(quoteSell(book, 50_000_000n).complete).toBe(false);
  });

  test("minimumOut takes the slippage off the quote", () => {
    expect(minimumOut({ out: 1_000_000n, filled: 0n, complete: true, averagePrice: 0 }, 50)).toBe(995_000n);
  });
});

describe("spot calls", () => {
  const d = {
    ausd: "0x00000000000000000000000000000000000000a0",
    trendrSpot: "0x00000000000000000000000000000000000000b0",
  } as unknown as Deployment;
  test("approve exactly the input to TrendrSpot, then trade to the account", () => {
    const calls = spotBuyCalls(d, "0x00000000000000000000000000000000000000c0", 5_000_000n, 9_000_000n, "0x00000000000000000000000000000000000000d0");
    expect(calls.map((c) => c.target)).toEqual([d.ausd, d.trendrSpot]);
    expect(calls[0]!.data.slice(0, 10)).toBe("0x095ea7b3");
  });

  test("sessions may trade through TrendrSpot's banded buy and sell with the recipient pinned", () => {
    const full = { ...d, outcomeMarkets: d.ausd, attentionPerp: d.ausd, bondingCurve: d.ausd } as Deployment;
    const spot = tradingPermissions(full).filter((p) => p.target === d.trendrSpot);
    expect(spot.map((p) => p.recipientArg)).toEqual([4, 4, 0]);
    const selectors = spot.filter((p) => p.selector !== "0x00000000").map((p) => p.selector);
    expect(selectors).toEqual([toFunctionSelector("buy(address,uint256,uint256,address)"), toFunctionSelector("sell(address,uint256,uint256,address)")]);
    expect(spot).toContainEqual(sessionMarker(full));
  });

  test("sessions never trade trend coins on the curve", () => {
    const full = { ...d, outcomeMarkets: d.ausd, attentionPerp: d.ausd, bondingCurve: "0x00000000000000000000000000000000000000e0" } as Deployment;
    expect(tradingPermissions(full).filter((p) => p.target === full.bondingCurve)).toEqual([]);
  });

  test("session calls use the banded entry points, passkey calls the limit ones", () => {
    const token = "0x00000000000000000000000000000000000000c0";
    const to = "0x00000000000000000000000000000000000000d0";
    const fn = (calls: { data: `0x${string}` }[]) => decodeFunctionData({ abi: trendrSpotAbi, data: calls[1]!.data }).functionName;
    expect(fn(spotBuyCalls(d, token, 1n, 1n, to))).toBe("buy");
    expect(fn(spotSellCalls(d, token, 1n, 1n, to))).toBe("sell");
    expect(fn(spotBuyWithLimitCalls(d, token, 1n, 1n, to))).toBe("buyWithLimit");
    expect(fn(spotSellWithLimitCalls(d, token, 1n, 1n, to))).toBe("sellWithLimit");
    expect(spotSellWithLimitCalls(d, token, 7n, 1n, to)[0]!.target).toBe(token);
  });
});

describe("price band", () => {
  const band = toPriceBand([520_000_000_000_000_000n, 420_000_000_000_000_000n, 620_000_000_000_000_000n]);
  const at = (averagePrice: number) => ({ out: 1n, filled: 1n, complete: true, averagePrice });
  test("reads TrendrSpot's priceBand in AUSD per token", () => {
    expect(band).toEqual({ fair: 0.52, low: 0.42, high: 0.62 });
  });
  test("a session buys up to the top and sells down to the floor", () => {
    expect(insideBand(at(0.6), band, true)).toBe(true);
    expect(insideBand(at(0.63), band, true)).toBe(false);
    expect(insideBand(at(0.43), band, false)).toBe(true);
    expect(insideBand(at(0.41), band, false)).toBe(false);
    expect(insideBand(at(0), band, false)).toBe(false);
  });
});

