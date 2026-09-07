import { type Address, encodeFunctionData, erc20Abi, parseAbi, type PublicClient } from "viem";
import type { AccountCall } from "./kuru";
import { AUSD_MAINNET, MONAD_ASSETS } from "./monad";

/**
 * The AUSD/USDC/USDT0 stable pool on Monad Mainnet, where AUSD liquidity actually sits.
 *
 * It is a Curve StableSwap-NG style pool (name "3pool", symbol AUSDCT0, version 7.0.0) holding
 * about 626k AUSD, 556k USDC and 1.12M USDT0 on 2026-10-09; Kuru's own aggregator (Kuru Flow)
 * routed about 78% of a 1,000 USDC to AUSD swap through it. Its exchange takes a receiver, so the
 * AUSD can be paid straight to the Trendr account. Monadscan has its source (Curve.Fi
 * CurveStableSwap 7.0.0, from factory 0x8271e06E5887FE5ba05234f5315c19f3Ec90E8aD), and the
 * factory's admin, a single EOA, can raise its swap fee up to 50% in one transaction, so every
 * exchange must carry a minimum out from a fresh quote (docs/aurora.md). The app's own conversion
 * of a landed deposit is `usdcToAusdCalls` in @trendr/contracts, which the relayer allows exactly.
 */

export const CURVE_AUSD_POOL = {
  address: "0x942644106B073E30D72c2C5D7529D5C296ea91ab",
  /** Coin indexes, from coins(i). */
  index: { AUSD: 0, USDC: 1, USDT0: 2 },
} as const satisfies { address: Address; index: Record<string, number> };

export const CURVE_POOL_COINS: readonly Address[] = [AUSD_MAINNET.address, MONAD_ASSETS.USDC.address!, MONAD_ASSETS.USDT0.address!];

export const curvePoolAbi = parseAbi([
  "function exchange(int128 i, int128 j, uint256 dx, uint256 min_dy, address receiver) returns (uint256)",
  "function get_dy(int128 i, int128 j, uint256 dx) view returns (uint256)",
  "function coins(uint256 i) view returns (address)",
  "function get_balances() view returns (uint256[])",
]);

/** What `dx` of coin `i` buys of coin `j` right now (the pool's own quote, fee included). */
export function curveQuote(client: Pick<PublicClient, "readContract">, input: { i: number; j: number; dx: bigint; pool?: Address }): Promise<bigint> {
  return client.readContract({
    address: input.pool ?? CURVE_AUSD_POOL.address,
    abi: curvePoolAbi,
    functionName: "get_dy",
    args: [BigInt(input.i), BigInt(input.j), input.dx],
  });
}

/**
 * The session batch that converts inside the Trendr account: approve exactly `amountIn` to the
 * pool, then exchange with the account as receiver. A PasskeyAccount session permission for
 * exchange can pin the receiver (recipientArg 5) to the account.
 */
export function curveSwapCalls(input: { i: number; j: number; amountIn: bigint; minOut: bigint; receiver: Address; pool?: Address }): AccountCall[] {
  const pool = input.pool ?? CURVE_AUSD_POOL.address;
  const tokenIn = CURVE_POOL_COINS[input.i];
  if (!tokenIn || !CURVE_POOL_COINS[input.j] || input.i === input.j) throw new Error("bad coin indexes");
  return [
    { target: tokenIn, value: 0n, data: encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [pool, input.amountIn] }) },
    {
      target: pool,
      value: 0n,
      data: encodeFunctionData({ abi: curvePoolAbi, functionName: "exchange", args: [BigInt(input.i), BigInt(input.j), input.amountIn, input.minOut, input.receiver] }),
    },
  ];
}
