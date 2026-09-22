import { indexer, type PerpPosition, type TrendStats } from "envio";
import {
  type Context,
  recordAccountTrade,
  recordClosedTrade,
  recordFees,
  recordMarketVolume,
  recordRealizedPnl,
  updateAccount,
  updateProtocol,
  updateTrendDay,
  updateTrendStats,
} from "../lib/aggregates";
import { eventId, timestampOf, WITH_TIME, WITH_TX } from "../lib/events";
import { fundingRate, notional } from "../lib/perpMath";
import { ausd, points } from "../lib/units";

/** Open interest fields for the given side quantities at `mark`. */
function openInterest(longQty: bigint, shortQty: bigint, mark: bigint | undefined): Partial<TrendStats> {
  const long = mark === undefined ? 0n : notional(longQty, mark);
  const short = mark === undefined ? 0n : notional(shortQty, mark);
  return {
    perpLongQty: longQty,
    perpShortQty: shortQty,
    perpLongOpenInterest: long,
    perpShortOpenInterest: short,
    perpLongOpenInterestAusd: ausd(long),
    perpShortOpenInterestAusd: ausd(short),
    perpFundingRatePerBlock: fundingRate(longQty, shortQty),
  };
}

/** Moves a trend's open contracts by `delta` on one side and refreshes open interest. */
async function changeOpenInterest(
  context: Context,
  trendId: string,
  isLong: boolean,
  delta: bigint,
  positions: number,
  timestamp: bigint,
): Promise<void> {
  const stats = await updateTrendStats(context, trendId, timestamp, (s) => {
    const longQty = isLong ? s.perpLongQty + delta : s.perpLongQty;
    const shortQty = isLong ? s.perpShortQty : s.perpShortQty + delta;
    return {
      ...openInterest(longQty, shortQty, s.perpMark),
      perpOpenPositionCount: s.perpOpenPositionCount + positions,
    };
  });
  await updateTrendDay(context, trendId, timestamp, () => ({
    perpLongOpenInterest: stats.perpLongOpenInterest,
    perpShortOpenInterest: stats.perpShortOpenInterest,
  }));
  await updateProtocol(context, timestamp, (p) => ({ perpOpenPositionCount: p.perpOpenPositionCount + positions }));
}

/** Cash the owner put into a position: net margin, top ups and the open fee. */
const cashIn = (p: PerpPosition): bigint => p.margin + p.openFee;

/** Closes a position's books: open interest, the owner's portfolio and track record. */
async function settlePosition(
  context: Context,
  position: PerpPosition,
  exitIndex: bigint,
  payout: bigint,
  closeFee: bigint,
  liquidated: boolean,
  timestamp: bigint,
): Promise<bigint> {
  const realizedPnl = payout - cashIn(position);
  const exitNotional = notional(position.qty, exitIndex);
  await changeOpenInterest(context, position.trend_id, position.isLong, -position.qty, -1, timestamp);
  await updateAccount(context, position.owner_id, timestamp, (a) => ({
    perpOpenPositionCount: a.perpOpenPositionCount - 1,
    perpMarginLocked: a.perpMarginLocked - position.margin,
    perpOpenNotional: a.perpOpenNotional - position.notional,
  }));
  await recordMarketVolume(context, { trendId: position.trend_id, product: "perp", amount: exitNotional, timestamp });
  await recordAccountTrade(context, {
    account: position.owner_id,
    trendId: position.trend_id,
    product: "perp",
    amount: exitNotional,
    timestamp,
  });
  await recordFees(context, position.owner_id, closeFee, timestamp);
  await recordRealizedPnl(context, {
    account: position.owner_id,
    trendId: position.trend_id,
    product: "perp",
    pnl: realizedPnl,
    timestamp,
  });
  await recordClosedTrade(context, position.owner_id, realizedPnl, timestamp, liquidated);
  return realizedPnl;
}

indexer.onEvent({ contract: "AttentionPerp", event: "Poked", fields: WITH_TX }, async ({ event, context }) => {
  const { trendId, mark, cumLong, cumShort } = event.params;
  const timestamp = timestampOf(event);
  const stats = await updateTrendStats(context, trendId, timestamp, (s) => ({
    ...openInterest(s.perpLongQty, s.perpShortQty, mark),
    perpMark: mark,
  }));
  context.FundingMark.set({
    id: eventId(event),
    trend_id: trendId,
    mark,
    markPoints: points(mark),
    cumLong,
    cumShort,
    // A poke runs before the position change of the same call, so these are the quantities that
    // accrued funding up to this mark.
    fundingRatePerBlock: stats.perpFundingRatePerBlock,
    longQty: stats.perpLongQty,
    shortQty: stats.perpShortQty,
    blockNumber: event.block.number,
    timestamp,
    txHash: event.transaction.hash,
  });
  await updateTrendDay(context, trendId, timestamp, (d) => ({
    perpLongOpenInterest: stats.perpLongOpenInterest,
    perpShortOpenInterest: stats.perpShortOpenInterest,
    fundingMarkCount: d.fundingMarkCount + 1,
  }));
});

indexer.onEvent({ contract: "AttentionPerp", event: "PositionOpened", fields: WITH_TX }, async ({ event, context }) => {
  const { id, owner, trendId, isLong, qty, margin, entryIndex, fee, payer } = event.params;
  const timestamp = timestampOf(event);
  const entryNotional = notional(qty, entryIndex);
  context.PerpPosition.set({
    id: id.toString(),
    positionId: id,
    owner_id: owner,
    payer,
    trend_id: trendId,
    isLong,
    status: "OPEN",
    qty,
    entryIndex,
    entryIndexPoints: points(entryIndex),
    margin,
    marginAusd: ausd(margin),
    marginAdded: 0n,
    openFee: fee,
    notional: entryNotional,
    openedAt: timestamp,
    openedBlock: event.block.number,
    openTxHash: event.transaction.hash,
    exitIndex: undefined,
    exitIndexPoints: undefined,
    pnl: undefined,
    funding: undefined,
    closeFee: undefined,
    payout: undefined,
    liquidationEquity: undefined,
    liquidator: undefined,
    liquidationReward: undefined,
    socializedLoss: 0n,
    realizedPnl: undefined,
    realizedPnlAusd: undefined,
    closedAt: undefined,
    closedBlock: undefined,
    closeTxHash: undefined,
  });
  await changeOpenInterest(context, trendId, isLong, qty, 1, timestamp);
  await updateAccount(context, owner, timestamp, (a) => ({
    perpOpenPositionCount: a.perpOpenPositionCount + 1,
    perpMarginLocked: a.perpMarginLocked + margin,
    perpOpenNotional: a.perpOpenNotional + entryNotional,
  }));
  await recordMarketVolume(context, { trendId, product: "perp", amount: entryNotional, timestamp });
  await recordAccountTrade(context, { account: owner, trendId, product: "perp", amount: entryNotional, timestamp });
  await recordFees(context, owner, fee, timestamp);
});

indexer.onEvent({ contract: "AttentionPerp", event: "MarginAdded", fields: WITH_TIME }, async ({ event, context }) => {
  const { id, amount } = event.params;
  const position = await context.PerpPosition.get(id.toString());
  if (!position || position.status !== "OPEN") return;
  const margin = position.margin + amount;
  context.PerpPosition.set({
    ...position,
    margin,
    marginAusd: ausd(margin),
    marginAdded: position.marginAdded + amount,
  });
  await updateAccount(context, position.owner_id, timestampOf(event), (a) => ({
    perpMarginLocked: a.perpMarginLocked + amount,
  }));
});

indexer.onEvent(
  { contract: "AttentionPerp", event: "SocializedLoss", fields: WITH_TIME },
  async ({ event, context }) => {
    const position = await context.PerpPosition.get(event.params.id.toString());
    if (position)
      context.PerpPosition.set({ ...position, socializedLoss: position.socializedLoss + event.params.shortfall });
  },
);

indexer.onEvent({ contract: "AttentionPerp", event: "PositionClosed", fields: WITH_TX }, async ({ event, context }) => {
  const { id, exitIndex, pnl, funding, fee, payout } = event.params;
  const position = await context.PerpPosition.get(id.toString());
  if (!position || position.status !== "OPEN") return;
  const timestamp = timestampOf(event);
  const realizedPnl = await settlePosition(context, position, exitIndex, payout, fee, false, timestamp);
  const latest = (await context.PerpPosition.get(position.id)) ?? position;
  context.PerpPosition.set({
    ...latest,
    status: "CLOSED",
    exitIndex,
    exitIndexPoints: points(exitIndex),
    pnl,
    funding,
    closeFee: fee,
    payout,
    realizedPnl,
    realizedPnlAusd: ausd(realizedPnl),
    closedAt: timestamp,
    closedBlock: event.block.number,
    closeTxHash: event.transaction.hash,
  });
});

indexer.onEvent(
  { contract: "AttentionPerp", event: "PositionLiquidated", fields: WITH_TX },
  async ({ event, context }) => {
    const { id, liquidator, exitIndex, equity, reward } = event.params;
    const position = await context.PerpPosition.get(id.toString());
    if (!position || position.status !== "OPEN") return;
    const timestamp = timestampOf(event);
    // The owner gets nothing back; the liquidator's reward comes out of the remaining equity.
    const realizedPnl = await settlePosition(context, position, exitIndex, 0n, 0n, true, timestamp);
    const latest = (await context.PerpPosition.get(position.id)) ?? position;
    context.PerpPosition.set({
      ...latest,
      status: "LIQUIDATED",
      exitIndex,
      exitIndexPoints: points(exitIndex),
      payout: 0n,
      liquidationEquity: equity,
      liquidator,
      liquidationReward: reward,
      realizedPnl,
      realizedPnlAusd: ausd(realizedPnl),
      closedAt: timestamp,
      closedBlock: event.block.number,
      closeTxHash: event.transaction.hash,
    });
  },
);

indexer.onEvent({ contract: "AttentionPerp", event: "PoolDeposit", fields: WITH_TIME }, async ({ event, context }) => {
  await updateProtocol(context, timestampOf(event), (p) => ({
    perpPoolDeposits: p.perpPoolDeposits + event.params.amount,
  }));
});
