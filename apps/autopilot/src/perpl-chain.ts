import { exchangeAbi, fromPriceUnits, fromSizeUnits, type OrderOutcome, outcomeFromLogs, type PerplMarket, REQUEST_EVENTS } from "@trendr/perpl";
import { type Address, BaseError, ContractFunctionRevertedError, type Hex, type Log, type PublicClient } from "viem";

export { type OrderOutcome, outcomeFromLogs };

/**
 * Perpl as the chain shows it: accounts, positions, mark prices and the outcome of an order. Every
 * order's result is read from the Exchange's events, for the bot (orders forwarded from the API)
 * and for accounts (orders in their own session batches) alike, so fills are exact and no API rate
 * limit applies.
 */

/** Collateral (AUSD) carries 6 decimals on Perpl. */
export const CNS = 1e6;
/** On-chain position types (the API numbers them from 1). */
export const LONG = 0;
export const SHORT = 1;
/** Blocks per eth_getLogs query: some providers' free tiers (Alchemy) allow 10, Monad's RPC 100. */
export const LOG_RANGE = 10n;

export interface ChainHolding {
  side: "long" | "short";
  /** In the market's unit. */
  size: number;
  entryPrice: number;
  /** Margin posted, AUSD. */
  marginAusd: number;
}

/** True for a contract revert, as opposed to an RPC or network failure. */
export function isRevert(e: unknown): boolean {
  if (e instanceof BaseError) {
    let found = false;
    e.walk((x) => {
      if (x instanceof ContractFunctionRevertedError || (x as { code?: number }).code === 3 || /execution reverted/i.test((x as Error).message ?? "")) found = true;
      return false;
    });
    return found;
  }
  return false;
}

export class PerplChain {
  constructor(
    readonly client: PublicClient,
    readonly exchange: Address,
  ) {}

  /** The Perpl account of `owner`, or null when it has none (the Exchange reverts for unknown wallets). */
  async account(owner: Address): Promise<{ id: bigint; balanceAusd: number } | null> {
    let info: unknown;
    try {
      info = await this.client.readContract({ address: this.exchange, abi: exchangeAbi, functionName: "getAccountByAddr", args: [owner] });
    } catch (e) {
      if (isRevert(e)) return null;
      throw e;
    }
    const id = (info as { accountId: bigint }).accountId;
    if (!id) return null;
    return { id, balanceAusd: Number((info as { balanceCNS: bigint }).balanceCNS) / CNS };
  }

  /** Mark prices by market symbol, one multicall. */
  async marks(markets: readonly PerplMarket[]): Promise<Map<string, number>> {
    const results = await this.client.multicall({
      allowFailure: true,
      contracts: markets.map((m) => ({ address: this.exchange, abi: exchangeAbi, functionName: "getPerpetualInfo" as const, args: [BigInt(m.id)] as const })),
    });
    const out = new Map<string, number>();
    markets.forEach((m, i) => {
      const r = results[i];
      if (r?.status === "success") out.set(m.symbol, fromPriceUnits(m, (r.result as { markPNS: bigint }).markPNS));
    });
    return out;
  }

  /** An account's open positions by market symbol (absent when flat), one multicall. */
  async holdings(accountId: bigint, markets: readonly PerplMarket[]): Promise<Map<string, ChainHolding>> {
    const results = await this.client.multicall({
      allowFailure: true,
      contracts: markets.map((m) => ({ address: this.exchange, abi: exchangeAbi, functionName: "getPosition" as const, args: [BigInt(m.id), accountId] as const })),
    });
    const out = new Map<string, ChainHolding>();
    markets.forEach((m, i) => {
      const r = results[i];
      if (r?.status !== "success") return;
      const [p] = r.result as readonly [{ positionType: number; depositCNS: bigint; pricePNS: bigint; lotLNS: bigint }, bigint, boolean];
      if (p.lotLNS === 0n) return;
      out.set(m.symbol, {
        side: p.positionType === SHORT ? "short" : "long",
        size: fromSizeUnits(m, p.lotLNS),
        entryPrice: fromPriceUnits(m, p.pricePNS),
        marginAusd: Number(p.depositCNS) / CNS,
      });
    });
    return out;
  }

  /** The outcome of an order in a known transaction. */
  async outcomeOfTx(txHash: Hex, accountId: bigint, requestId: bigint, market: PerplMarket): Promise<OrderOutcome | null> {
    const receipt = await this.client.getTransactionReceipt({ hash: txHash });
    return outcomeFromLogs(receipt.logs.filter((l) => l.address.toLowerCase() === this.exchange.toLowerCase()), accountId, requestId, market, txHash, receipt.blockNumber);
  }

  /**
   * Looks for an order's request event from `fromBlock` to the head, LOG_RANGE blocks per query,
   * and returns its outcome, or null if it has not landed yet.
   */
  async findOrder(accountId: bigint, requestId: bigint, market: PerplMarket, fromBlock: bigint): Promise<OrderOutcome | null> {
    const head = await this.client.getBlockNumber();
    for (let from = fromBlock; from <= head; from += LOG_RANGE) {
      const to = from + LOG_RANGE - 1n < head ? from + LOG_RANGE - 1n : head;
      const logs = await this.client.getLogs({
        address: this.exchange,
        events: exchangeAbi.filter((x) => x.type === "event" && REQUEST_EVENTS.has(x.name)) as never,
        fromBlock: from,
        toBlock: to,
      });
      for (const l of logs as Array<Log & { args: { accountId?: bigint; orderDescId?: bigint } }>) {
        if (l.args.accountId === accountId && l.args.orderDescId === requestId && l.transactionHash) {
          return this.outcomeOfTx(l.transactionHash, accountId, requestId, market);
        }
      }
    }
    return null;
  }
}
