import { describe, it } from "vitest";
import { fundingRate, notional } from "../src/lib/perpMath";
import { addr, at, CHAIN, id32, newIndexer, tx, units } from "./helpers";

const TREND = id32(1);
const ALICE = addr(0x11);
const BOB = addr(0x12);
const LIQUIDATOR = addr(0x13);
const CONTRACT = 10n ** 18n;

const poke = (block: number, logIndex: number, mark: bigint) =>
  ({
    contract: "AttentionPerp",
    event: "Poked",
    ...at(block, logIndex, tx(block)),
    params: { trendId: TREND, mark, cumLong: 0n, cumShort: 0n, blockNumber: BigInt(block) },
  }) as const;

describe("AttentionPerp", () => {
  it("matches the contract's notional and funding formulas", (t) => {
    t.expect(notional(10n * CONTRACT, 20_000_000n)).toBe(units(200));
    t.expect(fundingRate(0n, 0n)).toBe(0n);
    t.expect(fundingRate(10n * CONTRACT, 5n * CONTRACT)).toBe(66_666_666_666n);
    t.expect(fundingRate(0n, 5n * CONTRACT)).toBe(-200_000_000_000n);
  });

  it("tracks open interest, funding marks, closes and liquidations into PnL and track records", async (t) => {
    const indexer = newIndexer();
    await indexer.process({
      chains: {
        [CHAIN]: {
          simulate: [
            // Alice goes long 10 contracts at 20 points with 100 AUSD at 2x.
            poke(1, 0, 20_000_000n),
            {
              contract: "AttentionPerp",
              event: "PositionOpened",
              ...at(1, 1, tx(1)),
              params: {
                id: 1n,
                owner: ALICE,
                trendId: TREND,
                isLong: true,
                qty: 10n * CONTRACT,
                margin: units(100),
                entryIndex: 20_000_000n,
                fee: units(0.2),
                payer: ALICE,
              },
            },
            // Bob goes short 5 contracts with 50 AUSD.
            poke(2, 0, 20_000_000n),
            {
              contract: "AttentionPerp",
              event: "PositionOpened",
              ...at(2, 1, tx(2)),
              params: {
                id: 2n,
                owner: BOB,
                trendId: TREND,
                isLong: false,
                qty: 5n * CONTRACT,
                margin: units(50),
                entryIndex: 20_000_000n,
                fee: units(0.1),
                payer: BOB,
              },
            },
            poke(3, 0, 22_000_000n),
          ],
        },
      },
    });

    let stats = await indexer.TrendStats.getOrThrow(TREND);
    t.expect(stats).toMatchObject({
      perpLongQty: 10n * CONTRACT,
      perpShortQty: 5n * CONTRACT,
      perpLongOpenInterest: units(220),
      perpShortOpenInterest: units(110),
      perpOpenPositionCount: 2,
      perpMark: 22_000_000n,
      perpFundingRatePerBlock: 66_666_666_666n,
      perpVolume: units(300),
      traderCount: 2,
    });
    const marks = await indexer.FundingMark.getAll();
    t.expect(marks.map((m) => [m.mark, m.longQty, m.fundingRatePerBlock])).toEqual([
      [20_000_000n, 0n, 0n],
      [20_000_000n, 10n * CONTRACT, 200_000_000_000n],
      [22_000_000n, 10n * CONTRACT, 66_666_666_666n],
    ]);
    t.expect(await indexer.Account.getOrThrow(ALICE)).toMatchObject({
      perpOpenPositionCount: 1,
      perpMarginLocked: units(100),
      perpOpenNotional: units(200),
    });

    await indexer.process({
      chains: {
        [CHAIN]: {
          simulate: [
            // Alice closes at 22: +20 price PnL, 0.05 funding paid, 0.22 fee.
            poke(4, 0, 22_000_000n),
            {
              contract: "AttentionPerp",
              event: "PositionClosed",
              ...at(4, 1, tx(4)),
              params: {
                id: 1n,
                owner: ALICE,
                exitIndex: 22_000_000n,
                pnl: units(20),
                funding: units(0.05),
                fee: units(0.22),
                payout: units(119.73),
              },
            },
            {
              contract: "AttentionPerp",
              event: "MarginAdded",
              ...at(5),
              params: { id: 2n, payer: BOB, amount: units(10) },
            },
            // Bob is liquidated at 30.
            poke(6, 0, 30_000_000n),
            {
              contract: "AttentionPerp",
              event: "PositionLiquidated",
              ...at(6, 1, tx(6)),
              params: { id: 2n, liquidator: LIQUIDATOR, exitIndex: 30_000_000n, equity: units(9), reward: units(1.5) },
            },
          ],
        },
      },
    });

    const closed = await indexer.PerpPosition.getOrThrow("1");
    t.expect(closed).toMatchObject({
      status: "CLOSED",
      payout: units(119.73),
      realizedPnl: units(19.53),
      closeFee: units(0.22),
      closeTxHash: tx(4),
    });
    const liquidated = await indexer.PerpPosition.getOrThrow("2");
    t.expect(liquidated).toMatchObject({
      status: "LIQUIDATED",
      margin: units(60),
      marginAdded: units(10),
      payout: 0n,
      realizedPnl: units(-60.1),
      liquidator: LIQUIDATOR,
    });

    stats = await indexer.TrendStats.getOrThrow(TREND);
    t.expect(stats).toMatchObject({
      perpLongQty: 0n,
      perpShortQty: 0n,
      perpLongOpenInterest: 0n,
      perpOpenPositionCount: 0,
      perpFundingRatePerBlock: 0n,
    });
    // Volume: opens 200 + 100, closes at 22 (220) and 30 (150).
    t.expect(stats.perpVolume).toBe(units(670));

    t.expect(await indexer.AccountStats.getOrThrow(ALICE)).toMatchObject({
      perpVolume: units(420),
      perpRealizedPnl: units(19.53),
      feesPaid: units(0.42),
      closedTrades: 1,
      wins: 1,
      bestTrade: units(19.53),
    });
    t.expect(await indexer.AccountStats.getOrThrow(BOB)).toMatchObject({
      perpRealizedPnl: units(-60.1),
      losses: 1,
      liquidations: 1,
      worstTrade: units(-60.1),
    });
    t.expect(await indexer.Account.getOrThrow(BOB)).toMatchObject({
      perpOpenPositionCount: 0,
      perpMarginLocked: 0n,
      perpOpenNotional: 0n,
    });
    t.expect(await indexer.Protocol.getOrThrow("trendr")).toMatchObject({
      perpOpenPositionCount: 0,
      perpVolume: units(670),
    });
  });
});
