import { encodeReport } from "../src/report";

/** The report contracts/test/unit/CreReportFixture.t.sol decodes through TrendRegistry. */
export const fixtureReport = () =>
  encodeReport(1_800_000_000n, 1_800_000_000n, {
    newTrends: [
      {
        identifier: "topic:world-cup",
        assetClass: 6,
        index: 12_340_000n,
        surfacer: "0x00000000000000000000000000000000000000a1",
        smartMoneyConfirmed: false,
      },
      {
        identifier: "crypto:mon",
        assetClass: 0,
        index: 33_000_000n,
        surfacer: "0x0000000000000000000000000000000000000000",
        smartMoneyConfirmed: true,
      },
    ],
    updates: [],
    settlements: [],
  });

export const FIXTURE_PATH = new URL("../../../../contracts/test/fixtures/cre-report.hex", import.meta.url).pathname;

if (import.meta.main) {
  await Bun.write(FIXTURE_PATH, `${fixtureReport()}\n`);
  console.log(`wrote ${FIXTURE_PATH}`);
}
