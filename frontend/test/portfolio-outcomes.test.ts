import { describe, expect, mock, test } from "bun:test";
import { legacyOutcomeMarkets } from "@trendr/contracts";
import type { Address, Hex } from "viem";
import type { IndexedOutcomeHolding, Trend } from "../src/lib/api";
import { DEPLOYMENT } from "../src/lib/config";

/**
 * Outcome holdings on a device that has never seen the account: the indexer names old series the
 * chain's lens no longer lists, and the chain alone decides what is held and how each settled.
 */

const OWNER = "0x00000000000000000000000000000000000000a1" as Address;
const TREND = `0x${"0b".repeat(32)}` as Hex;
const id = (n: number) => `0x${n.toString(16).padStart(64, "0")}` as Hex;
const token = (n: number) => `0x${n.toString(16).padStart(40, "0")}` as Address;
const ZERO = "0x0000000000000000000000000000000000000000";
const NOW = 1_800_000_000;

const LATEST = id(1);
const SETTLED = id(2);
const SOLD = id(3);
const OTHER_CONTRACT = id(4);
/** A series of the OutcomeMarkets this deployment replaced. */
const LEGACY = id(5);
const LEGACY_MARKETS = legacyOutcomeMarkets(DEPLOYMENT.chainId)[0]!;

/** Series as OutcomeMarkets.seriesOf returns them, by id. */
const chainSeries: Record<string, { openedAt: bigint; expiry: bigint; openingIndex: bigint; settlementIndex: bigint; window: number; outcome: number; up: Address; down: Address }> = {
  [SETTLED]: { openedAt: BigInt(NOW - 3 * 86_400), expiry: BigInt(NOW - 2 * 86_400), openingIndex: 60_000_000n, settlementIndex: 66_500_000n, window: 86_400, outcome: 1, up: token(0x21), down: token(0x22) },
  [SOLD]: { openedAt: BigInt(NOW - 3 * 86_400), expiry: BigInt(NOW - 2 * 86_400), openingIndex: 60_000_000n, settlementIndex: 58_000_000n, window: 86_400, outcome: 2, up: token(0x31), down: token(0x32) },
  [LEGACY]: { openedAt: BigInt(NOW - 3 * 86_400), expiry: BigInt(NOW - 2 * 86_400), openingIndex: 40_000_000n, settlementIndex: 28_000_000n, window: 86_400, outcome: 2, up: token(0x41), down: token(0x42) },
};
/** Live token balances of OWNER. The indexer said SOLD was still held; the chain says otherwise. */
const balances: Record<string, bigint> = { [token(0x21)]: 12_500_000n, [token(0x22)]: 2_000_000n, [token(0x31)]: 0n, [token(0x32)]: 0n, [token(0x11)]: 0n, [token(0x12)]: 0n, [token(0x41)]: 25_000_000n, [token(0x42)]: 25_000_000n };
const seriesReads: Array<{ seriesId: Hex; outcomeMarkets: Address }> = [];

type Read = { address: Address; functionName: string; args?: readonly unknown[] };
function answer(c: Read): unknown {
  if (c.functionName === "balanceOf") return c.address.toLowerCase() === DEPLOYMENT.ausd.toLowerCase() ? 40_000_000n : (balances[c.address] ?? 0n);
  if (c.functionName === "seriesOf") {
    // Each series is read from the OutcomeMarkets that issued it.
    expect(c.address).toBe(c.args![0] === LEGACY ? LEGACY_MARKETS : DEPLOYMENT.outcomeMarkets);
    seriesReads.push({ seriesId: c.args![0] as Hex, outcomeMarkets: c.address });
    const s = chainSeries[c.args![0] as string];
    return s ? { trendId: TREND, ...s } : { trendId: id(0), openedAt: 0n, expiry: 0n, openingIndex: 0n, settlementIndex: 0n, window: 0, outcome: 0, up: ZERO, down: ZERO };
  }
  if (c.functionName === "marketsOf") return [ZERO, ZERO, false, false];
  throw new Error(`unexpected read ${c.functionName}`);
}

mock.module("../src/lib/chain/client", () => ({
  publicClient: {
    readContract: async (c: Read) => {
      if (c.functionName !== "series") throw new Error(`unexpected read ${c.functionName}`);
      // The lens lists each trend's latest series only.
      return [{ trendId: TREND, window: 3600, seriesId: LATEST, openedAt: BigInt(NOW - 600), expiry: BigInt(NOW + 3000), openingIndex: 70_000_000n, outcome: 0, up: token(0x11), down: token(0x12), upMarket: ZERO, downMarket: ZERO, listed: false }];
    },
    multicall: async ({ contracts, allowFailure }: { contracts: Read[]; allowFailure: boolean }) => contracts.map((c) => (allowFailure ? { status: "success", result: answer(c) } : answer(c))),
  },
}));

const { indexedSeries, readOutcomeHoldings, seriesBeyondLatest } = await import("../src/features/portfolio/reads");

const indexedRow = (seriesId: Hex, outcomeMarkets: Address = DEPLOYMENT.outcomeMarkets): IndexedOutcomeHolding => ({
  seriesId,
  trendId: TREND,
  identifier: "crypto:eth",
  outcomeMarkets: outcomeMarkets.toLowerCase() as Address,
  window: 86_400,
  openedAt: NOW - 3 * 86_400,
  expiry: NOW - 2 * 86_400,
  openingIndex: 60,
  outcome: "open",
  settlementIndex: null,
  up: token(0x21),
  down: token(0x22),
  upMarket: null,
  downMarket: null,
  upBalance: "99000000",
  downBalance: "0",
});

describe("series beyond the lens", () => {
  const ref = (seriesId: Hex, outcomeMarkets: Address = DEPLOYMENT.outcomeMarkets) => ({ seriesId, outcomeMarkets });

  test("remembered and indexed series are read once each, never the latest again", () => {
    const latest = new Set([LATEST.toLowerCase()]);
    const upper = SETTLED.toUpperCase().replace("0X", "0x") as Hex;
    expect(seriesBeyondLatest([SETTLED, LATEST], [ref(upper), ref(SOLD), ref(LATEST)], latest)).toEqual([ref(SETTLED), ref(SOLD)]);
  });

  test("a replaced OutcomeMarkets' series is its own, even under an id this device remembers", () => {
    expect(seriesBeyondLatest([LEGACY], [ref(LEGACY, LEGACY_MARKETS)], new Set())).toEqual([ref(LEGACY), ref(LEGACY, LEGACY_MARKETS)]);
  });

  test("only series this app's OutcomeMarkets or a replaced one issued are taken from the indexer", () => {
    const rows = [indexedRow(SETTLED), indexedRow(OTHER_CONTRACT, token(0xee)), indexedRow(LEGACY, LEGACY_MARKETS), { ...indexedRow(SOLD), seriesId: "0xnot-an-id" as Hex }];
    expect(indexedSeries(rows)).toEqual([ref(SETTLED), ref(LEGACY, LEGACY_MARKETS)]);
  });
});

describe("readOutcomeHoldings", () => {
  test("a fresh device shows an old settled series the indexer names, with balances and outcome from the chain", async () => {
    const trends = [{ id: TREND, identifier: "crypto:eth", displayName: "Ethereum", index: 64 } as Trend];
    const indexed = indexedSeries([indexedRow(SETTLED), indexedRow(SOLD), indexedRow(LEGACY, LEGACY_MARKETS)]);
    const { holdings, cash } = await readOutcomeHoldings(OWNER, trends, indexed, NOW);
    expect(cash).toBe(40_000_000n);
    expect(seriesReads).toEqual(indexed);
    // SOLD is gone on chain whatever the indexer said, and the latest series holds nothing.
    expect(holdings.map((h) => h.seriesId)).toEqual([SETTLED, LEGACY]);
    expect(holdings[0]).toMatchObject({ outcomeMarkets: DEPLOYMENT.outcomeMarkets, legacy: false, phase: "settled", outcome: 1, settledOnChain: true, settlementIndex: 66.5, upBalance: 12_500_000n, downBalance: 2_000_000n, sets: 2_000_000n, value: 12.5 });
    // The replaced deployment's settled series shows with what it redeems for, and never trades.
    expect(holdings[1]).toMatchObject({ outcomeMarkets: LEGACY_MARKETS, legacy: true, phase: "settled", outcome: 2, settlementIndex: 28, upBalance: 25_000_000n, downBalance: 25_000_000n, sets: 25_000_000n, value: 25, upMarket: null, downMarket: null });
  });
});
