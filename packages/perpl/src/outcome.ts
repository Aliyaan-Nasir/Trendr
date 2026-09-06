import { decodeEventLog, type Hex, type Log } from "viem";
import { exchangeAbi } from "./exchange-abi";
import { fromPriceUnits, fromSizeUnits, type PerplMarket } from "./market";

/**
 * The outcome of one order, read from the Exchange's events in its transaction: what filled, at
 * what price, the margin, realized PnL and fees, or why it did not fill. Shared by the Autopilot
 * executor and the app so both report fills the same way.
 */

/** Collateral (AUSD) carries 6 decimals on Perpl. */
const CNS = 1e6;

export interface OrderOutcome {
  txHash: Hex;
  blockNumber: bigint;
  /** Filled size in the market's unit; 0 when nothing filled. */
  filled: number;
  /** Entry price for opens, exit price for closes. */
  price: number | null;
  marginAusd: number;
  /** Realized PnL including funding, before fees; closes only. */
  pnlAusd: number;
  feeAusd: number;
  /** Why it did not fill, when the Exchange said. */
  failure: string | null;
}

type Decoded = { eventName: string; args: Record<string, unknown>; logIndex: number };

export const REQUEST_EVENTS: ReadonlySet<string> = new Set(["OrderRequest", "OrderRequestV2"]);
const FAILURE_EVENTS = new Set([
  "OrderPostFailed",
  "OrderSizeExceedsAvailableSize",
  "OrderDescIdTooLow",
  "OrderSettlementImpliesInsolvent",
  "OrderForwardingNotAllowed",
  "PositionDoesNotExist",
  "OrderExtensionRejected",
]);

function decode(logs: readonly Log[]): Decoded[] {
  const out: Decoded[] = [];
  for (const l of logs) {
    try {
      const d = decodeEventLog({ abi: exchangeAbi, data: l.data, topics: l.topics });
      out.push({ eventName: d.eventName, args: (d.args ?? {}) as Record<string, unknown>, logIndex: l.logIndex ?? 0 });
    } catch {
      // Not an Exchange event (token transfers in the same transaction).
    }
  }
  return out.sort((a, b) => a.logIndex - b.logIndex);
}

/**
 * The events of one order: from its request event to the next request (or the end of the
 * transaction). Perpl forwards several accounts' orders in one transaction, so fills without an
 * account id belong to the request they follow.
 */
export function outcomeFromLogs(logs: readonly Log[], accountId: bigint, requestId: bigint, market: PerplMarket, txHash: Hex, blockNumber: bigint): OrderOutcome | null {
  const events = decode(logs);
  const start = events.findIndex((e) => REQUEST_EVENTS.has(e.eventName) && e.args.accountId === accountId && e.args.orderDescId === requestId);
  // The Exchange emits the request before any verdict on it, so an order without one is not here.
  if (start < 0) return null;
  const end = events.findIndex((e, i) => i > start && (REQUEST_EVENTS.has(e.eventName) || e.eventName === "OrderBatchCompleted"));
  const segment = events.slice(start + 1, end < 0 ? undefined : end);
  const out: OrderOutcome = { txHash, blockNumber, filled: 0, price: null, marginAusd: 0, pnlAusd: 0, feeAusd: 0, failure: null };
  let lots = 0n;
  for (const e of segment) {
    const a = e.args;
    const mine = a.accountId === undefined || a.accountId === accountId;
    if (!mine) continue;
    switch (e.eventName) {
      case "TakerOrderFilled":
      case "TakerOrderFilledV2":
        lots += a.lotLNS as bigint;
        out.feeAusd += Number(a.feeCNS as bigint) / CNS;
        break;
      case "PositionOpened":
      case "PositionOpenedV2":
        out.price = fromPriceUnits(market, a.pricePNS as bigint);
        out.marginAusd = Number(a.depositCNS as bigint) / CNS;
        break;
      case "PositionIncreased":
      case "PositionIncreasedV2":
        out.price = fromPriceUnits(market, a.pricePNS as bigint);
        out.marginAusd = Number((a.endDepositCNS as bigint) - (a.startDepositCNS as bigint)) / CNS;
        break;
      case "PositionClosed":
        out.price = fromPriceUnits(market, a.pricePNS as bigint);
        out.pnlAusd += Number((a.deltaPnlCNS as bigint) + (a.fundingCNS as bigint)) / CNS;
        break;
      case "PositionDecreased":
        out.pnlAusd += Number((a.deltaPnlCNS as bigint) + (a.fundingCNS as bigint)) / CNS;
        break;
      default:
        if (FAILURE_EVENTS.has(e.eventName) && !out.failure) out.failure = e.eventName;
    }
  }
  out.filled = fromSizeUnits(market, lots);
  return out;
}
