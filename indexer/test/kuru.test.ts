import { describe, it } from "vitest";
import { addr, at, CHAIN, CONTRACTS, id32, newIndexer, T0, tx, units } from "./helpers";

const TREND = id32(1);
const SERIES = id32(2);
const UP = addr(0xa1);
const DOWN = addr(0xa2);
const MARKET = addr(0xb1);
const VAULT = addr(0xb2);
const MAKER = addr(0x77);
const TAKER = addr(0x11);
const SWAPPER = addr(0x12);
const RELAYER = addr(0x99);
const WAD = 10n ** 18n;

const setup = [
  {
    contract: "OutcomeMarkets",
    event: "SeriesOpened",
    ...at(1),
    params: {
      seriesId: SERIES,
      trendId: TREND,
      window: 86_400n,
      openedAt: BigInt(T0),
      expiry: BigInt(T0 + 86_400),
      openingIndex: 20_000_000n,
      up: UP,
      down: DOWN,
    },
  },
  // OutcomeListing records the market, then the Router deploys and registers it.
  {
    contract: "OutcomeListing",
    event: "MarketRecorded",
    ...at(2, 0),
    params: { seriesId: SERIES, token: UP, market: MARKET, deployed: true },
  },
  {
    contract: "KuruRouter",
    event: "MarketRegistered",
    ...at(2, 1),
    params: {
      baseAsset: UP,
      quoteAsset: CONTRACTS.ausd,
      market: MARKET,
      vaultAddress: VAULT,
      pricePrecision: 10_000n,
      sizePrecision: 100n,
      tickSize: 10n,
      minSize: 100n,
      maxSize: 1_000_000_000n,
      takerFeeBps: 10n,
      makerFeeBps: 0n,
      kuruAmmSpread: 100n,
    },
  },
  // The market maker mints 10 sets (cost 5 AUSD per side) and asks 10 UP at 0.50.
  {
    contract: "OutcomeMarkets",
    event: "SetsMinted",
    ...at(3),
    params: { seriesId: SERIES, payer: MAKER, to: MAKER, amount: units(10) },
  },
  {
    contract: "KuruOrderBook",
    event: "OrderCreated",
    srcAddress: MARKET,
    ...at(4, 0, tx(4)),
    params: { orderId: 1n, owner: MAKER, size: 1_000n, price: 5_000n, isBuy: false },
  },
] as const;

describe("Kuru order books of Trendr tokens", () => {
  it("records the market, aggregates direct and routed fills into volume and attributes them to traders", async (t) => {
    const indexer = newIndexer();
    await indexer.process({
      chains: {
        [CHAIN]: {
          simulate: [
            ...setup,
            // A direct taker buys 4 UP at 0.50.
            {
              contract: "KuruOrderBook",
              event: "Trade",
              srcAddress: MARKET,
              ...at(5, 0, tx(5)),
              params: {
                orderId: 1n,
                makerAddress: MAKER,
                isBuy: true,
                price: WAD / 2n,
                updatedSize: 600n,
                takerAddress: TAKER,
                txOrigin: TAKER,
                filledSize: 400n,
              },
            },
            // A passkey account buys the remaining 6 UP through TrendrSpot and Kuru's Router.
            {
              contract: "KuruOrderBook",
              event: "Trade",
              srcAddress: MARKET,
              ...at(6, 0, tx(6)),
              params: {
                orderId: 1n,
                makerAddress: MAKER,
                isBuy: true,
                price: WAD / 2n,
                updatedSize: 0n,
                takerAddress: CONTRACTS.kuruRouter,
                txOrigin: RELAYER,
                filledSize: 600n,
              },
            },
            {
              contract: "KuruRouter",
              event: "KuruRouterSwap",
              ...at(6, 1, tx(6)),
              params: {
                msgSender: CONTRACTS.spot,
                debitToken: CONTRACTS.ausd,
                creditToken: UP,
                amountIn: units(3.003),
                amountOut: units(6),
              },
            },
            {
              contract: "TrendrSpot",
              event: "Swapped",
              ...at(6, 2, tx(6)),
              params: {
                trader: SWAPPER,
                token: UP,
                market: MARKET,
                isBuy: true,
                amountIn: units(3.003),
                amountOut: units(6),
                to: SWAPPER,
              },
            },
          ],
        },
      },
    });

    t.expect(indexer.chains[CHAIN].KuruOrderBook.addresses).toContain(MARKET);
    const market = await indexer.KuruMarket.getOrThrow(MARKET);
    t.expect(market).toMatchObject({
      kind: "UP",
      baseToken_id: UP,
      series_id: SERIES,
      trend_id: TREND,
      quoteToken: CONTRACTS.ausd,
      vault: VAULT,
      sizePrecision: 100n,
      pricePrecision: 10_000n,
      deployedByTrendr: true,
      volumeBase: units(10),
      volumeQuote: units(5),
      fillCount: 2,
      lastPrice: WAD / 2n,
      openOrderCount: 0,
    });
    t.expect(market.lastPriceAusd?.toString()).toBe("0.5");
    t.expect((await indexer.Series.getOrThrow(SERIES)).upMarket_id).toBe(MARKET);
    t.expect((await indexer.Token.getOrThrow(UP)).market_id).toBe(MARKET);
    t.expect((await indexer.Account.getOrThrow(VAULT)).kind).toBe("PROTOCOL");

    const fills = await indexer.KuruFill.getAll();
    const direct = fills.find((f) => f.taker === TAKER);
    t.expect(direct).toMatchObject({
      trader_id: TAKER,
      baseAmount: units(4),
      quoteAmount: units(2),
      takerIsBuy: true,
      makerAccount_id: MAKER,
      order_id: `${MARKET}-1`,
    });
    t.expect(direct?.priceAusd.toString()).toBe("0.5");
    t.expect(direct?.baseTokens.toString()).toBe("4");
    const routed = fills.find((f) => f.taker === CONTRACTS.kuruRouter);
    t.expect(routed).toMatchObject({ trader_id: SWAPPER, txOrigin: RELAYER, quoteAmount: units(3) });
    const swap = (await indexer.SpotSwap.getAll())[0];
    t.expect(swap).toMatchObject({
      source: "TRENDR_SPOT",
      trader_id: SWAPPER,
      baseAmount: units(6),
      quoteAmount: units(3.003),
      isBuy: true,
    });
    t.expect(routed?.swap_id).toBe(swap?.id);
    t.expect(swap?.priceAusd.toString()).toBe("0.5005");
    t.expect(await indexer.PendingRoute.getAll()).toEqual([]);

    t.expect(await indexer.KuruOrder.getOrThrow(`${MARKET}-1`)).toMatchObject({
      status: "FILLED",
      remaining: 0n,
      filled: 1_000n,
    });

    // Volume once per fill for the market, once per side for traders.
    t.expect(await indexer.TrendStats.getOrThrow(TREND)).toMatchObject({
      outcomeSpotVolume: units(5),
      outcomeMintVolume: units(10),
      traderCount: 3,
    });
    t.expect((await indexer.Series.getOrThrow(SERIES)).spotVolume).toBe(units(5));
    t.expect(await indexer.AccountStats.getOrThrow(TAKER)).toMatchObject({
      outcomeSpotVolume: units(2),
      tradeCount: 1,
      feesPaid: units(0.002),
    });
    t.expect(await indexer.AccountStats.getOrThrow(SWAPPER)).toMatchObject({
      outcomeSpotVolume: units(3.003),
      tradeCount: 1,
    });
    t.expect(await indexer.AccountStats.getOrThrow(MAKER)).toMatchObject({
      outcomeSpotVolume: units(5),
      outcomeMintVolume: units(10),
      tradeCount: 3,
      realizedPnl: 0n,
    });
    // The router and TrendrSpot never get track records.
    t.expect(await indexer.AccountStats.get(CONTRACTS.kuruRouter)).toBeUndefined();

    // Positions at cost: the taker paid 2 plus the 0.002 taker fee; the swapper paid 3.003.
    t.expect(await indexer.OutcomeTokenBalance.getOrThrow(`${UP}-${TAKER}`)).toMatchObject({
      position: units(4),
      costBasis: units(2.002),
    });
    t.expect(await indexer.OutcomeTokenBalance.getOrThrow(`${UP}-${SWAPPER}`)).toMatchObject({
      position: units(6),
      costBasis: units(3.003),
    });
    t.expect(await indexer.OutcomeTokenBalance.getOrThrow(`${UP}-${MAKER}`)).toMatchObject({
      position: 0n,
      costBasis: 0n,
    });
  });

  it("attributes swaps through either TrendrSpot deployment to the account that traded", async (t) => {
    for (const spot of [CONTRACTS.spot, CONTRACTS.previousSpot]) {
      const indexer = newIndexer();
      await indexer.process({
        chains: {
          [CHAIN]: {
            simulate: [
              ...setup,
              {
                contract: "KuruOrderBook",
                event: "Trade",
                srcAddress: MARKET,
                ...at(5, 0, tx(5)),
                params: {
                  orderId: 1n,
                  makerAddress: MAKER,
                  isBuy: true,
                  price: WAD / 2n,
                  updatedSize: 800n,
                  takerAddress: CONTRACTS.kuruRouter,
                  txOrigin: RELAYER,
                  filledSize: 200n,
                },
              },
              {
                contract: "KuruRouter",
                event: "KuruRouterSwap",
                ...at(5, 1, tx(5)),
                params: {
                  msgSender: spot,
                  debitToken: CONTRACTS.ausd,
                  creditToken: UP,
                  amountIn: units(1.001),
                  amountOut: units(2),
                },
              },
              {
                contract: "TrendrSpot",
                event: "Swapped",
                srcAddress: spot,
                ...at(5, 2, tx(5)),
                params: {
                  trader: SWAPPER,
                  token: UP,
                  market: MARKET,
                  isBuy: true,
                  amountIn: units(1.001),
                  amountOut: units(2),
                  to: SWAPPER,
                },
              },
            ],
          },
        },
      });
      t.expect((await indexer.SpotSwap.getAll())[0]).toMatchObject({
        source: "TRENDR_SPOT",
        trader_id: SWAPPER,
        baseAmount: units(2),
      });
      t.expect((await indexer.KuruFill.getAll())[0]).toMatchObject({ trader_id: SWAPPER });
      t.expect(await indexer.AccountStats.get(spot)).toBeUndefined();
      t.expect(await indexer.PendingRoute.getAll()).toEqual([]);
    }
  });

  it("credits a fill routed by someone calling Kuru's Router directly to that caller", async (t) => {
    const indexer = newIndexer();
    await indexer.process({
      chains: {
        [CHAIN]: {
          simulate: [
            ...setup,
            {
              contract: "KuruOrderBook",
              event: "Trade",
              srcAddress: MARKET,
              ...at(5, 0, tx(5)),
              params: {
                orderId: 1n,
                makerAddress: MAKER,
                isBuy: true,
                price: WAD / 2n,
                updatedSize: 800n,
                takerAddress: CONTRACTS.kuruRouter,
                txOrigin: SWAPPER,
                filledSize: 200n,
              },
            },
            {
              contract: "KuruRouter",
              event: "KuruRouterSwap",
              ...at(5, 1, tx(5)),
              params: {
                msgSender: SWAPPER,
                debitToken: CONTRACTS.ausd,
                creditToken: UP,
                amountIn: units(1.001),
                amountOut: units(2),
              },
            },
          ],
        },
      },
    });
    const swap = (await indexer.SpotSwap.getAll())[0];
    t.expect(swap).toMatchObject({
      source: "KURU_ROUTER",
      trader_id: SWAPPER,
      isBuy: true,
      baseAmount: units(2),
      quoteAmount: units(1.001),
    });
    t.expect((await indexer.KuruFill.getAll())[0]).toMatchObject({ trader_id: SWAPPER, swap_id: swap?.id });
    t.expect(await indexer.AccountStats.getOrThrow(SWAPPER)).toMatchObject({
      outcomeSpotVolume: units(1.001),
      tradeCount: 1,
    });
    t.expect(await indexer.PendingRoute.getAll()).toEqual([]);
  });

  it("realizes a taker's profit when it sells back into a bid and counts the round trip as a win", async (t) => {
    const indexer = newIndexer();
    await indexer.process({
      chains: {
        [CHAIN]: {
          simulate: [
            ...setup,
            {
              contract: "KuruOrderBook",
              event: "Trade",
              srcAddress: MARKET,
              ...at(5, 0, tx(5)),
              params: {
                orderId: 1n,
                makerAddress: MAKER,
                isBuy: true,
                price: WAD / 2n,
                updatedSize: 600n,
                takerAddress: TAKER,
                txOrigin: TAKER,
                filledSize: 400n,
              },
            },
            {
              contract: "KuruOrderBook",
              event: "OrderCreated",
              srcAddress: MARKET,
              ...at(6, 0, tx(6)),
              params: { orderId: 2n, owner: MAKER, size: 400n, price: 6_000n, isBuy: true },
            },
            {
              contract: "KuruOrderBook",
              event: "Trade",
              srcAddress: MARKET,
              ...at(7, 0, tx(7)),
              params: {
                orderId: 2n,
                makerAddress: MAKER,
                isBuy: false,
                price: (WAD * 6n) / 10n,
                updatedSize: 0n,
                takerAddress: TAKER,
                txOrigin: TAKER,
                filledSize: 400n,
              },
            },
            // The maker pulls the rest of its ask: one OrderCanceled per order, then the batch event.
            {
              contract: "KuruOrderBook",
              event: "OrderCanceled",
              srcAddress: MARKET,
              ...at(8, 0, tx(8)),
              params: { orderId: 1n, owner: MAKER, price: 5_000n, size: 600n, isBuy: false },
            },
            {
              contract: "KuruOrderBook",
              event: "OrdersCanceled",
              srcAddress: MARKET,
              ...at(8, 1, tx(8)),
              params: { orderId: [1n], owner: MAKER },
            },
          ],
        },
      },
    });

    // Bought 4 for 2.002 (fee included), sold 4 for 2.4 less a 0.0024 fee.
    const stats = await indexer.AccountStats.getOrThrow(TAKER);
    t.expect(stats).toMatchObject({
      realizedPnl: units(0.3956),
      outcomeRealizedPnl: units(0.3956),
      closedTrades: 1,
      wins: 1,
      losses: 0,
      tradeCount: 2,
    });
    t.expect(stats.realizedPnlAusd.toString()).toBe("0.3956");
    t.expect(await indexer.OutcomeTokenBalance.getOrThrow(`${UP}-${TAKER}`)).toMatchObject({
      position: 0n,
      realizedPnl: units(0.3956),
    });
    t.expect(await indexer.KuruOrder.getOrThrow(`${MARKET}-2`)).toMatchObject({ status: "FILLED", isBuy: true });
    t.expect(await indexer.KuruOrder.getOrThrow(`${MARKET}-1`)).toMatchObject({ status: "CANCELED", remaining: 600n });
    t.expect((await indexer.KuruMarket.getOrThrow(MARKET)).openOrderCount).toBe(0);
    const day = (await indexer.AccountDayData.getAll()).find((d) => d.account_id === TAKER);
    t.expect(day).toMatchObject({ wins: 1, tradeCount: 2, realizedPnl: units(0.3956) });
  });
});
