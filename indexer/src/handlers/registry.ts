import { type Enum, indexer } from "envio";
import { type Context, loadTrendStats, updateAccount, updateProtocol, updateTrendDay } from "../lib/aggregates";
import { ZERO_ADDRESS } from "../lib/constants";
import { eventId, timestampOf, WITH_TIME, WITH_TX } from "../lib/events";
import { points } from "../lib/units";

const STATUSES: readonly Enum<"TrendStatus">[] = ["NONE", "ACTIVE", "COOLING", "RETIRED"];
const ASSET_CLASSES: readonly Enum<"AssetClass">[] = [
  "CRYPTO",
  "EQUITY",
  "COMMODITY",
  "FX",
  "PERSON",
  "POLITICS",
  "TOPIC",
];

const status = (value: bigint): Enum<"TrendStatus"> => STATUSES[Number(value)] ?? "NONE";

/** Folds one index observation into the trend's day candle. */
async function recordIndexForDay(context: Context, trendId: string, index: bigint, timestamp: bigint): Promise<void> {
  await updateTrendDay(context, trendId, timestamp, (d) => ({
    indexOpen: d.indexOpen ?? index,
    indexHigh: d.indexHigh === undefined || index > d.indexHigh ? index : d.indexHigh,
    indexLow: d.indexLow === undefined || index < d.indexLow ? index : d.indexLow,
    indexClose: index,
  }));
}

indexer.onEvent({ contract: "TrendRegistry", event: "TrendCreated", fields: WITH_TX }, async ({ event, context }) => {
  const { id, identifier, assetClass, surfacer, index, observedAt } = event.params;
  const timestamp = timestampOf(event);
  const hasSurfacer = surfacer !== ZERO_ADDRESS;
  if (hasSurfacer) await updateAccount(context, surfacer, timestamp, () => ({}));

  await loadTrendStats(context, id, timestamp);
  context.Trend.set({
    id,
    identifier,
    assetClass: ASSET_CLASSES[Number(assetClass)] ?? "TOPIC",
    // StatusChanged(None, Active) follows in the same report.
    status: "ACTIVE",
    statusSince: observedAt,
    surfacer_id: hasSurfacer ? surfacer : undefined,
    createdAt: observedAt,
    createdBlock: event.block.number,
    createdTxHash: event.transaction.hash,
    openingIndex: index,
    openingIndexPoints: points(index),
    index,
    indexPoints: points(index),
    peakIndex: index,
    peakIndexPoints: points(index),
    indexObservedAt: observedAt,
    updateCount: 0,
    clampedCount: 0,
    stats_id: id,
    curve_id: undefined,
  });
  context.IndexPoint.set({
    id: `${id}-${observedAt}`,
    trend_id: id,
    index,
    indexPoints: points(index),
    peakIndex: index,
    observedAt,
    clamped: false,
    blockNumber: event.block.number,
    timestamp,
    txHash: event.transaction.hash,
  });
  await recordIndexForDay(context, id, index, timestamp);
  await updateProtocol(context, timestamp, (p) => ({ trendCount: p.trendCount + 1 }));
});

indexer.onEvent({ contract: "TrendRegistry", event: "IndexUpdated", fields: WITH_TX }, async ({ event, context }) => {
  const { id, index, peakIndex, observedAt, clamped } = event.params;
  const trend = await context.Trend.get(id);
  if (!trend) return;
  const timestamp = timestampOf(event);
  context.Trend.set({
    ...trend,
    index,
    indexPoints: points(index),
    peakIndex,
    peakIndexPoints: points(peakIndex),
    indexObservedAt: observedAt,
    updateCount: trend.updateCount + 1,
    clampedCount: trend.clampedCount + (clamped ? 1 : 0),
  });
  context.IndexPoint.set({
    id: `${id}-${observedAt}`,
    trend_id: id,
    index,
    indexPoints: points(index),
    peakIndex,
    observedAt,
    clamped,
    blockNumber: event.block.number,
    timestamp,
    txHash: event.transaction.hash,
  });
  await recordIndexForDay(context, id, index, timestamp);
});

indexer.onEvent({ contract: "TrendRegistry", event: "StatusChanged", fields: WITH_TX }, async ({ event, context }) => {
  const { id, from, to, at } = event.params;
  const trend = await context.Trend.get(id);
  if (!trend) return;
  context.Trend.set({ ...trend, status: status(to), statusSince: at });
  context.TrendStatusChange.set({
    id: eventId(event),
    trend_id: id,
    fromStatus: status(from),
    toStatus: status(to),
    at,
    blockNumber: event.block.number,
    txHash: event.transaction.hash,
  });
});

indexer.onEvent(
  { contract: "TrendRegistry", event: "SettlementFinalized", fields: WITH_TIME },
  async ({ event, context }) => {
    const { id, expiry, value } = event.params;
    context.Settlement.set({
      id: `${id}-${expiry}`,
      trend_id: id,
      expiry,
      value,
      valuePoints: points(value),
      blockNumber: event.block.number,
      timestamp: timestampOf(event),
    });
  },
);

indexer.onEvent(
  { contract: "TrendRegistry", event: "ReportProcessed", fields: WITH_TX },
  async ({ event, context }) => {
    const { runId, observedAt, created, updated, settled, rejected } = event.params;
    const timestamp = timestampOf(event);
    context.OracleRun.set({
      id: runId.toString(),
      runId,
      observedAt,
      created: Number(created),
      updated: Number(updated),
      settled: Number(settled),
      rejected: Number(rejected),
      blockNumber: event.block.number,
      timestamp,
      txHash: event.transaction.hash,
    });
    await updateProtocol(context, timestamp, () => ({ lastOracleRunId: runId, lastOracleObservedAt: observedAt }));
  },
);
