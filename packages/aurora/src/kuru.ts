import { type Address, encodeFunctionData, erc20Abi, type Hex, hexToBigInt, parseAbi, type PublicClient, size, slice } from "viem";
import { AUSD_MAINNET, MONAD_ASSETS } from "./monad";

/**
 * Kuru on Monad Mainnet: its AUSD/USDC order book and the Router call that swaps through it.
 *
 * Kuru Mainnet lists an AUSD/USDC book (base AUSD, quote USDC, no taker fee), but on 2026-10-09
 * the market was SOFT_PAUSED (marketState 1: only cancels, deposits and withdrawals), so
 * anyToAnySwap through it reverts with MarketStateError(), and its book held only about 264 AUSD
 * of asks. Check `readKuruMarketState` before routing through it; the AUSD liquidity is in the
 * stable pool in curve.ts, which Kuru's own aggregator (Kuru Flow) also routes through.
 *
 * Addresses are from https://docs.kuru.io/contracts/Contract-addresses and Kuru's exchange API, and
 * the market's parameters were read from Router.verifiedMarket on Mainnet.
 */

export const KURU_MAINNET = {
  router: "0xd651346d7c789536ebf06dc72aE3C8502cd695CC",
  marginAccount: "0x2A68ba1833cDf93fa9Da1EEbd7F46242aD8E90c5",
  /** Kuru Flow aggregator. Its ABI is not published, so it cannot be a typed Intents Connect step. */
  flowEntrypoint: "0xb3e6778480b2E488385E8205eA05E20060B813cb",
} as const satisfies Record<string, Address>;

export interface KuruMarket {
  address: Address;
  base: Address;
  quote: Address;
  baseDecimals: number;
  quoteDecimals: number;
  /** Prices are integers in 1/pricePrecision quote per base. */
  pricePrecision: bigint;
  /** Sizes are integers in 1/sizePrecision base. */
  sizePrecision: bigint;
  takerFeeBps: bigint;
}

export const KURU_AUSD_USDC: KuruMarket = {
  address: "0x699AbC15308156E9a3AB89Ec7387e9CfE1c86A3b",
  base: AUSD_MAINNET.address,
  quote: MONAD_ASSETS.USDC.address!,
  baseDecimals: 6,
  quoteDecimals: 6,
  pricePrecision: 100_000_000n,
  sizePrecision: 1_000_000n,
  takerFeeBps: 0n,
};

export const kuruRouterAbi = parseAbi([
  "function anyToAnySwap(address[] markets, bool[] isBuy, bool[] nativeSend, address debitToken, address creditToken, uint256 amount, uint256 minAmountOut) payable returns (uint256 amountOut)",
  "function verifiedMarket(address market) view returns (uint32 pricePrecision, uint96 sizePrecision, address baseAssetAddress, uint256 baseAssetDecimals, address quoteAssetAddress, uint256 quoteAssetDecimals, uint32 tickSize, uint96 minSize, uint96 maxSize, uint256 takerFeeBps, uint256 makerFeeBps)",
]);

export const kuruOrderBookAbi = parseAbi([
  "function getL2Book(uint32 bidPricePoints, uint32 askPricePoints) view returns (bytes)",
  "function marketState() view returns (uint8)",
]);

/** Kuru OrderBook states: only Active accepts market orders. */
export enum KuruMarketState {
  Active = 0,
  /** Only cancels, deposits and withdrawals. */
  SoftPaused = 1,
  HardPaused = 2,
}

export async function readKuruMarketState(client: Pick<PublicClient, "readContract">, market: KuruMarket = KURU_AUSD_USDC): Promise<KuruMarketState> {
  return client.readContract({ address: market.address, abi: kuruOrderBookAbi, functionName: "marketState" });
}

export interface KuruLevel {
  /** pricePrecision units. */
  price: bigint;
  /** sizePrecision units. */
  size: bigint;
}

export interface KuruBook {
  block: bigint;
  /** Best first. */
  bids: KuruLevel[];
  /** Best first. */
  asks: KuruLevel[];
}

/** Decodes getL2Book: the block number, bid levels, a zero word, then ask levels. */
export function decodeKuruBook(data: Hex): KuruBook {
  const words: bigint[] = [];
  for (let i = 0; i + 32 <= size(data); i += 32) words.push(hexToBigInt(slice(data, i, i + 32)));
  const book: KuruBook = { block: words[0] ?? 0n, bids: [], asks: [] };
  let i = 1;
  for (; i + 1 < words.length && words[i] !== 0n; i += 2) book.bids.push({ price: words[i]!, size: words[i + 1]! });
  for (i++; i + 1 < words.length; i += 2) book.asks.push({ price: words[i]!, size: words[i + 1]! });
  return book;
}

export async function readKuruBook(client: Pick<PublicClient, "readContract">, market: KuruMarket = KURU_AUSD_USDC, levels = 50): Promise<KuruBook> {
  const data = await client.readContract({ address: market.address, abi: kuruOrderBookAbi, functionName: "getL2Book", args: [levels, levels] });
  return decodeKuruBook(data);
}

export interface KuruFill {
  /** Raw units received, after the taker fee. */
  out: bigint;
  /** Raw units of the input the book absorbs. */
  spent: bigint;
  /** False when the book ran out before the input did. */
  complete: boolean;
}

const pow10 = (n: number) => 10n ** BigInt(n);
const ceilDiv = (a: bigint, b: bigint) => (a + b - 1n) / b;
const afterFee = (amount: bigint, market: KuruMarket) => (amount * (10_000n - market.takerFeeBps)) / 10_000n;

/** Base (raw) bought with `quoteIn` (raw), filling asks best first in whole size units. */
export function quoteKuruBuy(book: KuruBook, market: KuruMarket, quoteIn: bigint): KuruFill {
  const unitScale = market.sizePrecision * market.pricePrecision;
  const q = pow10(market.quoteDecimals);
  const b = pow10(market.baseDecimals);
  let left = quoteIn;
  let base = 0n;
  let complete = false;
  for (const level of book.asks) {
    const cost = ceilDiv(level.size * level.price * q, unitScale);
    if (cost <= left) {
      left -= cost;
      base += (level.size * b) / market.sizePrecision;
      if (left === 0n) {
        complete = true;
        break;
      }
      continue;
    }
    const units = (left * unitScale) / (level.price * q);
    left -= ceilDiv(units * level.price * q, unitScale);
    base += (units * b) / market.sizePrecision;
    complete = true;
    break;
  }
  return { out: afterFee(base, market), spent: quoteIn - left, complete };
}

/** Quote (raw) received for `baseIn` (raw), filling bids best first in whole size units. */
export function quoteKuruSell(book: KuruBook, market: KuruMarket, baseIn: bigint): KuruFill {
  const unitScale = market.sizePrecision * market.pricePrecision;
  const q = pow10(market.quoteDecimals);
  const b = pow10(market.baseDecimals);
  let units = (baseIn * market.sizePrecision) / b;
  const wanted = units;
  let quote = 0n;
  for (const level of book.bids) {
    if (units === 0n) break;
    const take = units < level.size ? units : level.size;
    quote += (take * level.price * q) / unitScale;
    units -= take;
  }
  return { out: afterFee(quote, market), spent: ((wanted - units) * b) / market.sizePrecision, complete: units === 0n };
}

/** `amount` less `bps` basis points, rounded down: the minimum to accept from a quote. */
export function minusBps(amount: bigint, bps: number): bigint {
  if (!Number.isInteger(bps) || bps < 0 || bps > 10_000) throw new Error("bps must be 0 to 10000");
  return (amount * BigInt(10_000 - bps)) / 10_000n;
}

/** A call in a Trendr PasskeyAccount batch (the same shape as @trendr/contracts' Call). */
export interface AccountCall {
  target: Address;
  value: bigint;
  data: Hex;
}

/**
 * The session batch that converts inside the Trendr account: approve exactly `amountIn` to the
 * router, then anyToAnySwap through one market. The output goes to the caller, the account itself.
 * `buy` spends the quote token (USDC to AUSD); `sell` spends the base token (AUSD to USDC, for
 * withdrawals). The session needs the router as an approved spender and anyToAnySwap allowed.
 */
export function kuruSwapCalls(input: {
  side: "buy" | "sell";
  amountIn: bigint;
  minOut: bigint;
  market?: KuruMarket;
  router?: Address;
}): AccountCall[] {
  const market = input.market ?? KURU_AUSD_USDC;
  const router = input.router ?? KURU_MAINNET.router;
  const [debit, credit] = input.side === "buy" ? [market.quote, market.base] : [market.base, market.quote];
  return [
    { target: debit, value: 0n, data: encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [router, input.amountIn] }) },
    {
      target: router,
      value: 0n,
      data: encodeFunctionData({
        abi: kuruRouterAbi,
        functionName: "anyToAnySwap",
        args: [[market.address], [input.side === "buy"], [false], debit, credit, input.amountIn, input.minOut],
      }),
    },
  ];
}
