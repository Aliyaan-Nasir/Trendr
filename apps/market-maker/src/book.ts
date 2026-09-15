import { decodeL2 as decode, type OrderBook } from "@trendr/contracts";
import type { Hex } from "viem";

/** Canonical Trendr outcome markets (OutcomeListing): prices in 0.0001 AUSD, sizes in 0.01 tokens. */
export const PRICE_PRECISION = 10_000;
export const TICK = 10;
export const SIZE_PRECISION = 100;
export const MIN_SIZE = 100n;
/** Taker fee in basis points, charged on what the taker receives. */
export const TAKER_FEE_BPS = 10;

/** One price level: price in price units, size in size units. */
export interface Level {
  price: number;
  size: bigint;
}

export interface Book {
  bids: Level[];
  asks: Level[];
}

/** Kuru's depth for one market; the decoding lives in @trendr/contracts. */
export function decodeL2(data: Hex): Book {
  return decode(data) satisfies OrderBook;
}

/** The book without our own resting orders, so we never trade against ourselves. */
export function withoutOwn(book: Book, own: readonly (Level & { isBuy: boolean })[]): Book {
  const minus = (levels: Level[], isBuy: boolean) =>
    levels
      .map((l) => {
        const mine = own.filter((o) => o.isBuy === isBuy && o.price === l.price).reduce((a, o) => a + o.size, 0n);
        return { price: l.price, size: l.size - mine };
      })
      .filter((l) => l.size > 0n);
  return { bids: minus(book.bids, true), asks: minus(book.asks, false) };
}
