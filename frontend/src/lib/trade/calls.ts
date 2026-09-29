import { attentionPerpAbi, bondingCurveAbi, type Call, curationFeesAbi, outcomeMarketsAbi, spotBuyCalls, spotBuyWithLimitCalls, spotSellCalls, spotSellWithLimitCalls } from "@trendr/contracts";
import { closeMarketOrder, depositCalls, openAccountCalls, openMarketOrder, type PerplMarket, tradeCall, withdrawCall } from "@trendr/perpl";
import { type Address, encodeFunctionData, erc20Abi, type Hex } from "viem";
import { DEPLOYMENT } from "@/lib/config";

/**
 * Transaction batches for every trade, in the shape PasskeyAccount executes. Each approval is for
 * exactly the amount the next call spends: the account refuses a batch that leaves an allowance.
 * Every recipient is the account itself; sessions cannot pay anyone else.
 */

const d = DEPLOYMENT;
const approve = (token: Address, spender: Address, amount: bigint): Call => ({ target: token, value: 0n, data: encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [spender, amount] }) });
const call = (target: Address, data: Hex): Call => ({ target, value: 0n, data });
const deadline = (seconds = 300) => BigInt(Math.floor(Date.now() / 1000) + seconds);

export const outcome = {
  /** One AUSD (raw 1e6) mints one UP and one DOWN. */
  mint: (seriesId: Hex, amount: bigint, to: Address): Call[] => [approve(d.ausd, d.outcomeMarkets, amount), call(d.outcomeMarkets, encodeFunctionData({ abi: outcomeMarketsAbi, functionName: "mint", args: [seriesId, amount, to] }))],
  /** `markets` is the OutcomeMarkets that issued the series: a replaced one only redeems, from the passkey. */
  redeemSets: (seriesId: Hex, amount: bigint, to: Address, markets: Address = d.outcomeMarkets): Call[] => [call(markets, encodeFunctionData({ abi: outcomeMarketsAbi, functionName: "redeemSets", args: [seriesId, amount, to] }))],
  redeemWinnings: (seriesId: Hex, up: bigint, down: bigint, to: Address, markets: Address = d.outcomeMarkets): Call[] => [call(markets, encodeFunctionData({ abi: outcomeMarketsAbi, functionName: "redeemWinnings", args: [seriesId, up, down, to] }))],
};

/**
 * Kuru spot through TrendrSpot (canonical outcome markets and graduated coins only). A session
 * trades UP and DOWN with `buy` and `sell`, inside TrendrSpot's band around the attention-implied
 * value; the `WithLimit` pair, for trend coins and trades outside the band, is a passkey action.
 */
export const spot = {
  buy: (token: Address, ausdIn: bigint, minOut: bigint, to: Address) => spotBuyCalls(d, token, ausdIn, minOut, to),
  sell: (token: Address, amountIn: bigint, minOut: bigint, to: Address) => spotSellCalls(d, token, amountIn, minOut, to),
  buyWithLimit: (token: Address, ausdIn: bigint, minOut: bigint, to: Address) => spotBuyWithLimitCalls(d, token, ausdIn, minOut, to),
  sellWithLimit: (token: Address, amountIn: bigint, minOut: bigint, to: Address) => spotSellWithLimitCalls(d, token, amountIn, minOut, to),
};

export const LEVERAGE_SCALE = 10n ** 18n;

export const perp = {
  /** `margin` includes the 0.1% fee on notional; leverage 1 to 3 (1e18-scaled on chain). */
  open: (trendId: Hex, isLong: boolean, margin: bigint, leverage: number, acceptableIndex: bigint): Call[] => [
    approve(d.ausd, d.attentionPerp, margin),
    call(d.attentionPerp, encodeFunctionData({ abi: attentionPerpAbi, functionName: "open", args: [trendId, isLong, margin, BigInt(Math.round(leverage * 1e6)) * 10n ** 12n, acceptableIndex, deadline()] })),
  ],
  close: (id: bigint, acceptableIndex: bigint): Call[] => [call(d.attentionPerp, encodeFunctionData({ abi: attentionPerpAbi, functionName: "close", args: [id, acceptableIndex, deadline()] }))],
  /** A passkey (owner) action: trading sessions do not carry addMargin. */
  addMargin: (id: bigint, amount: bigint): Call[] => [approve(d.ausd, d.attentionPerp, amount), call(d.attentionPerp, encodeFunctionData({ abi: attentionPerpAbi, functionName: "addMargin", args: [id, amount] }))],
};

/** Trend coins on their bonding curve: passkey actions, since a coin has no oracle price to bound a session's trade. */
export const curve = {
  buy: (trendId: Hex, quoteIn: bigint, minCoins: bigint, to: Address): Call[] => [approve(d.ausd, d.bondingCurve, quoteIn), call(d.bondingCurve, encodeFunctionData({ abi: bondingCurveAbi, functionName: "buy", args: [trendId, quoteIn, minCoins, to, deadline()] }))],
  /** The curve burns the coins itself (it is the coin's minter), so selling needs no approval. */
  sell: (trendId: Hex, coinsIn: bigint, minQuote: bigint, to: Address): Call[] => [call(d.bondingCurve, encodeFunctionData({ abi: bondingCurveAbi, functionName: "sell", args: [trendId, coinsIn, minQuote, to, deadline()] }))],
};

/** Curation fees are paid only to their earner, and claiming is an owner action (one passkey prompt). */
export const curation = {
  claim: (to: Address): Call[] => [call(d.curationFees, encodeFunctionData({ abi: curationFeesAbi, functionName: "claim", args: [to] }))],
};

/**
 * Perpl perpetuals from the account's own Perpl account. Request ids are small and sequential
 * per account (the account's last id plus one), never timestamps: see the repo notes.
 */
export const perpl = {
  openAccount: (amount: bigint) => openAccountCalls(d.perplExchange, d.ausd, amount, false),
  deposit: (amount: bigint) => depositCalls(d.perplExchange, d.ausd, amount),
  open: (market: PerplMarket, requestId: bigint, side: "long" | "short", size: number, worstPrice: number, leverage: number): Call[] => [tradeCall(d.perplExchange, openMarketOrder({ market, requestId, side, size, worstPrice, leverage }))],
  close: (market: PerplMarket, requestId: bigint, side: "long" | "short", size: number, worstPrice: number): Call[] => [tradeCall(d.perplExchange, closeMarketOrder({ market, requestId, side, size, worstPrice }))],
  /** Back to the Trendr account; an owner action (one passkey prompt). */
  withdraw: (amount: bigint): Call[] => [withdrawCall(d.perplExchange, amount)],
};
