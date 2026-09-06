import { type Address, encodeAbiParameters, encodeFunctionData, erc20Abi, type Hex } from "viem";
import { exchangeAbi } from "./exchange-abi";
import { type PerplMarket, toPriceUnits, toSizeUnits } from "./market";

/** On-chain request types; the API numbers them from 1, the contract from 0. */
export enum OrderType {
  OpenLong = 0,
  OpenShort = 1,
  CloseLong = 2,
  CloseShort = 3,
  Cancel = 4,
  IncreasePositionCollateral = 5,
  Change = 6,
}

/** The Exchange's OrderDesc, as execOrder takes it. */
export interface OrderDesc {
  orderDescId: bigint;
  perpId: bigint;
  orderType: number;
  orderId: bigint;
  pricePNS: bigint;
  lotLNS: bigint;
  expiryBlock: bigint;
  postOnly: boolean;
  fillOrKill: boolean;
  immediateOrCancel: boolean;
  maxMatches: bigint;
  leverageHdths: bigint;
  lastExecutionBlock: bigint;
  amountCNS: bigint;
  maxNegPnlCollatBPS: bigint;
}

/** Perpl's SDK default for the negative-PnL collateralization limit. */
export const DEFAULT_MAX_NEG_PNL_COLLAT_BPS = 1000n;

const blank = (market: PerplMarket, requestId: bigint, orderType: OrderType): OrderDesc => ({
  orderDescId: requestId,
  perpId: BigInt(market.id),
  orderType,
  orderId: 0n,
  pricePNS: 0n,
  lotLNS: 0n,
  expiryBlock: 0n,
  postOnly: false,
  fillOrKill: false,
  immediateOrCancel: false,
  maxMatches: 0n,
  leverageHdths: 0n,
  lastExecutionBlock: 0n,
  amountCNS: 0n,
  maxNegPnlCollatBPS: market.defaultMnp > 0 ? BigInt(market.defaultMnp) : DEFAULT_MAX_NEG_PNL_COLLAT_BPS,
});

export interface MarketOrderInput {
  market: PerplMarket;
  /** Client order id; unique and increasing per account. */
  requestId: bigint;
  side: "long" | "short";
  /** Contracts, in the market's size units (for example BTC). */
  size: number;
  /** The worst price to fill at: above the ask for a long, below the bid for a short. */
  worstPrice: number;
  leverage: number;
}

/** An immediate-or-cancel order that opens or adds to a position, filling no worse than `worstPrice`. */
export function openMarketOrder(o: MarketOrderInput): OrderDesc {
  if (o.leverage <= 0 || o.leverage > o.market.maxLeverage) throw new Error(`leverage must be in (0, ${o.market.maxLeverage}]`);
  const desc = blank(o.market, o.requestId, o.side === "long" ? OrderType.OpenLong : OrderType.OpenShort);
  return {
    ...desc,
    pricePNS: toPriceUnits(o.market, o.worstPrice),
    lotLNS: toSizeUnits(o.market, o.size),
    immediateOrCancel: true,
    leverageHdths: BigInt(Math.round(o.leverage * 100)),
  };
}

/** A reduce-only immediate-or-cancel order that closes up to `size` of a position. */
export function closeMarketOrder(o: Omit<MarketOrderInput, "leverage">): OrderDesc {
  const desc = blank(o.market, o.requestId, o.side === "long" ? OrderType.CloseLong : OrderType.CloseShort);
  return { ...desc, pricePNS: toPriceUnits(o.market, o.worstPrice), lotLNS: toSizeUnits(o.market, o.size), immediateOrCancel: true };
}

/** A resting limit order, post-only unless `postOnly` is false. */
export function limitOrder(o: Omit<MarketOrderInput, "worstPrice"> & { price: number; postOnly?: boolean }): OrderDesc {
  const desc = blank(o.market, o.requestId, o.side === "long" ? OrderType.OpenLong : OrderType.OpenShort);
  return {
    ...desc,
    pricePNS: toPriceUnits(o.market, o.price),
    lotLNS: toSizeUnits(o.market, o.size),
    postOnly: o.postOnly ?? true,
    leverageHdths: BigInt(Math.round(o.leverage * 100)),
  };
}

export function cancelOrder(market: PerplMarket, requestId: bigint, orderId: bigint): OrderDesc {
  return { ...blank(market, requestId, OrderType.Cancel), orderId };
}

/** The worst acceptable price for a market order `slippageBps` away from `reference`. */
export function worstPrice(side: "long" | "short", reference: number, slippageBps: number): number {
  return side === "long" ? reference * (1 + slippageBps / 10_000) : reference * (1 - slippageBps / 10_000);
}

export const encodeExecOrder = (desc: OrderDesc): Hex => encodeFunctionData({ abi: exchangeAbi, functionName: "execOrder", args: [desc] });

/** Several orders in one transaction; with `revertOnFail` false a failing order is skipped. */
export const encodeExecOrders = (descs: readonly OrderDesc[], revertOnFail: boolean): Hex =>
  encodeFunctionData({ abi: exchangeAbi, functionName: "execOrders", args: [descs, revertOnFail] });

/**
 * The V2 order extension that attributes an order to a builder code, with its fee in units of
 * 0.1 basis points (per 100k): abi.encode(uint16 version 1, abi.encode(builderId, fee)).
 */
export function builderExtension(builderId: number, feePer100k: number): Hex {
  if (builderId < 1 || builderId > 255) throw new Error("builder id must be 1..255");
  if (feePer100k < 0 || feePer100k > 1000) throw new Error("builder fee must be 0..1000 per 100k");
  const payload = encodeAbiParameters([{ type: "uint256" }, { type: "uint256" }], [BigInt(builderId), BigInt(feePer100k)]);
  return encodeAbiParameters([{ type: "uint16" }, { type: "bytes" }], [1, payload]);
}

export const encodeExecOrderV2 = (desc: OrderDesc, extension: Hex): Hex =>
  encodeFunctionData({ abi: exchangeAbi, functionName: "execOrderV2", args: [desc, extension] });

/** A call from a Trendr account, in the shape PasskeyAccount batches take. */
export interface ExchangeCall {
  target: Address;
  value: bigint;
  data: Hex;
}

/**
 * Opening a Perpl account: approve exactly `amount` of AUSD and create the account with it, then
 * allow Perpl to forward API orders for it.
 */
export function openAccountCalls(exchange: Address, collateral: Address, amount: bigint, allowForwarding: boolean): ExchangeCall[] {
  const calls: ExchangeCall[] = [
    { target: collateral, value: 0n, data: encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [exchange, amount] }) },
    { target: exchange, value: 0n, data: encodeFunctionData({ abi: exchangeAbi, functionName: "createAccount", args: [amount] }) },
  ];
  if (allowForwarding) {
    calls.push({ target: exchange, value: 0n, data: encodeFunctionData({ abi: exchangeAbi, functionName: "allowOrderForwarding", args: [true] }) });
  }
  return calls;
}

/** Adding AUSD to an existing Perpl account. */
export function depositCalls(exchange: Address, collateral: Address, amount: bigint): ExchangeCall[] {
  return [
    { target: collateral, value: 0n, data: encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [exchange, amount] }) },
    { target: exchange, value: 0n, data: encodeFunctionData({ abi: exchangeAbi, functionName: "depositCollateral", args: [amount] }) },
  ];
}

/** Withdrawing AUSD from the Perpl account back to the Trendr account (owner only). */
export function withdrawCall(exchange: Address, amount: bigint): ExchangeCall {
  return { target: exchange, value: 0n, data: encodeFunctionData({ abi: exchangeAbi, functionName: "withdrawCollateral", args: [amount] }) };
}

export const tradeCall = (exchange: Address, desc: OrderDesc): ExchangeCall => ({ target: exchange, value: 0n, data: encodeExecOrder(desc) });
