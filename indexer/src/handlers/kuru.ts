import { indexer, type KuruFill, type KuruMarket, type Token } from "envio";
import {
  type Context,
  type Product,
  recordAccountTrade,
  recordFees,
  recordMarketVolume,
  updateAccount,
} from "../lib/aggregates";
import { applyTokenTrade } from "../lib/book";
import { BPS, chainConstants, isContract, KURU_PRICE_DECIMALS } from "../lib/constants";
import { eventId, timestampOf, WITH_TIME, WITH_TX } from "../lib/events";
import { markInfrastructure, recordKuruMarket } from "../lib/markets";
import { ausd, toDecimal } from "../lib/units";

const spotProduct = (token: Token): Product => (token.kind === "TREND_COIN" ? "coinSpot" : "outcomeSpot");

/** AUSD per token for a quote and base amount in raw units. */
function averagePrice(quote: bigint, base: bigint, baseDecimals: number) {
  if (base === 0n) return toDecimal(0n, 0);
  return ausd(quote).div(toDecimal(base, baseDecimals)).decimalPlaces(18);
}

/** Books one side of a spot trade for an account: volume, Kuru fee and position book. */
async function bookSpotTrade(
  context: Context,
  account: string,
  token: Token,
  isBuy: boolean,
  base: bigint,
  quote: bigint,
  fee: bigint,
  timestamp: bigint,
): Promise<void> {
  await recordAccountTrade(context, {
    account,
    trendId: token.trend_id,
    product: spotProduct(token),
    amount: quote,
    timestamp,
  });
  await recordFees(context, account, fee, timestamp);
  await applyTokenTrade(
    context,
    account,
    { token, isBuy, qty: base, quote: isBuy ? quote + fee : quote - fee },
    timestamp,
  );
}

// ---------------------------------------------------------------------------------------------
// Market discovery
// ---------------------------------------------------------------------------------------------

indexer.onEvent(
  { contract: "KuruRouter", event: "MarketRegistered", fields: WITH_TIME },
  async ({ event, context }) => {
    const p = event.params;
    const registration = {
      id: p.market,
      baseAsset: p.baseAsset,
      quoteAsset: p.quoteAsset,
      vault: p.vaultAddress,
      pricePrecision: p.pricePrecision,
      sizePrecision: p.sizePrecision,
      tickSize: p.tickSize,
      minSize: p.minSize,
      maxSize: p.maxSize,
      takerFeeBps: Number(p.takerFeeBps),
      makerFeeBps: Number(p.makerFeeBps),
    };
    context.KuruMarketRegistration.set(registration);
    const token = await context.Token.get(p.baseAsset);
    if (!token) return;
    // A Trendr token's market: its vault is seeded right after, so mark it before any transfer.
    const timestamp = timestampOf(event);
    await markInfrastructure(context, p.vaultAddress, timestamp);
    const market = await context.KuruMarket.get(p.market);
    if (market) {
      const { id: _id, baseAsset: _base, quoteAsset: _quote, ...params } = registration;
      context.KuruMarket.set({ ...market, ...params, quoteToken: p.quoteAsset });
    }
  },
);

indexer.contractRegister({ contract: "OutcomeListing", event: "MarketRecorded" }, async ({ event, context }) => {
  context.chain.KuruOrderBook.add(event.params.market);
});

indexer.onEvent(
  { contract: "OutcomeListing", event: "MarketRecorded", fields: WITH_TIME },
  async ({ event, context }) => {
    const { token: tokenAddress, market, deployed } = event.params;
    const token = await context.Token.get(tokenAddress);
    if (!token) return;
    await recordKuruMarket(context, {
      market,
      token,
      quoteToken:
        (await context.KuruMarketRegistration.get(market))?.quoteAsset ?? chainConstants(context.chain.id).ausd ?? "",
      deployedByTrendr: deployed,
      timestamp: timestampOf(event),
      blockNumber: event.block.number,
    });
  },
);

// ---------------------------------------------------------------------------------------------
// Order book activity
// ---------------------------------------------------------------------------------------------

indexer.onEvent({ contract: "KuruOrderBook", event: "OrderCreated", fields: WITH_TX }, async ({ event, context }) => {
  const market = await context.KuruMarket.get(event.srcAddress);
  if (!market) return;
  const { orderId, owner, size, price, isBuy } = event.params;
  const timestamp = timestampOf(event);
  await updateAccount(context, owner, timestamp, () => ({}));
  context.KuruOrder.set({
    id: `${market.id}-${orderId}`,
    market_id: market.id,
    orderId,
    owner_id: owner,
    isBuy,
    price,
    priceAusd: toDecimal(price, 0).div(market.pricePrecision.toString()),
    size,
    remaining: size,
    filled: 0n,
    status: "OPEN",
    createdAt: timestamp,
    createdBlock: event.block.number,
    updatedAt: timestamp,
    txHash: event.transaction.hash,
  });
  context.KuruMarket.set({ ...market, openOrderCount: market.openOrderCount + 1 });
});

async function cancelOrder(context: Context, market: KuruMarket, orderId: bigint, timestamp: bigint): Promise<boolean> {
  const order = await context.KuruOrder.get(`${market.id}-${orderId}`);
  if (!order || order.status !== "OPEN") return false;
  context.KuruOrder.set({ ...order, status: "CANCELED", updatedAt: timestamp });
  return true;
}

indexer.onEvent(
  { contract: "KuruOrderBook", event: "OrderCanceled", fields: WITH_TIME },
  async ({ event, context }) => {
    const market = await context.KuruMarket.get(event.srcAddress);
    if (!market) return;
    if (await cancelOrder(context, market, event.params.orderId, timestampOf(event))) {
      context.KuruMarket.set({ ...market, openOrderCount: market.openOrderCount - 1 });
    }
  },
);

// Emitted after the per-order OrderCanceled events, or alone by older implementations.
indexer.onEvent(
  { contract: "KuruOrderBook", event: "OrdersCanceled", fields: WITH_TIME },
  async ({ event, context }) => {
    const market = await context.KuruMarket.get(event.srcAddress);
    if (!market) return;
    const timestamp = timestampOf(event);
    let canceled = 0;
    for (const orderId of event.params.orderId) {
      if (await cancelOrder(context, market, orderId, timestamp)) canceled++;
    }
    if (canceled > 0) context.KuruMarket.set({ ...market, openOrderCount: market.openOrderCount - canceled });
  },
);

indexer.onEvent({ contract: "KuruOrderBook", event: "Trade", fields: WITH_TX }, async ({ event, context }) => {
  const market = await context.KuruMarket.get(event.srcAddress);
  if (!market) return;
  const token = await context.Token.get(market.baseToken_id);
  if (!token) return;
  const { orderId, makerAddress, isBuy, price, updatedSize, takerAddress, txOrigin, filledSize } = event.params;
  const timestamp = timestampOf(event);
  const txHash = event.transaction.hash;

  // price is 1e18-scaled AUSD per whole token; size is in sizePrecision units.
  const baseUnit = 10n ** BigInt(market.baseDecimals);
  const baseAmount = (filledSize * baseUnit) / market.sizePrecision;
  const quoteAmount =
    (price * baseAmount * 10n ** BigInt(market.quoteDecimals)) / (10n ** BigInt(KURU_PRICE_DECIMALS) * baseUnit);
  const isVaultFill = orderId === 0n;
  const routed = isContract(context.chain.id, "KuruRouter", takerAddress);
  const id = eventId(event);

  let openOrders = market.openOrderCount;
  let orderRef: string | undefined;
  if (!isVaultFill) {
    const order = await context.KuruOrder.get(`${market.id}-${orderId}`);
    if (order) {
      orderRef = order.id;
      const status = updatedSize === 0n ? "FILLED" : order.status;
      if (order.status === "OPEN" && status === "FILLED") openOrders--;
      context.KuruOrder.set({
        ...order,
        remaining: updatedSize,
        filled: order.filled + filledSize,
        status,
        updatedAt: timestamp,
      });
    }
  }

  const fill: KuruFill = {
    id,
    market_id: market.id,
    trend_id: market.trend_id,
    series_id: market.series_id,
    token_id: token.id,
    order_id: orderRef,
    makerOrderId: orderId,
    maker: makerAddress,
    makerAccount_id: isVaultFill ? undefined : makerAddress,
    isVaultFill,
    taker: takerAddress,
    trader_id: routed ? undefined : takerAddress,
    txOrigin,
    takerIsBuy: isBuy,
    price,
    priceAusd: toDecimal(price, KURU_PRICE_DECIMALS),
    size: filledSize,
    baseAmount,
    baseTokens: toDecimal(baseAmount, market.baseDecimals),
    quoteAmount,
    quoteAusd: ausd(quoteAmount),
    makerRemaining: updatedSize,
    swap_id: undefined,
    blockNumber: event.block.number,
    timestamp,
    txHash,
  };
  context.KuruFill.set(fill);

  const volumeBase = market.volumeBase + baseAmount;
  const volumeQuote = market.volumeQuote + quoteAmount;
  context.KuruMarket.set({
    ...market,
    volumeBase,
    volumeBaseTokens: toDecimal(volumeBase, market.baseDecimals),
    volumeQuote,
    volumeAusd: ausd(volumeQuote),
    fillCount: market.fillCount + 1,
    lastPrice: price,
    lastPriceAusd: fill.priceAusd,
    lastTradeAt: timestamp,
    openOrderCount: openOrders,
  });
  if (market.series_id) {
    const series = await context.Series.get(market.series_id);
    if (series) context.Series.set({ ...series, spotVolume: series.spotVolume + quoteAmount });
  }
  await recordMarketVolume(context, {
    trendId: market.trend_id,
    product: spotProduct(token),
    amount: quoteAmount,
    timestamp,
  });

  if (!isVaultFill) {
    const makerFee = (quoteAmount * BigInt(market.makerFeeBps)) / BPS;
    await bookSpotTrade(context, makerAddress, token, !isBuy, baseAmount, quoteAmount, makerFee, timestamp);
  }
  if (routed) {
    // The Router took the liquidity; the swap event later in this transaction names the trader.
    const pending = await context.PendingRoute.get(txHash);
    context.PendingRoute.set({ id: txHash, fillIds: [...(pending?.fillIds ?? []), id] });
  } else {
    const takerFee = (quoteAmount * BigInt(market.takerFeeBps)) / BPS;
    await bookSpotTrade(context, takerAddress, token, isBuy, baseAmount, quoteAmount, takerFee, timestamp);
  }
});

// ---------------------------------------------------------------------------------------------
// Swaps: attribute routed fills to the account that swapped
// ---------------------------------------------------------------------------------------------

interface SwapInput {
  id: string;
  source: "TRENDR_SPOT" | "KURU_ROUTER";
  trader: string;
  market: KuruMarket;
  token: Token;
  isBuy: boolean;
  amountIn: bigint;
  amountOut: bigint;
  base: bigint;
  quote: bigint;
  recipient: string;
  fillIds: readonly string[];
  blockNumber: number;
  timestamp: bigint;
  txHash: string;
}

async function recordSwap(context: Context, s: SwapInput): Promise<void> {
  context.SpotSwap.set({
    id: s.id,
    source: s.source,
    trader_id: s.trader,
    token_id: s.token.id,
    market_id: s.market.id,
    trend_id: s.market.trend_id,
    isBuy: s.isBuy,
    amountIn: s.amountIn,
    amountOut: s.amountOut,
    baseAmount: s.base,
    quoteAmount: s.quote,
    priceAusd: averagePrice(s.quote, s.base, s.token.decimals),
    recipient: s.recipient,
    blockNumber: s.blockNumber,
    timestamp: s.timestamp,
    txHash: s.txHash,
  });
  for (const fillId of s.fillIds) {
    const fill = await context.KuruFill.get(fillId);
    if (fill && fill.market_id === s.market.id) context.KuruFill.set({ ...fill, trader_id: s.trader, swap_id: s.id });
  }
  // Swap amounts are what the trader actually paid and received, Kuru's fee included.
  await bookSpotTrade(context, s.trader, s.token, s.isBuy, s.base, s.quote, 0n, s.timestamp);
}

indexer.onEvent({ contract: "TrendrSpot", event: "Swapped", fields: WITH_TX }, async ({ event, context }) => {
  const { trader, token: tokenAddress, market: marketAddress, isBuy, amountIn, amountOut, to } = event.params;
  const [market, token, pending] = await Promise.all([
    context.KuruMarket.get(marketAddress),
    context.Token.get(tokenAddress),
    context.PendingRoute.get(event.transaction.hash),
  ]);
  if (!market || !token) return;
  await recordSwap(context, {
    id: eventId(event),
    source: "TRENDR_SPOT",
    trader,
    market,
    token,
    isBuy,
    amountIn,
    amountOut,
    base: isBuy ? amountOut : amountIn,
    quote: isBuy ? amountIn : amountOut,
    recipient: to,
    fillIds: pending?.fillIds ?? [],
    blockNumber: event.block.number,
    timestamp: timestampOf(event),
    txHash: event.transaction.hash,
  });
  if (pending) context.PendingRoute.deleteUnsafe(pending.id);
});

indexer.onEvent({ contract: "KuruRouter", event: "KuruRouterSwap", fields: WITH_TX }, async ({ event, context }) => {
  const { msgSender, debitToken, creditToken, amountIn, amountOut } = event.params;
  // TrendrSpot's own Swapped event, emitted next, names the real trader.
  if (isContract(context.chain.id, "TrendrSpot", msgSender)) return;
  const pending = await context.PendingRoute.get(event.transaction.hash);
  if (!pending) return;

  // Group the routed fills per market: a multi-hop route can cross more than one Trendr book.
  const fills = (await Promise.all(pending.fillIds.map((id) => context.KuruFill.get(id)))).filter(
    (f): f is KuruFill => f !== undefined,
  );
  const byMarket = new Map<string, KuruFill[]>();
  for (const fill of fills) byMarket.set(fill.market_id, [...(byMarket.get(fill.market_id) ?? []), fill]);

  const timestamp = timestampOf(event);
  let leg = 0;
  for (const [marketId, legFills] of byMarket) {
    const market = await context.KuruMarket.get(marketId);
    const token = market && (await context.Token.get(market.baseToken_id));
    const first = legFills[0];
    if (!market || !token || !first) continue;
    const isBuy = first.takerIsBuy;
    // A single-hop swap against AUSD carries the exact amounts; otherwise sum the fills.
    const direct =
      byMarket.size === 1 &&
      (isBuy
        ? creditToken === token.id && debitToken === market.quoteToken
        : debitToken === token.id && creditToken === market.quoteToken);
    const base = direct ? (isBuy ? amountOut : amountIn) : legFills.reduce((a, f) => a + f.baseAmount, 0n);
    const quote = direct ? (isBuy ? amountIn : amountOut) : legFills.reduce((a, f) => a + f.quoteAmount, 0n);
    await recordSwap(context, {
      id: `${eventId(event)}-${leg++}`,
      source: "KURU_ROUTER",
      trader: msgSender,
      market,
      token,
      isBuy,
      amountIn,
      amountOut,
      base,
      quote,
      recipient: msgSender,
      fillIds: legFills.map((f) => f.id),
      blockNumber: event.block.number,
      timestamp,
      txHash: event.transaction.hash,
    });
  }
  context.PendingRoute.deleteUnsafe(pending.id);
});
