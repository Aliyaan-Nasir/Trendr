import { describe, expect, test } from "bun:test";
import { attentionPerpAbi, type Deployment, outcomeMarketsAbi } from "@trendr/contracts";
import { decodeFunctionData, type Hex } from "viem";
import { MAX_RETIRED_SETTLEMENTS, plan } from "../src/plan";
import { Outcome, type SeriesState, type Snapshot, Status, type TrendState } from "../src/snapshot";

const addr = (n: number) => `0x${n.toString(16).padStart(40, "0")}` as const;
const id = (n: number) => `0x${n.toString(16).padStart(64, "0")}` as Hex;
const ZERO = id(0);

const d = {
  trendRegistry: addr(1),
  outcomeMarkets: addr(2),
  outcomeListing: addr(3),
  attentionPerp: addr(4),
  bondingCurve: addr(5),
} as unknown as Deployment;

const NOW = 1_000_000n;
const params = { stalenessLimit: 600n, retireWindow: 3600n, staleRetireWindow: 7200n };

function trend(n: number, over: Partial<TrendState> = {}): TrendState {
  return { id: id(n), identifier: `topic:t${n}`, status: Status.Active, index: 40_000_000n, updatedAt: NOW - 30n, statusSince: NOW - 10_000n, ...over };
}

function series(trendN: number, window: number, over: Partial<SeriesState> = {}): SeriesState {
  return { trendId: id(trendN), window, seriesId: id(1000 + trendN * 10 + window), expiry: NOW + 100n, outcome: Outcome.Open, settleable: false, listed: true, ...over };
}

function snap(over: Partial<Snapshot>): Snapshot {
  return { block: 1n, now: NOW, params, windows: [86400, 604800], trends: [], series: [], positions: [], perpMarkets: [], readyCurves: [], ...over };
}

const cfg = { seriesWindows: [86400, 604800], listWindows: [86400, 604800] };
const kinds = (s: Snapshot) => plan(s, d, cfg).map((a) => a.key);

describe("plan", () => {
  test("a quiet protocol needs nothing", () => {
    expect(kinds(snap({ trends: [trend(1)], series: [series(1, 86400), series(1, 604800)] }))).toEqual([]);
  });

  test("opens the first series of each configured window on a fresh active trend", () => {
    const s = snap({ trends: [trend(1)], series: [series(1, 86400, { seriesId: ZERO }), series(1, 604800, { seriesId: ZERO })] });
    const actions = plan(s, d, cfg);
    expect(actions.map((a) => a.key)).toEqual([`openSeries:${id(1)}:86400`, `openSeries:${id(1)}:604800`]);
    const call = decodeFunctionData({ abi: outcomeMarketsAbi, data: actions[0]!.data });
    expect(call.functionName).toBe("openSeries");
    expect(call.args).toEqual(["topic:t1", 86400]);
  });

  test("opens no series on a stale, cooling or retired trend, or in an unconfigured window", () => {
    const empty = (n: number) => [series(n, 86400, { seriesId: ZERO }), series(n, 900, { seriesId: ZERO })];
    const s = snap({
      windows: [86400, 604800, 900],
      trends: [trend(1, { updatedAt: NOW - 601n }), trend(2, { status: Status.Cooling, statusSince: NOW - 100n }), trend(3, { status: Status.Retired }), trend(4)],
      series: [...empty(1), ...empty(2), ...empty(3), ...empty(4)],
    });
    expect(kinds(s)).toEqual([`openSeries:${id(4)}:86400`]);
  });

  test("settles, and rolls a window only after its series settled", () => {
    const s = snap({
      trends: [trend(1)],
      series: [series(1, 86400, { expiry: NOW - 5n, settleable: true }), series(1, 604800, { outcome: Outcome.Down })],
    });
    const keys = kinds(s);
    expect(keys).toContain(`settle:${id(1000 + 10 + 86400)}`);
    expect(keys).toContain(`openSeries:${id(1)}:604800`);
    expect(keys).not.toContain(`openSeries:${id(1)}:86400`);
  });

  test("lists open, unexpired series in listed windows only", () => {
    const s = snap({
      windows: [86400, 604800, 900],
      trends: [trend(1)],
      series: [series(1, 86400, { listed: false }), series(1, 900, { listed: false }), series(1, 604800, { listed: false, expiry: NOW })],
    });
    expect(plan(s, d, { seriesWindows: [86400, 604800, 900], listWindows: [86400, 604800] }).map((a) => a.key)).toEqual([
      `list:${id(1000 + 10 + 86400)}`,
    ]);
  });

  test("settles a retired trend's expired series, and never lists or rolls one", () => {
    const retired = trend(1, { status: Status.Retired, updatedAt: NOW - 50_000n, statusSince: NOW - 40_000n });
    const s = snap({
      trends: [retired],
      series: [series(1, 86400, { expiry: NOW - 5n, settleable: true }), series(1, 604800, { listed: false, expiry: NOW + 500_000n })],
    });
    expect(kinds(s)).toEqual([`settle:${id(1000 + 10 + 86400)}`]);
    // Once it settled, the window gets no next series either.
    expect(kinds(snap({ trends: [retired], series: [series(1, 86400, { outcome: Outcome.Up })] }))).toEqual([]);
  });

  test("retires stale trends and trends that cooled for the retire window", () => {
    const s = snap({
      trends: [
        trend(1, { updatedAt: NOW - 7200n }),
        trend(2, { status: Status.Cooling, statusSince: NOW - 3600n }),
        trend(3, { status: Status.Cooling, statusSince: NOW - 3599n }),
        trend(4, { status: Status.Retired, updatedAt: 0n }),
      ],
    });
    expect(kinds(s)).toEqual([`retire:${id(1)}`, `retire:${id(2)}`]);
  });

  test("liquidates before anything else and settles retired positions", () => {
    const pos = (n: number, over: object) => ({ id: BigInt(n), trendId: id(1), owner: addr(9), equity: 0n, maintenance: 1n, liquidatable: false, retired: false, ...over });
    const s = snap({
      trends: [trend(1)],
      series: [series(1, 86400, { expiry: NOW - 1n, settleable: true })],
      positions: [pos(7, { liquidatable: true }), pos(8, { retired: true }), pos(9, {})],
      readyCurves: [id(1)],
    });
    const actions = plan(s, d, cfg);
    expect(actions.map((a) => a.kind)).toEqual(["liquidate", "settleRetired", "graduate", "settle"]);
    expect(decodeFunctionData({ abi: attentionPerpAbi, data: actions[0]!.data }).args).toEqual([7n]);
  });

  test("plans every liquidation ahead of retired settlements, which are capped per scan", () => {
    const pos = (n: number, over: object) => ({ id: BigInt(n), trendId: id(1), owner: addr(9), equity: 0n, maintenance: 1n, liquidatable: false, retired: false, ...over });
    // Ten small retired positions with low ids, then one that needs liquidating.
    const retired = Array.from({ length: 10 }, (_, i) => pos(i + 1, { retired: true }));
    const s = snap({ trends: [trend(1)], positions: [...retired, pos(50, { liquidatable: true })] });
    const actions = plan(s, d, cfg);
    expect(actions[0]!.kind).toBe("liquidate");
    expect(actions.filter((a) => a.kind === "settleRetired")).toHaveLength(MAX_RETIRED_SETTLEMENTS);
  });

  test("marks funding when a market's mark lags the index", () => {
    const s = snap({
      trends: [trend(1), trend(2), trend(3, { status: Status.Retired })],
      perpMarkets: [
        { trendId: id(1), openInterest: 5n, lastMark: 39_000_000n },
        { trendId: id(2), openInterest: 5n, lastMark: 40_000_000n },
        { trendId: id(3), openInterest: 5n, lastMark: 1n },
      ],
    });
    expect(kinds(s)).toEqual([`poke:${id(1)}`]);
  });
});

describe("graduation on a permissioned Kuru router", () => {
  test("plans no graduate when the venue cannot list", () => {
    const s = snap({ trends: [trend(1)], readyCurves: [id(1)] });
    expect(plan(s, d, { ...cfg, graduate: false }).some((a) => a.kind === "graduate")).toBe(false);
    expect(plan(s, d, cfg).some((a) => a.kind === "graduate")).toBe(true);
  });
});
