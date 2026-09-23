import { type Curve, type Graduation, indexer } from "envio";
import { type Context, recordAccountTrade, recordFees, recordMarketVolume, updateProtocol } from "../lib/aggregates";
import { applyCoinTrade } from "../lib/book";
import { AUSD_DECIMALS, COIN_DECIMALS, CURVE_VIRTUAL_TOKENS } from "../lib/constants";
import { eventId, timestampOf, WITH_TIME, WITH_TX } from "../lib/events";
import { recordKuruMarket } from "../lib/markets";
import { ausd, toDecimal } from "../lib/units";

/** Spot price of the curve, AUSD per coin: (virtualQuote + reserve) / (virtualTokens - sold). */
function spotPrice(virtualQuote: bigint, reserve: bigint, sold: bigint) {
  return toDecimal(virtualQuote + reserve, AUSD_DECIMALS)
    .div(toDecimal(CURVE_VIRTUAL_TOKENS - sold, COIN_DECIMALS))
    .decimalPlaces(18);
}

async function updateCurve(
  context: Context,
  trendId: string,
  change: (c: Curve) => Partial<Curve>,
): Promise<Curve | undefined> {
  const curve = await context.Curve.get(trendId);
  if (!curve) return undefined;
  const next = { ...curve, ...change(curve) };
  context.Curve.set({
    ...next,
    reserveAusd: ausd(next.reserve),
    spotPriceAusd: spotPrice(next.virtualQuote, next.reserve, next.sold),
  });
  return next;
}

async function loadGraduation(context: Context, trendId: string): Promise<Graduation> {
  return context.Graduation.getOrCreate({
    id: trendId,
    curve_id: trendId,
    trend_id: trendId,
    readyAt: undefined,
    readyReserve: undefined,
    pending: false,
    market_id: undefined,
    vault: undefined,
    coinAmount: undefined,
    quoteAmount: undefined,
    vaultShares: undefined,
    graduatedAt: undefined,
    graduatedBlock: undefined,
    txHash: undefined,
  });
}

indexer.contractRegister({ contract: "BondingCurve", event: "CurveCreated" }, async ({ event, context }) => {
  context.chain.TrendrToken.add(event.params.coin);
});

indexer.onEvent({ contract: "BondingCurve", event: "CurveCreated", fields: WITH_TIME }, async ({ event, context }) => {
  const { trendId, coin, virtualQuote, peakAtCreation } = event.params;
  const timestamp = timestampOf(event);
  context.Token.set({
    id: coin,
    kind: "TREND_COIN",
    trend_id: trendId,
    series_id: undefined,
    decimals: COIN_DECIMALS,
    totalSupply: 0n,
    holderCount: 0,
    market_id: undefined,
    createdAt: timestamp,
  });
  context.Curve.set({
    id: trendId,
    trend_id: trendId,
    coin_id: coin,
    state: "OPEN",
    virtualQuote,
    reserve: 0n,
    reserveAusd: ausd(0n),
    sold: 0n,
    peakAtCreation,
    ratchetBps: 10_000n,
    floorRaiseCount: 0,
    spotPriceAusd: spotPrice(virtualQuote, 0n, 0n),
    buyVolume: 0n,
    sellVolume: 0n,
    feesCollected: 0n,
    tradeCount: 0,
    market_id: undefined,
    graduation_id: undefined,
    createdAt: timestamp,
    createdBlock: event.block.number,
  });
  const trend = await context.Trend.get(trendId);
  if (trend) context.Trend.set({ ...trend, curve_id: trendId });
  await updateProtocol(context, timestamp, (p) => ({ curveCount: p.curveCount + 1 }));
});

indexer.onEvent({ contract: "BondingCurve", event: "Trade", fields: WITH_TX }, async ({ event, context }) => {
  const { trendId, trader, isBuy, quoteAmount, coinAmount, fee, reserve, sold } = event.params;
  const timestamp = timestampOf(event);
  // Buys report AUSD paid with the fee; sells report AUSD received after it.
  const gross = isBuy ? quoteAmount : quoteAmount + fee;
  const curve = await updateCurve(context, trendId, (c) => ({
    reserve,
    sold,
    buyVolume: isBuy ? c.buyVolume + gross : c.buyVolume,
    sellVolume: isBuy ? c.sellVolume : c.sellVolume + gross,
    feesCollected: c.feesCollected + fee,
    tradeCount: c.tradeCount + 1,
  }));
  if (!curve) return;
  context.CurveTrade.set({
    id: eventId(event),
    curve_id: trendId,
    trend_id: trendId,
    trader_id: trader,
    isBuy,
    quoteAmount,
    quoteAusd: ausd(quoteAmount),
    coinAmount,
    coinTokens: toDecimal(coinAmount, COIN_DECIMALS),
    fee,
    priceAusd:
      coinAmount === 0n
        ? toDecimal(0n, 0)
        : ausd(quoteAmount).div(toDecimal(coinAmount, COIN_DECIMALS)).decimalPlaces(18),
    reserveAfter: reserve,
    soldAfter: sold,
    blockNumber: event.block.number,
    timestamp,
    txHash: event.transaction.hash,
  });
  await recordMarketVolume(context, { trendId, product: "curve", amount: gross, timestamp });
  await recordAccountTrade(context, { account: trader, trendId, product: "curve", amount: gross, timestamp });
  await recordFees(context, trader, fee, timestamp);
  const coin = await context.Token.get(curve.coin_id);
  if (coin)
    await applyCoinTrade(context, trader, { token: coin, isBuy, qty: coinAmount, quote: quoteAmount }, timestamp);
});

indexer.onEvent({ contract: "BondingCurve", event: "FloorRaised", fields: WITH_TIME }, async ({ event, context }) => {
  const { trendId, virtualQuote, cost, ratchetBps } = event.params;
  // The raise moves `cost` from the floor reserve into the trading reserve.
  await updateCurve(context, trendId, (c) => ({
    virtualQuote,
    reserve: c.reserve + cost,
    ratchetBps,
    floorRaiseCount: c.floorRaiseCount + 1,
  }));
});

indexer.onEvent(
  { contract: "BondingCurve", event: "GraduationReady", fields: WITH_TIME },
  async ({ event, context }) => {
    const { trendId, reserve } = event.params;
    const curve = await updateCurve(context, trendId, () => ({ state: "READY", graduation_id: trendId }));
    if (!curve) return;
    const graduation = await loadGraduation(context, trendId);
    context.Graduation.set({ ...graduation, readyAt: timestampOf(event), readyReserve: reserve });
  },
);

indexer.contractRegister({ contract: "BondingCurve", event: "Graduated" }, async ({ event, context }) => {
  context.chain.KuruOrderBook.add(event.params.market);
});

indexer.onEvent({ contract: "BondingCurve", event: "Graduated", fields: WITH_TX }, async ({ event, context }) => {
  const { trendId, market, coinAmount, quoteAmount } = event.params;
  const timestamp = timestampOf(event);
  // The venue listed the market earlier in this transaction; Listed recorded it.
  const curve = await updateCurve(context, trendId, () => ({
    state: "GRADUATED",
    reserve: 0n,
    market_id: market,
    graduation_id: trendId,
  }));
  if (!curve) return;
  const graduation = await loadGraduation(context, trendId);
  context.Graduation.set({
    ...graduation,
    pending: false,
    market_id: market,
    coinAmount,
    quoteAmount,
    graduatedAt: timestamp,
    graduatedBlock: event.block.number,
    txHash: event.transaction.hash,
  });
  await updateProtocol(context, timestamp, (p) => ({ graduationCount: p.graduationCount + 1 }));
});

// ---------------------------------------------------------------------------------------------
// Kuru graduation venue
// ---------------------------------------------------------------------------------------------

indexer.onEvent(
  { contract: "KuruGraduationVenue", event: "ListingPending", fields: WITH_TIME },
  async ({ event, context }) => {
    const coin = await context.Token.get(event.params.base);
    if (!coin || coin.kind !== "TREND_COIN") return;
    const graduation = await loadGraduation(context, coin.trend_id);
    context.Graduation.set({ ...graduation, pending: true });
  },
);

indexer.contractRegister({ contract: "KuruGraduationVenue", event: "Listed" }, async ({ event, context }) => {
  context.chain.KuruOrderBook.add(event.params.market);
});

indexer.onEvent({ contract: "KuruGraduationVenue", event: "Listed", fields: WITH_TIME }, async ({ event, context }) => {
  const { base, quote, market, vault, shares } = event.params;
  const coin = await context.Token.get(base);
  if (!coin || coin.kind !== "TREND_COIN") return;
  await recordKuruMarket(context, {
    market,
    token: coin,
    quoteToken: quote,
    deployedByTrendr: true,
    timestamp: timestampOf(event),
    blockNumber: event.block.number,
  });
  const graduation = await loadGraduation(context, coin.trend_id);
  context.Graduation.set({ ...graduation, pending: false, market_id: market, vault, vaultShares: shares });
});
