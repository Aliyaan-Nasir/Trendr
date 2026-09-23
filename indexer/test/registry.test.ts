import { describe, it } from "vitest";
import { addr, at, CHAIN, id32, newIndexer, T0, tx } from "./helpers";

const TREND = id32(1);
const SURFACER = addr(0x51);

describe("TrendRegistry", () => {
  it("creates a trend with its stats, first index point and day candle, then follows index updates", async (t) => {
    const indexer = newIndexer();
    await indexer.process({
      chains: {
        [CHAIN]: {
          simulate: [
            {
              contract: "TrendRegistry",
              event: "TrendCreated",
              ...at(1, 0, tx(1)),
              params: {
                id: TREND,
                identifier: "monad",
                assetClass: 6n,
                surfacer: SURFACER,
                index: 20_000_000n,
                observedAt: BigInt(T0),
              },
            },
            {
              contract: "TrendRegistry",
              event: "StatusChanged",
              ...at(1, 1, tx(1)),
              params: { id: TREND, from: 0n, to: 1n, at: BigInt(T0) },
            },
            {
              contract: "TrendRegistry",
              event: "IndexUpdated",
              ...at(2, 0, tx(2)),
              params: {
                id: TREND,
                index: 26_000_000n,
                peakIndex: 26_000_000n,
                observedAt: BigInt(T0 + 60),
                clamped: true,
              },
            },
            {
              contract: "TrendRegistry",
              event: "IndexUpdated",
              ...at(3, 0, tx(3)),
              params: {
                id: TREND,
                index: 18_000_000n,
                peakIndex: 26_000_000n,
                observedAt: BigInt(T0 + 120),
                clamped: false,
              },
            },
            {
              contract: "TrendRegistry",
              event: "StatusChanged",
              ...at(4, 0, tx(4)),
              params: { id: TREND, from: 1n, to: 2n, at: BigInt(T0 + 180) },
            },
            {
              contract: "TrendRegistry",
              event: "SettlementFinalized",
              ...at(5),
              params: { id: TREND, expiry: BigInt(T0 + 100), value: 18_000_000n },
            },
            {
              contract: "TrendRegistry",
              event: "ReportProcessed",
              ...at(5, 1, tx(5)),
              params: { runId: 42n, observedAt: BigInt(T0 + 120), created: 0n, updated: 1n, settled: 1n, rejected: 0n },
            },
          ],
        },
      },
    });

    const trend = await indexer.Trend.getOrThrow(TREND);
    t.expect(trend).toMatchObject({
      identifier: "monad",
      assetClass: "TOPIC",
      status: "COOLING",
      statusSince: BigInt(T0 + 180),
      surfacer_id: SURFACER,
      openingIndex: 20_000_000n,
      index: 18_000_000n,
      peakIndex: 26_000_000n,
      indexObservedAt: BigInt(T0 + 120),
      updateCount: 2,
      clampedCount: 1,
      createdTxHash: tx(1),
    });
    t.expect(trend.indexPoints.toString()).toBe("18");
    t.expect(trend.peakIndexPoints.toString()).toBe("26");

    const points = await indexer.IndexPoint.getAll();
    t.expect(points.map((p) => [p.index, p.clamped])).toEqual([
      [20_000_000n, false],
      [26_000_000n, true],
      [18_000_000n, false],
    ]);

    const day = await indexer.TrendDayData.getOrThrow(`${TREND}-${BigInt(T0) - (BigInt(T0) % 86_400n)}`);
    t.expect([day.indexOpen, day.indexHigh, day.indexLow, day.indexClose]).toEqual([
      20_000_000n,
      26_000_000n,
      18_000_000n,
      18_000_000n,
    ]);

    const changes = await indexer.TrendStatusChange.getAll();
    t.expect(changes.map((c) => [c.fromStatus, c.toStatus])).toEqual([
      ["NONE", "ACTIVE"],
      ["ACTIVE", "COOLING"],
    ]);

    const settlement = await indexer.Settlement.getOrThrow(`${TREND}-${T0 + 100}`);
    t.expect(settlement.valuePoints.toString()).toBe("18");

    t.expect(await indexer.OracleRun.getOrThrow("42")).toMatchObject({ updated: 1, settled: 1, txHash: tx(5) });
    t.expect(await indexer.Protocol.getOrThrow("trendr")).toMatchObject({ trendCount: 1, lastOracleRunId: 42n });
    t.expect(await indexer.TrendStats.getOrThrow(TREND)).toMatchObject({ volume: 0n, holderCount: 0 });
    t.expect(await indexer.Account.getOrThrow(SURFACER)).toMatchObject({ kind: "USER" });
  });

  it("ignores index updates for unknown trends", async (t) => {
    const indexer = newIndexer();
    await indexer.process({
      chains: {
        [CHAIN]: {
          simulate: [
            {
              contract: "TrendRegistry",
              event: "IndexUpdated",
              ...at(1),
              params: { id: id32(9), index: 1_000_000n, peakIndex: 1_000_000n, observedAt: BigInt(T0), clamped: false },
            },
          ],
        },
      },
    });
    t.expect(await indexer.Trend.getAll()).toEqual([]);
    t.expect(await indexer.IndexPoint.getAll()).toEqual([]);
  });
});
