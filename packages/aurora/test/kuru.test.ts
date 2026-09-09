import { describe, expect, test } from "bun:test";
import { decodeFunctionData, erc20Abi } from "viem";
import { iKuruRouterAbi } from "../../contracts-ts/src/abis";
import {
  AUSD_MAINNET,
  CURVE_AUSD_POOL,
  CURVE_POOL_COINS,
  curvePoolAbi,
  curveSwapCalls,
  decodeKuruBook,
  KURU_AUSD_USDC,
  KURU_MAINNET,
  KuruMarketState,
  kuruSwapCalls,
  MONAD_ASSETS,
  minusBps,
  quoteKuruBuy,
  quoteKuruSell,
} from "../src";
import { fixture } from "./helpers";

const recorded = fixture("kuru/ausd-usdc-book");
const book = decodeKuruBook(recorded.body.l2);
const m = KURU_AUSD_USDC;

describe("the Kuru AUSD/USDC market on Monad Mainnet", () => {
  test("matches what Router.verifiedMarket returned on chain", () => {
    const [pricePrecision, sizePrecision, base, baseDecimals, quote, quoteDecimals, , , , takerFeeBps] = recorded.body.verifiedMarket;
    expect(BigInt(pricePrecision)).toBe(m.pricePrecision);
    expect(BigInt(sizePrecision)).toBe(m.sizePrecision);
    expect(base.toLowerCase()).toBe(AUSD_MAINNET.address.toLowerCase());
    expect(quote.toLowerCase()).toBe(MONAD_ASSETS.USDC.address!.toLowerCase());
    expect(Number(baseDecimals)).toBe(m.baseDecimals);
    expect(Number(quoteDecimals)).toBe(m.quoteDecimals);
    expect(BigInt(takerFeeBps)).toBe(m.takerFeeBps);
  });

  test("was soft-paused when recorded, so swaps through it revert", () => {
    expect(recorded.body.marketState).toBe(KuruMarketState.SoftPaused);
  });

  test("decodes the recorded book: block, bids falling, asks rising, no crossed levels", () => {
    expect(book.block).toBe(BigInt(recorded.blockNumber as string));
    expect(book.bids.length).toBeGreaterThan(0);
    expect(book.asks.length).toBeGreaterThan(0);
    for (let i = 1; i < book.bids.length; i++) expect(book.bids[i]!.price).toBeLessThanOrEqual(book.bids[i - 1]!.price);
    for (let i = 1; i < book.asks.length; i++) expect(book.asks[i]!.price).toBeGreaterThanOrEqual(book.asks[i - 1]!.price);
    expect(book.bids[0]!.price).toBeLessThan(book.asks[0]!.price);
    // Near par: within 2% of 1 USDC per AUSD.
    expect(Number(book.asks[0]!.price) / 1e8).toBeGreaterThan(0.98);
    expect(Number(book.asks[0]!.price) / 1e8).toBeLessThan(1.02);
  });
});

describe("quoting", () => {
  const askDepthUsdc = book.asks.reduce((sum, l) => sum + (l.size * l.price + m.pricePrecision - 1n) / m.pricePrecision, 0n);
  const askDepthAusd = book.asks.reduce((sum, l) => sum + l.size, 0n);

  test("a small buy fills at the best ask", () => {
    const fill = quoteKuruBuy(book, m, 1_000_000n);
    expect(fill.complete).toBe(true);
    const best = book.asks[0]!.price;
    expect(fill.out).toBe((1_000_000n * m.pricePrecision) / best);
    expect(fill.spent).toBeLessThanOrEqual(1_000_000n);
  });

  test("a buy larger than the book reports an incomplete fill of the whole book", () => {
    const fill = quoteKuruBuy(book, m, askDepthUsdc + 1_000_000_000n);
    expect(fill.complete).toBe(false);
    expect(fill.out).toBe(askDepthAusd);
    expect(fill.spent).toBe(askDepthUsdc);
  });

  test("an exact book sweep is complete", () => {
    const fill = quoteKuruBuy(book, m, askDepthUsdc);
    expect(fill.complete).toBe(true);
    expect(fill.out).toBe(askDepthAusd);
  });

  test("a sell fills bids best first", () => {
    const fill = quoteKuruSell(book, m, 1_000_000n);
    expect(fill.complete).toBe(true);
    expect(fill.out).toBe((1_000_000n * book.bids[0]!.price) / m.pricePrecision);
  });

  test("slippage floors", () => {
    expect(minusBps(10_000_000n, 50)).toBe(9_950_000n);
    expect(() => minusBps(1n, 10_001)).toThrow();
  });
});

describe("session conversion calls", () => {
  test("approve exactly, then anyToAnySwap USDC to AUSD paid to the account", () => {
    const [approve, swap] = kuruSwapCalls({ side: "buy", amountIn: 25_000_000n, minOut: 24_800_000n });
    expect(approve!.target).toBe(MONAD_ASSETS.USDC.address!);
    expect(decodeFunctionData({ abi: erc20Abi, data: approve!.data }).args).toEqual([KURU_MAINNET.router, 25_000_000n]);
    expect(swap!.target).toBe(KURU_MAINNET.router);
    const decoded = decodeFunctionData({ abi: iKuruRouterAbi, data: swap!.data });
    expect(decoded.functionName).toBe("anyToAnySwap");
    expect(decoded.args).toEqual([[m.address], [true], [false], MONAD_ASSETS.USDC.address!, AUSD_MAINNET.address, 25_000_000n, 24_800_000n]);
  });

  test("selling AUSD for USDC (withdrawals) flips the side and the tokens", () => {
    const [approve, swap] = kuruSwapCalls({ side: "sell", amountIn: 5_000_000n, minOut: 4_950_000n });
    expect(approve!.target).toBe(AUSD_MAINNET.address);
    const decoded = decodeFunctionData({ abi: iKuruRouterAbi, data: swap!.data });
    expect(decoded.args).toEqual([[m.address], [false], [false], AUSD_MAINNET.address, MONAD_ASSETS.USDC.address!, 5_000_000n, 4_950_000n]);
  });
});

describe("the AUSD/USDC/USDT0 stable pool", () => {
  const pool = fixture("curve/ausd-pool");

  test("holds the coins at the indexes the recipes use", () => {
    expect(pool.body.coins.map((c: string) => c.toLowerCase())).toEqual(CURVE_POOL_COINS.map((c) => c.toLowerCase()));
    expect(CURVE_POOL_COINS[CURVE_AUSD_POOL.index.AUSD]).toBe(AUSD_MAINNET.address);
    expect(CURVE_POOL_COINS[CURVE_AUSD_POOL.index.USDC]).toBe(MONAD_ASSETS.USDC.address!);
  });

  test("was deep enough for a 100,000 USDC deposit within 0.1% when recorded", () => {
    for (const { dx, dy } of pool.body.usdcToAusd) {
      const ratio = Number(dy) / Number(dx);
      expect(ratio).toBeGreaterThan(0.999);
      expect(ratio).toBeLessThan(1.001);
    }
    expect(BigInt(pool.body.balances[CURVE_AUSD_POOL.index.AUSD])).toBeGreaterThan(100_000_000_000n);
  });

  test("session calls approve exactly and pin the receiver", () => {
    const account = "0x4444444444444444444444444444444444444444";
    const [approve, exchange] = curveSwapCalls({ i: 1, j: 0, amountIn: 25_000_000n, minOut: 24_900_000n, receiver: account });
    expect(approve!.target).toBe(MONAD_ASSETS.USDC.address!);
    expect(decodeFunctionData({ abi: erc20Abi, data: approve!.data }).args).toEqual([CURVE_AUSD_POOL.address, 25_000_000n]);
    expect(exchange!.target).toBe(CURVE_AUSD_POOL.address);
    expect(decodeFunctionData({ abi: curvePoolAbi, data: exchange!.data }).args).toEqual([1n, 0n, 25_000_000n, 24_900_000n, account]);
    expect(() => curveSwapCalls({ i: 0, j: 0, amountIn: 1n, minOut: 1n, receiver: account })).toThrow();
  });
});
