import { describe, it } from "vitest";
import { addr, at, CHAIN, CONTRACTS, delegate, newIndexer, T0, tx, units } from "./helpers";

const PASSKEY = addr(0x5a);
const OUTSIDER = addr(0x5b);
const LATE = addr(0x5c);
delegate(PASSKEY);
delegate(LATE);
const BOT = CONTRACTS.bot as `0x${string}`;
const BTC = 16n;

const initialized = (account: `0x${string}`, block: number) =>
  ({
    contract: "PasskeyAccount",
    event: "Initialized",
    srcAddress: account,
    ...at(block),
    params: { ownerX: `0x${"01".repeat(32)}`, ownerY: `0x${"02".repeat(32)}` },
  }) as const;

const created = (account: `0x${string}`, id: bigint, block: number) =>
  ({
    contract: "PerplExchange",
    event: "AccountCreated",
    ...at(block, 0, tx(block)),
    params: { account, id },
  }) as const;

const opened = (accountId: bigint, block: number, logIndex: number, lot: bigint, positionType = 0n) =>
  ({
    contract: "PerplExchange",
    event: "PositionOpenedV2",
    ...at(block, logIndex, tx(block)),
    params: {
      perpId: BTC,
      accountId,
      positionType,
      leverageHdths: 200n,
      depositCNS: 41_297_200n,
      pnlCollateralizedCNS: 0n,
      pricePNS: 825_466n,
      lotLNS: lot,
      insFeeCNS: 4_272n,
      protFeeCNS: 24_207n,
      priceResiduePNSQ16: 0n,
    },
  }) as const;

const takerFill = (
  block: number,
  logIndex: number,
  pricePNS: bigint,
  lotLNS: bigint,
  feeCNS: bigint,
  amountCNS: bigint,
  balanceCNS: bigint,
) =>
  ({
    contract: "PerplExchange",
    event: "TakerOrderFilledV2",
    ...at(block, logIndex, tx(block)),
    params: {
      entryPricePNS: pricePNS,
      collatPricePNS: pricePNS,
      pnlPricePNS: pricePNS,
      lotLNS,
      feeCNS,
      amountCNS,
      balanceCNS,
      builderId: 0n,
      builderFeeCNS: 0n,
    },
  }) as const;

/** Perpl market metadata normally read once over RPC; preset so tests stay offline. */
function presetBtc(indexer: ReturnType<typeof newIndexer>) {
  indexer.PerplMarket.set({
    id: "16",
    perpId: BTC,
    name: "BTC Perp",
    symbol: "BTC",
    priceDecimals: 1,
    lotDecimals: 5,
    trendrVolume: 0n,
    trendrFillCount: 0,
    chainId: CHAIN,
  });
}

describe("Perpl activity of Trendr accounts", () => {
  it("attributes a passkey account's taker fills through its position events and skips other accounts", async (t) => {
    const indexer = newIndexer();
    presetBtc(indexer);
    await indexer.process({
      chains: {
        [CHAIN]: {
          simulate: [
            initialized(PASSKEY, 1),
            created(PASSKEY, 1023n, 2),
            {
              contract: "PerplExchange",
              event: "CollateralDeposit",
              ...at(2, 1, tx(2)),
              params: { accountId: 1023n, amountCNS: units(100), balanceCNS: units(100) },
            },
            created(OUTSIDER, 1022n, 3),
            // Opening match: the maker (an outsider) moves first, then the passkey account's position and taker fill.
            {
              contract: "PerplExchange",
              event: "MakerOrderFilledV2",
              ...at(4, 1, tx(4)),
              params: {
                perpId: BTC,
                accountId: 1022n,
                orderId: 84n,
                pricePNS: 825_466n,
                lotLNS: 100n,
                feeCNS: 0n,
                lockedBalanceCNS: 0n,
                amountCNS: 0n,
                balanceCNS: 0n,
                builderId: 0n,
                builderFeeCNS: 0n,
              },
            },
            opened(1023n, 4, 2, 100n),
            takerFill(4, 3, 825_466n, 100n, 28_479n, -41_325_679n, 58_674_321n),
            // Closing match.
            {
              contract: "PerplExchange",
              event: "PositionClosed",
              ...at(5, 1, tx(5)),
              params: {
                perpId: BTC,
                accountId: 1023n,
                positionType: 0n,
                pricePNS: 825_109n,
                deltaPnlCNS: -35_700n,
                fundingCNS: 0n,
              },
            },
            takerFill(5, 2, 825_109n, 100n, 28_467n, 41_233_033n, 99_907_354n),
            // An outsider's own open and taker fill in the same block: not indexed.
            opened(1022n, 5, 5, 300n),
            takerFill(5, 6, 825_109n, 300n, 85_000n, -1n, 1n),
            {
              contract: "PerplExchange",
              event: "CollateralWithdrawal",
              ...at(6, 0, tx(6)),
              params: { accountId: 1023n, amountCNS: 99_907_354n, balanceCNS: 0n },
            },
          ],
        },
      },
    });

    const account = await indexer.PerplAccount.getOrThrow("1023");
    t.expect(account).toMatchObject({
      isTrendr: true,
      owner_id: PASSKEY,
      deposited: units(100),
      withdrawn: 99_907_354n,
      balanceCns: 0n,
      fillCount: 2,
      feesPaid: 56_946n,
      realizedPnl: -92_646n,
      volume: 165_057_500n,
    });
    t.expect(await indexer.PerplAccount.getOrThrow("1022")).toMatchObject({
      isTrendr: false,
      owner_id: undefined,
      fillCount: 0,
    });
    t.expect((await indexer.Account.getOrThrow(PASSKEY)).perplAccount_id).toBe("1023");

    const fills = await indexer.PerplFill.getAll();
    t.expect(fills.map((f) => [f.account_id, f.role, f.action, f.isLong, f.notionalCns])).toEqual([
      ["1023", "TAKER", "OPEN", true, 82_546_600n],
      ["1023", "TAKER", "CLOSE", true, 82_510_900n],
    ]);
    t.expect(fills[0]?.price.toString()).toBe("82546.6");
    t.expect(fills[0]?.size.toString()).toBe("0.001");

    // Withdrawn 99.907354 of 100 deposited: -0.0357 price PnL and two 0.028 fees.
    const positions = await indexer.PerplPosition.getAll();
    t.expect(positions).toHaveLength(1);
    t.expect(positions[0]).toMatchObject({
      account_id: "1023",
      status: "CLOSED",
      isLong: true,
      deltaPnlCns: -35_700n,
      feesCns: 56_946n,
      realizedPnlCns: -92_646n,
      closePricePns: 825_109n,
      finalized: true,
    });
    t.expect(await indexer.AccountStats.getOrThrow(PASSKEY)).toMatchObject({
      perplVolume: 165_057_500n,
      perplRealizedPnl: -92_646n,
      realizedPnl: -92_646n,
      feesPaid: 56_946n,
      closedTrades: 1,
      losses: 1,
    });
    t.expect(await indexer.Account.getOrThrow(PASSKEY)).toMatchObject({
      kind: "PASSKEY",
      isPasskey: true,
      perplOpenPositionCount: 0,
      perplCollateral: 0n,
    });
    t.expect(await indexer.AccountStats.get(OUTSIDER)).toBeUndefined();
    t.expect(await indexer.PerplMarket.getOrThrow("16")).toMatchObject({
      trendrFillCount: 2,
      trendrVolume: 165_057_500n,
    });
    t.expect(await indexer.Protocol.getOrThrow("trendr")).toMatchObject({
      perplVolume: 165_057_500n,
      passkeyAccountCount: 1,
    });
  });

  it("indexes the Trendr bot's maker fills and adopts accounts whose owner delegates later", async (t) => {
    const indexer = newIndexer();
    presetBtc(indexer);
    await indexer.process({
      chains: {
        [CHAIN]: {
          simulate: [
            created(BOT, 1029n, 1),
            created(LATE, 1031n, 2),
            // The bot's resting short is hit: its position event, an order removal, then its maker fill.
            opened(1029n, 3, 1, 50n, 1n),
            {
              contract: "PerplExchange",
              event: "MakerOrderFilledV2",
              ...at(3, 3, tx(3)),
              params: {
                perpId: BTC,
                accountId: 1029n,
                orderId: 7n,
                pricePNS: 823_256n,
                lotLNS: 50n,
                feeCNS: 0n,
                lockedBalanceCNS: 0n,
                amountCNS: -20_583_400n,
                balanceCNS: 179_416_600n,
                builderId: 0n,
                builderFeeCNS: 0n,
              },
            },
            initialized(LATE, 4),
            // The bot adds 50 more at 82,280.0 as a taker: Perpl reports the new average entry, 82,302.8.
            {
              contract: "PerplExchange",
              event: "PositionIncreasedV2",
              ...at(5, 0, tx(5)),
              params: {
                perpId: BTC,
                accountId: 1029n,
                positionType: 1n,
                leverageHdths: 200n,
                startDepositCNS: 20_583_400n,
                endDepositCNS: 41_150_000n,
                pnlCollateralizedCNS: 0n,
                premiumPnlSettledCNS: 0n,
                maxNegPnlCollatBPS: 1000n,
                pricePNS: 823_028n,
                startLotLNS: 50n,
                endLotLNS: 100n,
                insFeeCNS: 0n,
                protFeeCNS: 0n,
                priceResiduePNSQ16: 0n,
              },
            },
            takerFill(5, 1, 822_800n, 50n, 14_198n, -20_584_198n, 179_416_600n - 20_584_198n),
          ],
        },
      },
    });

    t.expect(await indexer.Account.getOrThrow(BOT)).toMatchObject({
      kind: "BOT",
      perplAccount_id: "1029",
      perplOpenPositionCount: 1,
      perplCollateral: 179_416_600n - 20_584_198n,
    });
    const position = (await indexer.PerplPosition.getAll())[0];
    t.expect(position).toMatchObject({
      isLong: false,
      status: "OPEN",
      entryPricePns: 823_028n,
      lotLns: 100n,
      maxLotLns: 100n,
      feesCns: 14_198n,
    });
    t.expect(position?.entryPrice.toString()).toBe("82302.8");
    const increase = (await indexer.PerplFill.getAll()).find((f) => f.role === "TAKER");
    t.expect(increase).toMatchObject({
      account_id: "1029",
      action: "INCREASE",
      isLong: false,
      notionalCns: 41_140_000n,
      position_id: position?.id,
    });
    const fill = (await indexer.PerplFill.getAll()).find((f) => f.role === "MAKER");
    t.expect(fill).toMatchObject({
      account_id: "1029",
      role: "MAKER",
      action: "OPEN",
      isLong: false,
      orderId: 7n,
      notionalCns: 41_162_800n,
    });
    t.expect(fill?.position_id).toBeDefined();
    t.expect(await indexer.PerplAccount.getOrThrow("1031")).toMatchObject({ isTrendr: true, owner_id: LATE });
    t.expect(await indexer.Account.getOrThrow(LATE)).toMatchObject({
      kind: "PASSKEY",
      perplAccount_id: "1031",
      passkeyInitializedAt: BigInt(T0 + 4),
    });
  });
});
