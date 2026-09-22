import { type Enum, indexer, type Series } from "envio";
import {
  type Context,
  recordAccountTrade,
  recordMarketVolume,
  updateAccount,
  updateProtocol,
  updateTrendStats,
} from "../lib/aggregates";
import { applyOutcomeTrade, type Leg } from "../lib/book";
import { OUTCOME_DECIMALS } from "../lib/constants";
import { timestampOf, WITH_TIME, WITH_TX } from "../lib/events";
import { ausd, points } from "../lib/units";

const OUTCOMES: readonly Enum<"SeriesOutcome">[] = ["OPEN", "UP", "DOWN", "VOID"];

function windowLabel(window: bigint): string {
  if (window === 86_400n) return "24h";
  if (window === 604_800n) return "7d";
  return `${window / 60n}m`;
}

async function updateSeries(
  context: Context,
  seriesId: string,
  change: (s: Series) => Partial<Series>,
): Promise<Series | undefined> {
  const series = await context.Series.get(seriesId);
  if (!series) return undefined;
  const next = { ...series, ...change(series) };
  context.Series.set({ ...next, backingAusd: ausd(next.backing) });
  return next;
}

/** Both sides of a series as book legs, each with its share of `quote`. */
async function seriesLegs(
  context: Context,
  series: Series,
  isBuy: boolean,
  upQty: bigint,
  downQty: bigint,
  upQuote: bigint,
  downQuote: bigint,
): Promise<Leg[]> {
  const [up, down] = await Promise.all([context.Token.get(series.upToken_id), context.Token.get(series.downToken_id)]);
  const legs: Leg[] = [];
  if (up && upQty > 0n) legs.push({ token: up, isBuy, qty: upQty, quote: upQuote });
  if (down && downQty > 0n) legs.push({ token: down, isBuy, qty: downQty, quote: downQuote });
  return legs;
}

indexer.contractRegister({ contract: "OutcomeMarkets", event: "SeriesOpened" }, async ({ event, context }) => {
  context.chain.TrendrToken.add(event.params.up);
  context.chain.TrendrToken.add(event.params.down);
});

indexer.onEvent({ contract: "OutcomeMarkets", event: "SeriesOpened", fields: WITH_TX }, async ({ event, context }) => {
  const { seriesId, trendId, window, openedAt, expiry, openingIndex, up, down } = event.params;
  const timestamp = timestampOf(event);
  for (const [address, kind] of [
    [up, "UP"],
    [down, "DOWN"],
  ] as const) {
    context.Token.set({
      id: address,
      kind,
      trend_id: trendId,
      series_id: seriesId,
      decimals: OUTCOME_DECIMALS,
      totalSupply: 0n,
      holderCount: 0,
      market_id: undefined,
      createdAt: timestamp,
    });
  }
  context.Series.set({
    id: seriesId,
    trend_id: trendId,
    outcomeMarkets: event.srcAddress,
    window: Number(window),
    windowLabel: windowLabel(window),
    openedAt,
    expiry,
    openingIndex,
    openingIndexPoints: points(openingIndex),
    settlementIndex: undefined,
    settlementIndexPoints: undefined,
    outcome: "OPEN",
    settledAt: undefined,
    upToken_id: up,
    downToken_id: down,
    upMarket_id: undefined,
    downMarket_id: undefined,
    minted: 0n,
    redeemed: 0n,
    winningsPaid: 0n,
    backing: 0n,
    backingAusd: ausd(0n),
    mintCount: 0,
    spotVolume: 0n,
    openedBlock: event.block.number,
    txHash: event.transaction.hash,
  });
  await updateTrendStats(context, trendId, timestamp, (s) => ({ seriesCount: s.seriesCount + 1 }));
  await updateProtocol(context, timestamp, (p) => ({ seriesCount: p.seriesCount + 1 }));
});

indexer.onEvent({ contract: "OutcomeMarkets", event: "SetsMinted", fields: WITH_TIME }, async ({ event, context }) => {
  const { seriesId, payer, to, amount } = event.params;
  const timestamp = timestampOf(event);
  const series = await updateSeries(context, seriesId, (s) => ({
    minted: s.minted + amount,
    backing: s.backing + amount,
    mintCount: s.mintCount + 1,
  }));
  if (!series) return;
  await updateAccount(context, payer, timestamp, () => ({}));
  await recordMarketVolume(context, { trendId: series.trend_id, product: "outcomeMint", amount, timestamp });
  // The recipient owns the exposure (it differs from the payer for deposit flows).
  await recordAccountTrade(context, {
    account: to,
    trendId: series.trend_id,
    product: "outcomeMint",
    amount,
    timestamp,
  });
  // A set costs one unit for one UP and one DOWN; the cost is split evenly between the sides.
  const upCost = amount / 2n;
  await applyOutcomeTrade(
    context,
    to,
    await seriesLegs(context, series, true, amount, amount, upCost, amount - upCost),
    timestamp,
  );
});

indexer.onEvent(
  { contract: "OutcomeMarkets", event: "SetsRedeemed", fields: WITH_TIME },
  async ({ event, context }) => {
    const { seriesId, owner, amount } = event.params;
    const timestamp = timestampOf(event);
    const series = await updateSeries(context, seriesId, (s) => ({
      redeemed: s.redeemed + amount,
      backing: s.backing - amount,
    }));
    if (!series) return;
    const upProceeds = amount / 2n;
    await applyOutcomeTrade(
      context,
      owner,
      await seriesLegs(context, series, false, amount, amount, upProceeds, amount - upProceeds),
      timestamp,
    );
  },
);

indexer.onEvent(
  { contract: "OutcomeMarkets", event: "SeriesSettled", fields: WITH_TIME },
  async ({ event, context }) => {
    const { seriesId, outcome, settlementIndex } = event.params;
    const settled = OUTCOMES[Number(outcome)] ?? "VOID";
    await updateSeries(context, seriesId, () => ({
      outcome: settled,
      // A void series has no settlement value.
      settlementIndex: settled === "VOID" ? undefined : settlementIndex,
      settlementIndexPoints: settled === "VOID" ? undefined : points(settlementIndex),
      settledAt: timestampOf(event),
    }));
  },
);

indexer.onEvent(
  { contract: "OutcomeMarkets", event: "WinningsRedeemed", fields: WITH_TIME },
  async ({ event, context }) => {
    const { seriesId, owner, upAmount, downAmount, payout } = event.params;
    const timestamp = timestampOf(event);
    const series = await updateSeries(context, seriesId, (s) => ({
      winningsPaid: s.winningsPaid + payout,
      backing: s.backing - payout,
    }));
    if (!series) return;
    // SeriesSettled precedes this event whenever redeeming settled the series.
    const upPaid = series.outcome === "UP" ? upAmount : series.outcome === "DOWN" ? 0n : upAmount / 2n;
    const downPaid = payout - upPaid;
    await applyOutcomeTrade(
      context,
      owner,
      await seriesLegs(context, series, false, upAmount, downAmount, upPaid, downPaid),
      timestamp,
    );
  },
);
