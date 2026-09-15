import { describe, expect, test } from "bun:test";
import { encodePacked, type Hex } from "viem";
import { decodeL2, withoutOwn } from "../src/book";

const words = (...w: bigint[]) => encodePacked(w.map(() => "uint256"), w) as Hex;

describe("decodeL2", () => {
  test("reads bids, the separator and asks", () => {
    const book = decodeL2(words(123n, 4000n, 1000n, 3900n, 500n, 0n, 6000n, 1000n));
    expect(book).toEqual({
      bids: [
        { price: 4000, size: 1000n },
        { price: 3900, size: 500n },
      ],
      asks: [{ price: 6000, size: 1000n }],
    });
  });

  test("reads an empty book and a one-sided book", () => {
    expect(decodeL2(words(1n, 0n))).toEqual({ bids: [], asks: [] });
    expect(decodeL2(words(1n, 0n, 6000n, 5n))).toEqual({ bids: [], asks: [{ price: 6000, size: 5n }] });
  });
});

describe("withoutOwn", () => {
  test("removes our own size from each level and drops emptied levels", () => {
    const book = { bids: [{ price: 4000, size: 1500n }], asks: [{ price: 6000, size: 1000n }, { price: 6100, size: 300n }] };
    const own = [
      { price: 4000, size: 1000n, isBuy: true },
      { price: 6000, size: 1000n, isBuy: false },
    ];
    expect(withoutOwn(book, own)).toEqual({ bids: [{ price: 4000, size: 500n }], asks: [{ price: 6100, size: 300n }] });
  });
});
