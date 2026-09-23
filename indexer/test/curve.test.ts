import { describe, it } from "vitest";
import { addr, at, CHAIN, CONTRACTS, id32, newIndexer, tx, units } from "./helpers";

const TREND = id32(1);
const COIN = addr(0xc1);
const MARKET = addr(0xc2);
const VAULT = addr(0xc3);
const ALICE = addr(0x11);
const coins = (n: number) => BigInt(n) * 10n ** 18n;

describe("BondingCurve and graduation", () => {
  it("books curve trades and coin PnL, then graduates to a Kuru market with the Router's parameters", async (t) => {
    const indexer = newIndexer();
    await indexer.process({
      chains: {
        [CHAIN]: {
          simulate: [
            {
              contract: "BondingCurve",
              event: "CurveCreated",
              ...at(1),
              params: { trendId: TREND, coin: COIN, virtualQuote: units(1000), peakAtCreation: 20_000_000n },
            },
            // Buy 90M coins for 100 AUSD (1 AUSD fee), sell half for 55, the rest for 40.
            {
              contract: "BondingCurve",
              event: "Trade",
              ...at(2, 0, tx(2)),
              params: {
                trendId: TREND,
                trader: ALICE,
                isBuy: true,
                quoteAmount: units(100),
                coinAmount: coins(90_000_000),
                fee: units(1),
                reserve: units(99),
                sold: coins(90_000_000),
              },
            },
            {
              contract: "BondingCurve",
              event: "FloorRaised",
              ...at(3, 0),
              params: { trendId: TREND, virtualQuote: units(1100), cost: units(2), ratchetBps: 11_000n },
            },
            {
              contract: "BondingCurve",
              event: "Trade",
              ...at(3, 1, tx(3)),
              params: {
                trendId: TREND,
                trader: ALICE,
                isBuy: false,
                quoteAmount: units(55),
                coinAmount: coins(45_000_000),
                fee: units(0.55),
                reserve: units(45.45),
                sold: coins(45_000_000),
              },
            },
            {
              contract: "BondingCurve",
              event: "Trade",
              ...at(4, 0, tx(4)),
              params: {
                trendId: TREND,
                trader: ALICE,
                isBuy: false,
                quoteAmount: units(40),
                coinAmount: coins(45_000_000),
                fee: units(0.4),
                reserve: units(5),
                sold: 0n,
              },
            },
          ],
        },
      },
    });

    t.expect(indexer.chains[CHAIN].TrendrToken.addresses).toContain(COIN);
    const curve = await indexer.Curve.getOrThrow(TREND);
    t.expect(curve).toMatchObject({
      state: "OPEN",
      coin_id: COIN,
      virtualQuote: units(1100),
      reserve: units(5),
      ratchetBps: 11_000n,
      floorRaiseCount: 1,
      buyVolume: units(100),
      sellVolume: units(95.95),
      feesCollected: units(1.95),
      tradeCount: 3,
    });
    // (1100 + 5) AUSD / 1e9 coins.
    t.expect(curve.spotPriceAusd.toString()).toBe("0.000001105");
    t.expect((await indexer.CurveTrade.getAll()).map((x) => x.isBuy)).toEqual([true, false, false]);

    // Cost 100 for 90M coins: +5 on the first half, -10 on the second, one losing round trip.
    t.expect(await indexer.CoinBalance.getOrThrow(`${COIN}-${ALICE}`)).toMatchObject({
      position: 0n,
      costBasis: 0n,
      realizedPnl: units(-5),
      cyclePnl: units(-5),
    });
    t.expect(await indexer.AccountStats.getOrThrow(ALICE)).toMatchObject({
      curveVolume: units(195.95),
      curveRealizedPnl: units(-5),
      feesPaid: units(1.95),
      closedTrades: 1,
      losses: 1,
      tradeCount: 3,
    });
    t.expect(await indexer.TrendStats.getOrThrow(TREND)).toMatchObject({ curveVolume: units(195.95), tradeCount: 3 });

    await indexer.process({
      chains: {
        [CHAIN]: {
          simulate: [
            {
              contract: "BondingCurve",
              event: "GraduationReady",
              ...at(10),
              params: { trendId: TREND, reserve: units(5000) },
            },
            // graduate(): the venue deploys the market (Router registers it), seeds the vault, then the curve reports.
            {
              contract: "KuruRouter",
              event: "MarketRegistered",
              ...at(11, 0, tx(11)),
              params: {
                baseAsset: COIN,
                quoteAsset: CONTRACTS.ausd,
                market: MARKET,
                vaultAddress: VAULT,
                pricePrecision: 100_000_000n,
                sizePrecision: 1_000_000n,
                tickSize: 100n,
                minSize: 1_000n,
                maxSize: 9_000_000_000_000_000n,
                takerFeeBps: 30n,
                makerFeeBps: 10n,
                kuruAmmSpread: 100n,
              },
            },
            {
              contract: "KuruGraduationVenue",
              event: "Listed",
              ...at(11, 1, tx(11)),
              params: {
                lister: CONTRACTS.curve,
                base: COIN,
                quote: CONTRACTS.ausd,
                market: MARKET,
                vault: VAULT,
                baseAmount: coins(1_000_000),
                quoteAmount: units(5000),
                shares: 123n,
              },
            },
            {
              contract: "BondingCurve",
              event: "Graduated",
              ...at(11, 2, tx(11)),
              params: { trendId: TREND, market: MARKET, coinAmount: coins(1_000_000), quoteAmount: units(5000) },
            },
            // Alice buys 2M coins from the market's AMM vault at 0.000001 AUSD.
            {
              contract: "KuruOrderBook",
              event: "Trade",
              srcAddress: MARKET,
              ...at(12, 0, tx(12)),
              params: {
                orderId: 0n,
                makerAddress: VAULT,
                isBuy: true,
                price: 10n ** 12n,
                updatedSize: 0n,
                takerAddress: ALICE,
                txOrigin: ALICE,
                filledSize: 2_000_000_000_000n,
              },
            },
          ],
        },
      },
    });

    t.expect(await indexer.Curve.getOrThrow(TREND)).toMatchObject({
      state: "GRADUATED",
      market_id: MARKET,
      graduation_id: TREND,
      reserve: 0n,
    });
    t.expect(await indexer.Graduation.getOrThrow(TREND)).toMatchObject({
      readyReserve: units(5000),
      pending: false,
      market_id: MARKET,
      vault: VAULT,
      vaultShares: 123n,
      coinAmount: coins(1_000_000),
      quoteAmount: units(5000),
      txHash: tx(11),
    });
    t.expect(indexer.chains[CHAIN].KuruOrderBook.addresses).toContain(MARKET);
    t.expect(await indexer.KuruMarket.getOrThrow(MARKET)).toMatchObject({
      kind: "TREND_COIN",
      baseToken_id: COIN,
      series_id: undefined,
      pricePrecision: 100_000_000n,
      sizePrecision: 1_000_000n,
      takerFeeBps: 30,
      baseDecimals: 18,
      vault: VAULT,
      volumeQuote: units(2),
      volumeBase: coins(2_000_000),
    });
    t.expect(await indexer.Account.getOrThrow(VAULT)).toMatchObject({ kind: "PROTOCOL" });

    const fill = (await indexer.KuruFill.getAll())[0];
    t.expect(fill).toMatchObject({
      isVaultFill: true,
      makerAccount_id: undefined,
      order_id: undefined,
      trader_id: ALICE,
      quoteAmount: units(2),
    });
    t.expect(fill?.priceAusd.toString()).toBe("0.000001");
    t.expect(await indexer.AccountStats.get(VAULT)).toBeUndefined();
    t.expect(await indexer.AccountStats.getOrThrow(ALICE)).toMatchObject({ coinSpotVolume: units(2), tradeCount: 4 });
    // A 0.3% taker fee on 2 AUSD lands in the cost basis.
    t.expect(await indexer.CoinBalance.getOrThrow(`${COIN}-${ALICE}`)).toMatchObject({
      position: coins(2_000_000),
      costBasis: units(2.006),
    });
    t.expect(await indexer.TrendStats.getOrThrow(TREND)).toMatchObject({ coinSpotVolume: units(2) });
    t.expect(await indexer.Protocol.getOrThrow("trendr")).toMatchObject({
      curveCount: 1,
      graduationCount: 1,
      kuruMarketCount: 1,
    });
  });
});
