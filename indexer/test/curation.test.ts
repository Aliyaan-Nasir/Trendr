import { describe, it } from "vitest";
import { addr, at, CHAIN, CONTRACTS, id32, newIndexer, tx, units } from "./helpers";

const TREND_A = id32(1);
const TREND_B = id32(2);
const SURFACER = addr(0x51);

describe("CurationFees", () => {
  it("credits accruals per surfacer and trend, and clears the claimable balance on claim", async (t) => {
    const indexer = newIndexer();
    await indexer.process({
      chains: {
        [CHAIN]: {
          simulate: [
            {
              contract: "CurationFees",
              event: "Accrued",
              ...at(1, 0, tx(1)),
              params: { trendId: TREND_A, surfacer: SURFACER, source: CONTRACTS.perp, amount: units(0.03) },
            },
            {
              contract: "CurationFees",
              event: "Accrued",
              ...at(2, 0, tx(2)),
              params: { trendId: TREND_A, surfacer: SURFACER, source: CONTRACTS.curve, amount: units(0.1) },
            },
            {
              contract: "CurationFees",
              event: "Accrued",
              ...at(3, 0, tx(3)),
              params: { trendId: TREND_B, surfacer: SURFACER, source: CONTRACTS.perp, amount: units(0.02) },
            },
          ],
        },
      },
    });

    const accruals = await indexer.CurationAccrual.getAll();
    t.expect(accruals.map((a) => a.sourceProduct)).toEqual(["PERP", "CURVE", "PERP"]);
    t.expect(await indexer.CurationEarnings.getOrThrow(SURFACER)).toMatchObject({
      earned: units(0.15),
      claimable: units(0.15),
      claimed: 0n,
      accrualCount: 3,
      trendCount: 2,
    });
    t.expect(await indexer.TrendCuration.getOrThrow(`${TREND_A}-${SURFACER}`)).toMatchObject({
      earned: units(0.13),
      accrualCount: 2,
    });
    t.expect((await indexer.TrendStats.getOrThrow(TREND_A)).curationEarned).toBe(units(0.13));
    t.expect(await indexer.Account.getOrThrow(SURFACER)).toMatchObject({ curationClaimable: units(0.15) });

    await indexer.process({
      chains: {
        [CHAIN]: {
          simulate: [
            {
              contract: "CurationFees",
              event: "Claimed",
              ...at(4, 0, tx(4)),
              params: { account: SURFACER, to: addr(0x52), amount: units(0.15) },
            },
          ],
        },
      },
    });
    const earnings = await indexer.CurationEarnings.getOrThrow(SURFACER);
    t.expect(earnings).toMatchObject({ earned: units(0.15), claimed: units(0.15), claimable: 0n });
    t.expect(earnings.earnedAusd.toString()).toBe("0.15");
    t.expect(await indexer.CurationClaim.getAll()).toMatchObject([
      { account_id: SURFACER, earnings_id: SURFACER, recipient: addr(0x52), amount: units(0.15) },
    ]);
    t.expect(await indexer.Account.getOrThrow(SURFACER)).toMatchObject({ curationClaimable: 0n });
    t.expect(await indexer.Protocol.getOrThrow("trendr")).toMatchObject({
      curationAccrued: units(0.15),
      curationClaimed: units(0.15),
    });
  });
});
