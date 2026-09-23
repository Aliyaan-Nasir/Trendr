import { BigDecimal } from "envio";
import { describe, it } from "vitest";
import { addr, at, CHAIN, CONTRACTS, id32, newIndexer, T0, tx, units, ZERO } from "./helpers";

const TREND = id32(1);
const SERIES = id32(2);
const UP = addr(0xa1);
const DOWN = addr(0xa2);
const ALICE = addr(0x11);
const BOB = addr(0x12);

const opened = {
  contract: "OutcomeMarkets",
  event: "SeriesOpened",
  ...at(1, 0, tx(1)),
  params: {
    seriesId: SERIES,
    trendId: TREND,
    window: 900n,
    openedAt: BigInt(T0 + 1),
    expiry: BigInt(T0 + 901),
    openingIndex: 20_000_000n,
    up: UP,
    down: DOWN,
  },
} as const;

/** A complete-set mint as OutcomeMarkets emits it: two token mints, then SetsMinted. */
function mint(block: number, to: typeof ALICE, amount: bigint) {
  return [
    {
      contract: "TrendrToken",
      event: "Transfer",
      srcAddress: UP,
      ...at(block, 0),
      params: { from: ZERO, to, value: amount },
    },
    {
      contract: "TrendrToken",
      event: "Transfer",
      srcAddress: DOWN,
      ...at(block, 1),
      params: { from: ZERO, to, value: amount },
    },
    {
      contract: "OutcomeMarkets",
      event: "SetsMinted",
      ...at(block, 2),
      params: { seriesId: SERIES, payer: to, to, amount },
    },
  ] as const;
}

function burn(block: number, from: typeof ALICE, upAmount: bigint, downAmount: bigint) {
  return [
    {
      contract: "TrendrToken",
      event: "Transfer",
      srcAddress: UP,
      ...at(block, 0),
      params: { from, to: ZERO, value: upAmount },
    },
    {
      contract: "TrendrToken",
      event: "Transfer",
      srcAddress: DOWN,
      ...at(block, 1),
      params: { from, to: ZERO, value: downAmount },
    },
  ] as const;
}

describe("OutcomeMarkets", () => {
  it("opens a series, registers its tokens and tracks mints, holders, settlement and winnings", async (t) => {
    const indexer = newIndexer();
    await indexer.process({
      chains: {
        [CHAIN]: {
          simulate: [
            opened,
            ...mint(2, ALICE, units(10)),
            // Alice gives Bob 2 UP: a balance move, not a trade.
            {
              contract: "TrendrToken",
              event: "Transfer",
              srcAddress: UP,
              ...at(3),
              params: { from: ALICE, to: BOB, value: units(2) },
            },
            ...burn(4, ALICE, units(4), units(4)),
            {
              contract: "OutcomeMarkets",
              event: "SetsRedeemed",
              ...at(4, 2),
              params: { seriesId: SERIES, owner: ALICE, to: ALICE, amount: units(4) },
            },
            {
              contract: "OutcomeMarkets",
              event: "SeriesSettled",
              ...at(5),
              params: { seriesId: SERIES, outcome: 1n, openingIndex: 20_000_000n, settlementIndex: 25_000_000n },
            },
            ...burn(6, ALICE, units(4), units(6)),
            {
              contract: "OutcomeMarkets",
              event: "WinningsRedeemed",
              ...at(6, 2),
              params: {
                seriesId: SERIES,
                owner: ALICE,
                to: ALICE,
                upAmount: units(4),
                downAmount: units(6),
                payout: units(4),
              },
            },
          ],
        },
      },
    });

    t.expect(indexer.chains[CHAIN].TrendrToken.addresses).toEqual(t.expect.arrayContaining([UP, DOWN]));

    const series = await indexer.Series.getOrThrow(SERIES);
    t.expect(series).toMatchObject({
      trend_id: TREND,
      outcomeMarkets: CONTRACTS.outcomeMarkets,
      window: 900,
      windowLabel: "15m",
      outcome: "UP",
      settlementIndex: 25_000_000n,
      minted: units(10),
      redeemed: units(4),
      winningsPaid: units(4),
      backing: units(2),
      mintCount: 1,
      upToken_id: UP,
      downToken_id: DOWN,
    });

    // Bob holds 2 UP in his wallet. Alice's traded position still counts the 2 UP she gave away:
    // a plain transfer is not a trade, so the book cannot tell it from tokens parked elsewhere.
    const up = await indexer.Token.getOrThrow(UP);
    t.expect(up).toMatchObject({ kind: "UP", series_id: SERIES, decimals: 6, totalSupply: units(2), holderCount: 2 });
    t.expect((await indexer.Token.getOrThrow(DOWN)).totalSupply).toBe(0n);

    // Alice minted 10 sets (cost 5 per side), redeemed 4 sets at cost, then cashed 4 winning UP
    // (cost 2) and burned 6 losing DOWN (cost 3): +2 on UP, -3 on DOWN.
    const aliceUp = await indexer.OutcomeTokenBalance.getOrThrow(`${UP}-${ALICE}`);
    t.expect(aliceUp).toMatchObject({ balance: 0n, position: units(2), costBasis: units(1), realizedPnl: units(2) });
    const aliceDown = await indexer.OutcomeTokenBalance.getOrThrow(`${DOWN}-${ALICE}`);
    t.expect(aliceDown).toMatchObject({ balance: 0n, position: 0n, costBasis: 0n, realizedPnl: units(-3) });

    // Bob received UP by transfer: he holds it but has no trade history.
    t.expect(await indexer.OutcomeTokenBalance.getOrThrow(`${UP}-${BOB}`)).toMatchObject({
      balance: units(2),
      position: 0n,
    });

    const stats = await indexer.AccountStats.getOrThrow(ALICE);
    t.expect(stats).toMatchObject({
      outcomeMintVolume: units(10),
      volume: units(10),
      tradeCount: 1,
      outcomeRealizedPnl: units(-1),
      realizedPnl: units(-1),
      // Two UP went to Bob by transfer, so Alice's round trip is still open.
      closedTrades: 0,
    });
    t.expect(await indexer.Account.getOrThrow(ALICE)).toMatchObject({ outcomeHoldingCount: 1, outcomeTokensHeld: 0n });
    t.expect(await indexer.Account.getOrThrow(BOB)).toMatchObject({
      outcomeHoldingCount: 1,
      outcomeTokensHeld: units(2),
    });

    const trendStats = await indexer.TrendStats.getOrThrow(TREND);
    t.expect(trendStats).toMatchObject({
      seriesCount: 1,
      outcomeMintVolume: units(10),
      traderCount: 1,
      holderCount: 2,
    });
    t.expect(await indexer.Protocol.getOrThrow("trendr")).toMatchObject({
      seriesCount: 1,
      outcomeMintVolume: units(10),
      traderCount: 1,
    });
  });

  it("closes a round trip when both sides are paid out, counting a win for a profitable one", async (t) => {
    const indexer = newIndexer();
    // Bob holds 10 UP he bought at 0.3 and settles UP: +7.
    indexer.Token.set({
      id: UP,
      kind: "UP",
      trend_id: TREND,
      series_id: SERIES,
      decimals: 6,
      totalSupply: units(10),
      holderCount: 1,
      market_id: undefined,
      createdAt: BigInt(T0),
      chainId: CHAIN,
    });
    await indexer.process({ chains: { [CHAIN]: { simulate: [opened] } } });
    indexer.OutcomeTokenBalance.set({
      id: `${UP}-${BOB}`,
      account_id: BOB,
      token_id: UP,
      series_id: SERIES,
      trend_id: TREND,
      side: "UP",
      balance: units(10),
      balanceTokens: new BigDecimal(10),
      position: units(10),
      costBasis: units(3),
      realizedPnl: 0n,
      realizedPnlAusd: new BigDecimal(0),
      updatedAt: BigInt(T0),
      chainId: CHAIN,
    });
    indexer.OutcomeCycle.set({ id: `${SERIES}-${BOB}`, open: true, pnl: 0n, chainId: CHAIN });
    await indexer.process({
      chains: {
        [CHAIN]: {
          simulate: [
            {
              contract: "OutcomeMarkets",
              event: "SeriesSettled",
              ...at(10),
              params: { seriesId: SERIES, outcome: 1n, openingIndex: 20_000_000n, settlementIndex: 21_000_000n },
            },
            {
              contract: "OutcomeMarkets",
              event: "WinningsRedeemed",
              ...at(11),
              params: { seriesId: SERIES, owner: BOB, to: BOB, upAmount: units(10), downAmount: 0n, payout: units(10) },
            },
          ],
        },
      },
    });
    const stats = await indexer.AccountStats.getOrThrow(BOB);
    t.expect(stats).toMatchObject({ realizedPnl: units(7), closedTrades: 1, wins: 1, losses: 0, bestTrade: units(7) });
    t.expect(stats.winRate.toString()).toBe("1");
    t.expect(await indexer.OutcomeCycle.getOrThrow(`${SERIES}-${BOB}`)).toMatchObject({ open: false, pnl: 0n });
  });

  it("pays half a unit per token of a void series", async (t) => {
    const indexer = newIndexer();
    await indexer.process({
      chains: {
        [CHAIN]: {
          simulate: [
            opened,
            ...mint(2, ALICE, units(10)),
            {
              contract: "OutcomeMarkets",
              event: "SeriesSettled",
              ...at(3),
              params: { seriesId: SERIES, outcome: 3n, openingIndex: 20_000_000n, settlementIndex: 0n },
            },
            ...burn(4, ALICE, units(10), units(10)),
            {
              contract: "OutcomeMarkets",
              event: "WinningsRedeemed",
              ...at(4, 2),
              params: {
                seriesId: SERIES,
                owner: ALICE,
                to: ALICE,
                upAmount: units(10),
                downAmount: units(10),
                payout: units(10),
              },
            },
          ],
        },
      },
    });
    const series = await indexer.Series.getOrThrow(SERIES);
    t.expect(series).toMatchObject({ outcome: "VOID", settlementIndex: undefined, backing: 0n });
    // A void series refunds the set at cost: a flat round trip.
    t.expect(await indexer.AccountStats.getOrThrow(ALICE)).toMatchObject({
      realizedPnl: 0n,
      closedTrades: 1,
      wins: 0,
      losses: 0,
    });
    t.expect((await indexer.TrendStats.getOrThrow(TREND)).holderCount).toBe(0);
  });
});
