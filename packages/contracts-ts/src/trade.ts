import { encodeFunctionData, erc20Abi, type Address, type Hex, hexToBigInt, size as byteLength, slice } from "viem";
import type { Call } from "./account";
import { trendrSpotAbi } from "./abis";
import type { Deployment } from "./deployments";

/**
 * Spot trading of Trendr tokens on Kuru: reading a market's depth, quoting a trade against it, and
 * the calls that execute it through TrendrSpot. A session trades UP and DOWN with `buy` and `sell`,
 * which keep to a band around the attention-implied value (see TrendrSpot); trades outside the band
 * and trend coins go through `buyWithLimit` and `sellWithLimit` in a passkey (owner) batch.
 *
 * Canonical outcome markets (OutcomeListing) price in 0.0001 AUSD and size in 0.01 tokens, so a
 * level's raw AUSD cost is exactly price units times size units for 6-decimal tokens.
 */
export const OUTCOME_MARKET = { pricePrecision: 10_000, sizePrecision: 100, takerFeeBps: 10 } as const;
const RAW_PER_SIZE = 10_000n;

export interface BookLevel {
  /** Price units (0.0001 AUSD). */
  price: number;
  /** Size units (0.01 token). */
  size: bigint;
}

export interface OrderBook {
  bids: BookLevel[];
  asks: BookLevel[];
}

/**
 * Decodes Kuru's getL2Book bytes: the block number, (price, size) bid levels best first, a zero
 * word, then ask levels best first.
 */
export function decodeL2(data: Hex): OrderBook {
  const words: bigint[] = [];
  for (let i = 0; i < byteLength(data); i += 32) words.push(hexToBigInt(slice(data, i, i + 32)));
  const book: OrderBook = { bids: [], asks: [] };
  let i = 1;
  for (; i + 1 < words.length && words[i] !== 0n; i += 2) book.bids.push({ price: Number(words[i]), size: words[i + 1]! });
  for (i++; i + 1 < words.length; i += 2) book.asks.push({ price: Number(words[i]), size: words[i + 1]! });
  return book;
}

export interface Quote {
  /** Raw units received after Kuru's taker fee. */
  out: bigint;
  /** Raw units of the input the book can absorb. */
  filled: bigint;
  /** True when the book is deep enough for the whole input. */
  complete: boolean;
  /** Average price in AUSD per token, fee included. */
  averagePrice: number;
}

const afterFee = (amount: bigint) => (amount * BigInt(10_000 - OUTCOME_MARKET.takerFeeBps)) / 10_000n;

/** Tokens (raw) that `ausdIn` (raw) buys from the asks, filled in whole size units. */
export function quoteBuy(book: OrderBook, ausdIn: bigint): Quote {
  let left = ausdIn;
  let tokens = 0n;
  let complete = false;
  for (const level of book.asks) {
    const price = BigInt(level.price);
    const affordable = left / price;
    if (affordable < level.size) {
      tokens += affordable * RAW_PER_SIZE;
      left -= affordable * price;
      complete = true;
      break;
    }
    tokens += level.size * RAW_PER_SIZE;
    left -= level.size * price;
  }
  const out = afterFee(tokens);
  const filled = ausdIn - left;
  return { out, filled, complete: complete || left === 0n, averagePrice: out > 0n ? Number(filled) / Number(out) : 0 };
}

/** AUSD (raw) that selling `tokensIn` (raw) into the bids returns, in whole size units. */
export function quoteSell(book: OrderBook, tokensIn: bigint): Quote {
  const wanted = tokensIn / RAW_PER_SIZE;
  let left = wanted;
  let ausd = 0n;
  for (const level of book.bids) {
    if (left === 0n) break;
    const take = left < level.size ? left : level.size;
    ausd += take * BigInt(level.price);
    left -= take;
  }
  const out = afterFee(ausd);
  const filled = (wanted - left) * RAW_PER_SIZE;
  return { out, filled, complete: left === 0n, averagePrice: filled > 0n ? Number(out) / Number(filled) : 0 };
}

/** The least a trade may return: the quote less `slippageBps`. */
export function minimumOut(quote: Quote, slippageBps: number): bigint {
  return (quote.out * BigInt(10_000 - slippageBps)) / 10_000n;
}

/** TrendrSpot's band for an UP or DOWN token, in AUSD per token: its `priceBand` view. */
export interface PriceBand {
  fair: number;
  low: number;
  high: number;
}

export function toPriceBand([fair, low, high]: readonly [bigint, bigint, bigint]): PriceBand {
  return { fair: Number(fair) / 1e18, low: Number(low) / 1e18, high: Number(high) / 1e18 };
}

/**
 * Whether a session may take a quoted trade: its average price, Kuru's fee included, lies inside
 * the band. Outside it TrendrSpot's `buy` and `sell` would revert, so the trade needs the passkey.
 */
export function insideBand(quote: Quote, band: PriceBand, isBuy: boolean): boolean {
  if (quote.averagePrice <= 0) return false;
  return isBuy ? quote.averagePrice <= band.high : quote.averagePrice >= band.low;
}

type SpotBuy = "buy" | "buyWithLimit";
type SpotSell = "sell" | "sellWithLimit";

function buyCalls(d: Deployment, fn: SpotBuy, token: Address, ausdIn: bigint, minOut: bigint, recipient: Address): Call[] {
  return [
    { target: d.ausd, value: 0n, data: encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [d.trendrSpot, ausdIn] }) },
    { target: d.trendrSpot, value: 0n, data: encodeFunctionData({ abi: trendrSpotAbi, functionName: fn, args: [token, ausdIn, minOut, recipient] }) },
  ];
}

function sellCalls(d: Deployment, fn: SpotSell, token: Address, amountIn: bigint, minOut: bigint, recipient: Address): Call[] {
  return [
    { target: token, value: 0n, data: encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [d.trendrSpot, amountIn] }) },
    { target: d.trendrSpot, value: 0n, data: encodeFunctionData({ abi: trendrSpotAbi, functionName: fn, args: [token, amountIn, minOut, recipient] }) },
  ];
}

/** Session: approve exactly `ausdIn` to TrendrSpot and buy UP or DOWN `token` inside the band, paid to `recipient`. */
export function spotBuyCalls(d: Deployment, token: Address, ausdIn: bigint, minOut: bigint, recipient: Address): Call[] {
  return buyCalls(d, "buy", token, ausdIn, minOut, recipient);
}

/** Session: approve exactly `amountIn` of UP or DOWN `token` to TrendrSpot and sell it inside the band, paid to `recipient`. */
export function spotSellCalls(d: Deployment, token: Address, amountIn: bigint, minOut: bigint, recipient: Address): Call[] {
  return sellCalls(d, "sell", token, amountIn, minOut, recipient);
}

/** Passkey: buy any Trendr token with a canonical market at the caller's own limit. */
export function spotBuyWithLimitCalls(d: Deployment, token: Address, ausdIn: bigint, minOut: bigint, recipient: Address): Call[] {
  return buyCalls(d, "buyWithLimit", token, ausdIn, minOut, recipient);
}

/** Passkey: sell any Trendr token with a canonical market at the caller's own limit. */
export function spotSellWithLimitCalls(d: Deployment, token: Address, amountIn: bigint, minOut: bigint, recipient: Address): Call[] {
  return sellCalls(d, "sellWithLimit", token, amountIn, minOut, recipient);
}
