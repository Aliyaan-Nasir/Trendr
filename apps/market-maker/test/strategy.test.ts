import { describe, expect, test } from "bun:test";
import type { Book } from "../src/book";
import { clampToBook, findArbitrage, ladders, needsRequote, pickSeries, type QuoteParams, requoteUrgency } from "../src/strategy";

const q: QuoteParams = { halfSpread: 0.02, levelStep: 0.01, levels: 2, levelTokens: 25, maxSkew: 0.03, inventoryLimit: 100 };
const flat = { up: 100, down: 100, ausd: 1000 };

describe("ladders", () => {
  test("quotes both sides around fair value on 0.001 ticks", () => {
    const { up, down } = ladders(0.6, flat, q);
    expect(up.bids.map((l) => l.price)).toEqual([5800, 5700]);
    expect(up.asks.map((l) => l.price)).toEqual([6200, 6300]);
    expect(down.bids.map((l) => l.price)).toEqual([3800, 3700]);
    expect(down.asks.map((l) => l.price)).toEqual([4200, 4300]);
    expect(up.bids[0]!.size).toBe(2500n);
  });

  test("never offers a complete set below 1 or bids above 1", () => {
    for (const p of [0.02, 0.137, 0.5, 0.731, 0.98]) {
      const { up, down } = ladders(p, flat, q);
      if (up.asks[0] && down.asks[0]) expect(up.asks[0].price + down.asks[0].price).toBeGreaterThan(10_000);
      if (up.bids[0] && down.bids[0]) expect(up.bids[0].price + down.bids[0].price).toBeLessThan(10_000);
    }
  });

  test("skews against inventory and stops buying more of a side at the limit", () => {
    const longUp = ladders(0.5, { up: 200, down: 100, ausd: 1000 }, q);
    expect(longUp.up.asks[0]!.price).toBeLessThan(ladders(0.5, flat, q).up.asks[0]!.price);
    expect(longUp.up.bids).toEqual([]);
    expect(longUp.down.bids.length).toBe(2);
  });

  test("asks only what it holds and bids only what it can pay for", () => {
    const { up } = ladders(0.5, { up: 30, down: 30, ausd: 20 }, q);
    expect(up.asks.map((l) => l.size)).toEqual([2500n, 500n]);
    // 10 AUSD for UP bids: one level of 25 at 0.48 costs 12, which does not fit.
    expect(up.bids).toEqual([]);
  });
});

describe("needsRequote", () => {
  const want = { bids: [{ price: 5800, size: 2500n }], asks: [{ price: 6200, size: 2500n }] };
  test("keeps orders that are close enough", () => {
    expect(needsRequote({ bids: [{ price: 5790, size: 2500n }], asks: [{ price: 6210, size: 1300n }] }, want, 3)).toBe(false);
  });
  test("re-quotes when a price drifted, a level filled or the shape changed", () => {
    expect(needsRequote({ bids: [{ price: 5770, size: 2500n }], asks: want.asks }, want, 3)).toBe(true);
    expect(needsRequote({ bids: want.bids, asks: [{ price: 6200, size: 1000n }] }, want, 3)).toBe(true);
    expect(needsRequote({ bids: [], asks: want.asks }, want, 3)).toBe(true);
  });
});

describe("findArbitrage", () => {
  const empty: Book = { bids: [], asks: [] };
  test("buys both sides when their asks sum well below 1", () => {
    const up: Book = { bids: [], asks: [{ price: 4000, size: 1000n }, { price: 4500, size: 5000n }] };
    const down: Book = { bids: [], asks: [{ price: 5000, size: 3000n }] };
    const arb = findArbitrage(up, down, 0.01, 1000);
    // 10 tokens at 0.40 + 0.50; at 0.45 + 0.50 the pair costs 0.95 < 0.999 - 0.01, so 20 more.
    expect(arb).toMatchObject({ kind: "buyBoth", tokens: 30 });
    expect(arb!.edge).toBeGreaterThan(0);
  });

  test("sells minted pairs into bids that sum above 1", () => {
    const up: Book = { asks: [], bids: [{ price: 6000, size: 1000n }] };
    const down: Book = { asks: [], bids: [{ price: 4600, size: 400n }] };
    expect(findArbitrage(up, down, 0.01, 1000)).toMatchObject({ kind: "sellBoth", tokens: 4 });
  });

  test("ignores a market within fees and respects the size cap", () => {
    const up: Book = { bids: [], asks: [{ price: 4990, size: 10_000n }] };
    const down: Book = { bids: [], asks: [{ price: 4990, size: 10_000n }] };
    expect(findArbitrage(up, down, 0.005, 1000)).toBeNull();
    const cheap: Book = { bids: [], asks: [{ price: 3000, size: 100_000n }] };
    expect(findArbitrage(cheap, cheap, 0.01, 40)).toMatchObject({ tokens: 40 });
    expect(findArbitrage(empty, empty, 0.01, 40)).toBeNull();
  });
});

describe("requoteUrgency", () => {
  const want = { bids: [{ price: 5800, size: 2500n }], asks: [{ price: 6200, size: 1300n }] };
  test("drift waits, fills and large moves do not", () => {
    expect(requoteUrgency(want, want, 20)).toBe("none");
    // 2 cents off at a 2 cent threshold: drift.
    expect(requoteUrgency({ bids: [{ price: 5600, size: 2500n }], asks: want.asks }, want, 20)).toBe("drift");
    // 4 cents off: urgent, the quote is mispriced.
    expect(requoteUrgency({ bids: [{ price: 5400, size: 2500n }], asks: want.asks }, want, 20)).toBe("urgent");
    // A level filled more than half, or one missing: urgent.
    expect(requoteUrgency({ bids: [{ price: 5800, size: 1000n }], asks: want.asks }, want, 20)).toBe("urgent");
    expect(requoteUrgency({ bids: [], asks: want.asks }, want, 20)).toBe("urgent");
  });
});

describe("pickSeries", () => {
  test("24-hour windows first, then the hottest trends, capped", () => {
    const s = [
      { id: "a", window: 604_800, trendId: "0x1" },
      { id: "b", window: 86_400, trendId: "0x2" },
      { id: "c", window: 86_400, trendId: "0x1" },
      { id: "d", window: 86_400, trendId: "0x3" },
    ];
    const index = new Map([["0x1", 80n], ["0x2", 30n], ["0x3", 50n]]);
    expect(pickSeries(s, index, 3).map((x) => x.id)).toEqual(["c", "d", "b"]);
    expect(pickSeries(s, index, 10).map((x) => x.id)).toEqual(["c", "d", "b", "a"]);
  });
});

describe("clampToBook", () => {
  test("drops levels that would cross other traders' best prices", () => {
    const want = { bids: [{ price: 4200, size: 2000n }, { price: 4100, size: 2000n }], asks: [{ price: 4800, size: 2000n }, { price: 4900, size: 2000n }] };
    // Someone asks 0.4150: our 0.4200 bid would cross it, our 0.4100 bid would not.
    const clamped = clampToBook(want, { bids: [{ price: 4850, size: 100n }], asks: [{ price: 4150, size: 100n }] });
    expect(clamped.bids.map((l) => l.price)).toEqual([4100]);
    expect(clamped.asks.map((l) => l.price)).toEqual([4900]);
    expect(clampToBook(want, { bids: [], asks: [] })).toEqual(want);
  });
});
