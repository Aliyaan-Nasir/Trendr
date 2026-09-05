import { type Address, encodeFunctionData, erc20Abi, parseAbi } from "viem";
import type { Call } from "./account";

/**
 * Converting USDC in a Trendr account into AUSD. Aurora deposits land as USDC (AUSD is not an
 * Aurora asset), and on Monad Mainnet AUSD liquidity sits in the AUSD/USDC/USDT0 stable pool, a
 * Curve StableSwap pool whose `exchange` pays any receiver. The account approves exactly the amount
 * to the pool and exchanges USDC for AUSD paid to itself, in one passkey (owner) batch; the relayer
 * sponsors exactly that pair of calls. The pool's admin (an EOA, through its factory) can raise the
 * swap fee at once, so every conversion carries a minimum out near par (docs/aurora.md).
 */
export interface UsdcConversion {
  pool: Address;
  usdc: Address;
  ausd: Address;
  /** Coin indexes in the pool (`coins(i)`). */
  usdcIndex: bigint;
  ausdIndex: bigint;
}

/** Chains where Trendr converts USDC: Mainnet only (Aurora does not serve Monad Testnet). */
export const USDC_CONVERSIONS: Readonly<Record<number, UsdcConversion>> = {
  143: {
    pool: "0x942644106B073E30D72c2C5D7529D5C296ea91ab",
    usdc: "0x754704Bc059F8C67012fEd69BC8A327a5aafb603",
    ausd: "0x00000000eFE302BEAA2b3e6e1b18d08D69a9012a",
    usdcIndex: 1n,
    ausdIndex: 0n,
  },
};

export function usdcConversion(chainId: number): UsdcConversion | null {
  return USDC_CONVERSIONS[chainId] ?? null;
}

export const stableSwapAbi = parseAbi([
  "function exchange(int128 i, int128 j, uint256 dx, uint256 min_dy, address receiver) returns (uint256)",
  "function get_dy(int128 i, int128 j, uint256 dx) view returns (uint256)",
  "function coins(uint256 i) view returns (address)",
]);

/** Default tolerance between the quote and the fill. */
export const CONVERSION_SLIPPAGE_BPS = 30;
/** The least AUSD per USDC a conversion accepts, in basis points of par (0.99). */
export const CONVERSION_FLOOR_BPS = 9_900;

/**
 * The least AUSD to accept for `amountIn` USDC (both 6 decimals) given the pool's quote: the quote
 * less `slippageBps`, never under the floor. Null when the quote itself is under the floor (the pool
 * is off peg, or its fee was raised): converting then would lose more than the floor allows.
 */
export function conversionMinOut(
  amountIn: bigint,
  quote: bigint,
  opts: { slippageBps?: number; floorBps?: number } = {},
): bigint | null {
  if (amountIn <= 0n) return null;
  const floor = (amountIn * BigInt(opts.floorBps ?? CONVERSION_FLOOR_BPS)) / 10_000n;
  if (quote < floor) return null;
  const minOut = (quote * BigInt(10_000 - (opts.slippageBps ?? CONVERSION_SLIPPAGE_BPS))) / 10_000n;
  return minOut > floor ? minOut : floor;
}

/** The owner batch: approve exactly `amountIn` USDC to the pool, then exchange it for AUSD paid to `account`. */
export function usdcToAusdCalls(c: UsdcConversion, account: Address, amountIn: bigint, minOut: bigint): Call[] {
  if (amountIn <= 0n || minOut <= 0n) throw new Error("a conversion needs an amount and a minimum out");
  return [
    { target: c.usdc, value: 0n, data: encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [c.pool, amountIn] }) },
    {
      target: c.pool,
      value: 0n,
      data: encodeFunctionData({ abi: stableSwapAbi, functionName: "exchange", args: [c.usdcIndex, c.ausdIndex, amountIn, minOut, account] }),
    },
  ];
}
