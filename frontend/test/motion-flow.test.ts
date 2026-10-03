import { describe, expect, test } from "bun:test";
import { outcomeMarketsAbi, trendrSpotAbi } from "@trendr/contracts";
import { type Address, encodeEventTopics, encodeAbiParameters, type Hex } from "viem";
import { rollDelay, rollDirection, rollText, ROLL_GAP_MS } from "../src/components/ui/roll";
import { DEFAULT_DRAFT, loosenTrigger } from "../src/features/autopilot/builder/rule-form";
import { faucetButton } from "../src/features/global/faucet-claims";
import { applyChanges, bookBuy, bookOf, bookSell, chooseBook, fillChanges, serverBooks, unrealized } from "../src/features/portfolio/cost-basis";
import { scrollEdges } from "../src/lib/edges";
import { tokenAmount, tokenNumber } from "../src/lib/format";
import { matchParts } from "../src/lib/highlight";

describe("rolling numbers", () => {
  test("one roll per gap: the first change rolls at once, the next waits out the gap", () => {
    expect(rollDelay(Number.NEGATIVE_INFINITY, 1_000)).toBe(0);
    expect(rollDelay(1_000, 1_000)).toBe(ROLL_GAP_MS);
    expect(rollDelay(1_000, 1_250)).toBe(ROLL_GAP_MS - 250);
    expect(rollDelay(1_000, 1_000 + ROLL_GAP_MS + 1)).toBe(0);
  });

  test("a flash says which way the value moved, never on the first value", () => {
    expect(rollDirection(null, 5)).toBeNull();
    expect(rollDirection(5, 5)).toBeNull();
    expect(rollDirection(5, 6)).toBe("up");
    expect(rollDirection(6, 5)).toBe("down");
  });

  test("the hidden text reads the way the screen used to write it", () => {
    expect(rollText(1234.5, { minimumFractionDigits: 2, maximumFractionDigits: 2 })).toBe("1,234.50");
    expect(rollText(-0.004, { minimumFractionDigits: 2, maximumFractionDigits: 2, signDisplay: "exceptZero" })).toBe("0.00");
    expect(rollText(53, { minimumFractionDigits: 1, maximumFractionDigits: 1 }, "", "c")).toBe("53.0c");
  });

  test("a token amount rolls to exactly what tokenAmount shows, cut and never rounded up", () => {
    for (const raw of [0n, 1_879_999n, 2_000_000n, 1_234_567_890_000n]) {
      expect(rollText(tokenNumber(raw, 6), { minimumFractionDigits: 2, maximumFractionDigits: 2 })).toBe(tokenAmount(raw, 6));
    }
  });
});

describe("search highlight", () => {
  test("splits around the first case-insensitive match", () => {
    expect(matchParts("Ethereum", "ther")).toEqual([
      { text: "E", hit: false },
      { text: "ther", hit: true },
      { text: "eum", hit: false },
    ]);
    expect(matchParts("Ethereum", "ETH")).toEqual([
      { text: "Eth", hit: true },
      { text: "ereum", hit: false },
    ]);
    expect(matchParts("Ethereum", "sol")).toEqual([{ text: "Ethereum", hit: false }]);
    expect(matchParts("Ethereum", "  ")).toEqual([{ text: "Ethereum", hit: false }]);
  });
});

describe("carousel edge fade", () => {
  test("fades only the ends that hide more cards", () => {
    expect(scrollEdges(0, 1000, 400)).toEqual({ start: false, end: true });
    expect(scrollEdges(300, 1000, 400)).toEqual({ start: true, end: true });
    expect(scrollEdges(600, 1000, 400)).toEqual({ start: true, end: false });
    expect(scrollEdges(599.5, 1000, 400)).toEqual({ start: true, end: false });
    expect(scrollEdges(0, 400, 400)).toEqual({ start: false, end: false });
  });
});

describe("faucet button", () => {
  const now = 1_000_000;
  test("success first, then the wait, then ready again", () => {
    expect(faucetButton({ kind: "claimed", nextAt: now + 3_600_000 }, now, "100.00")).toEqual({ label: "Claimed 100.00 AUSD", tone: "success" });
    expect(faucetButton({ kind: "claimed", nextAt: now + 3_600_000 }, now, null)).toEqual({ label: "Claimed today, next in 1h 0m", tone: "waiting" });
    expect(faucetButton({ kind: "refused", retryAt: now + 60_000 }, now, null)).toEqual({ label: "Claimed today", tone: "waiting" });
    expect(faucetButton({ kind: "ready" }, now, null)).toEqual({ label: "Get test AUSD", tone: "ready" });
  });
});

describe("loosen trigger", () => {
  test("halves the move, widens the window and drops the filters, saying each", () => {
    const r = loosenTrigger({ ...DEFAULT_DRAFT, change: "30", windowMin: 60, minIndex: "20", smartMoney: "buying" })!;
    expect(r.draft).toMatchObject({ change: "15", windowMin: 240, minIndex: "0", smartMoney: "any" });
    expect(r.changes).toEqual(["15% move", "4 hour window", "no minimum index", "any smart money"]);
  });

  test("never below a 5% move, and nothing left to loosen gives no suggestion", () => {
    expect(loosenTrigger({ ...DEFAULT_DRAFT, change: "8", windowMin: 4320, minIndex: "0", smartMoney: "any" })!.draft.change).toBe("5");
    expect(loosenTrigger({ ...DEFAULT_DRAFT, change: "5", windowMin: 4320, minIndex: "0", smartMoney: "any" })).toBeNull();
  });
});

describe("outcome cost basis", () => {
  const ME = "0x00000000000000000000000000000000000000a1" as Address;
  const OTHER = "0x00000000000000000000000000000000000000b2" as Address;
  const UP = "0x00000000000000000000000000000000000000c3" as Address;
  const DOWN = "0x00000000000000000000000000000000000000d4" as Address;
  const SERIES = `0x${"0e".repeat(32)}` as Hex;
  const s = { seriesId: SERIES, up: UP, down: DOWN };
  const MARKET = "0x00000000000000000000000000000000000000e5" as Address;

  const swap = (trader: Address, token: Address, isBuy: boolean, amountIn: bigint, amountOut: bigint) => ({
    topics: encodeEventTopics({ abi: trendrSpotAbi, eventName: "Swapped", args: { trader, token, market: MARKET } }) as Hex[],
    data: encodeAbiParameters([{ type: "bool" }, { type: "uint256" }, { type: "uint256" }, { type: "address" }], [isBuy, amountIn, amountOut, trader]),
  });
  const minted = (to: Address, amount: bigint) => ({
    topics: encodeEventTopics({ abi: outcomeMarketsAbi, eventName: "SetsMinted", args: { seriesId: SERIES, payer: to, to } }) as Hex[],
    data: encodeAbiParameters([{ type: "uint256" }], [amount]),
  });

  test("average cost: buys add, sales take out their share", () => {
    let b = bookBuy({ position: 0n, cost: 0n }, 10_000_000n, 5_000_000n);
    b = bookBuy(b, 10_000_000n, 7_000_000n);
    expect(b).toEqual({ position: 20_000_000n, cost: 12_000_000n });
    b = bookSell(b, 5_000_000n);
    expect(b).toEqual({ position: 15_000_000n, cost: 9_000_000n });
    // More than the book holds takes only what it holds.
    expect(bookSell(b, 99_000_000n)).toEqual({ position: 0n, cost: 0n });
  });

  test("entry and PnL show only when the book covers the whole balance", () => {
    const book = { position: 10_000_000n, cost: 4_000_000n };
    const u = unrealized(book, 10_000_000n, 0.55)!;
    expect(u.average).toBeCloseTo(0.4);
    expect(u.value).toBeCloseTo(5.5);
    expect(u.pnl).toBeCloseTo(1.5);
    expect(u.pct).toBeCloseTo(37.5);
    expect(unrealized(book, 12_000_000n, 0.55)).toBeNull();
    expect(unrealized(book, 10_000_000n, null)).toBeNull();
    expect(unrealized(null, 10_000_000n, 0.55)).toBeNull();
  });

  test("reads the account's own swaps and mints from a receipt, ignoring everyone else's", () => {
    const changes = fillChanges([swap(ME, UP, true, 5_000_000n, 9_000_000n), swap(OTHER, UP, true, 1n, 1n), swap(ME, DOWN, false, 2_000_000n, 1_100_000n), minted(ME, 3_000_001n)], ME, s);
    expect(changes).toEqual([
      { token: UP, kind: "buy", qty: 9_000_000n, cost: 5_000_000n },
      { token: DOWN, kind: "sell", qty: 2_000_000n },
      { token: UP, kind: "buy", qty: 3_000_001n, cost: 1_500_000n },
      { token: DOWN, kind: "buy", qty: 3_000_001n, cost: 1_500_001n },
    ]);
  });

  test("a book left behind by a sale elsewhere restarts when the balance was empty", () => {
    const stale = { [UP.toLowerCase()]: { p: "4000000", c: "2000000" } };
    const fresh = applyChanges(stale, [{ token: UP, kind: "buy", qty: 1_000_000n, cost: 600_000n }], new Map([[UP.toLowerCase(), 0n]]));
    expect(bookOf(fresh, UP)).toEqual({ position: 1_000_000n, cost: 600_000n });
    // With a balance it does not match, it carries on (and stays unshown).
    const kept = applyChanges(stale, [{ token: UP, kind: "buy", qty: 1_000_000n, cost: 600_000n }], new Map([[UP.toLowerCase(), 7_000_000n]]));
    expect(bookOf(kept, UP)).toEqual({ position: 5_000_000n, cost: 2_600_000n });
    // Redeemed winnings clear the book.
    expect(bookOf(applyChanges(kept, [{ token: UP, kind: "clear" }], new Map()), UP)).toBeNull();
    // A fill's block time stays with the book it changed.
    expect(bookOf(applyChanges(stale, [{ token: UP, kind: "buy", qty: 1_000_000n, cost: 600_000n }], new Map(), 1_000), UP)).toEqual({ position: 5_000_000n, cost: 2_600_000n, at: 1_000 });
  });

  test("the indexer's books come from the outcomes route, raw, per token", () => {
    const books = serverBooks([
      { up: UP, down: DOWN, upPosition: "10000000", downPosition: "0", upCostBasis: "4000000", downCostBasis: "0", upUpdatedAt: 900, downUpdatedAt: 0 },
      // An older backend serves no books.
      { up: `0x${"f".repeat(40)}`, down: `0x${"e".repeat(40)}` },
    ] as unknown as Parameters<typeof serverBooks>[0]);
    expect(books.get(UP.toLowerCase())).toEqual({ position: 10_000_000n, cost: 4_000_000n, at: 900 });
    expect(books.get(DOWN.toLowerCase())).toEqual({ position: 0n, cost: 0n, at: 0 });
    expect(books.size).toBe(2);
  });

  test("a position shows the indexer's book first, this device's when the indexer trails it, never one that misses the balance", () => {
    const server = { position: 10_000_000n, cost: 4_000_000n, at: 900 };
    const device = { position: 10_000_000n, cost: 4_200_000n, at: 800 };
    // Both account for the balance: the indexer, which has every device's trades.
    expect(chooseBook(server, device, 10_000_000n)).toEqual({ book: server, source: "server" });
    // A device without a record (a fresh browser) still gets the indexer's.
    expect(chooseBook(server, null, 10_000_000n)?.source).toBe("server");
    // The indexer trails a fill this device just made: the device's record, newer, covers it.
    const fresher = { position: 12_000_000n, cost: 5_000_000n, at: 1_000 };
    expect(chooseBook(server, fresher, 12_000_000n)).toEqual({ book: fresher, source: "device" });
    // A trailing indexer is not trusted even where its position happens to equal the balance
    // (sold 2 and bought 2 back on this device): only a record that covers the balance shows.
    expect(chooseBook(server, { position: 3_000_000n, cost: 1_000_000n, at: 1_000 }, 10_000_000n)).toBeNull();
    // Nothing covers the balance: no entry rather than a wrong one.
    expect(chooseBook(server, device, 11_000_000n)).toBeNull();
    expect(chooseBook(null, null, 10_000_000n)).toBeNull();
    expect(chooseBook(server, device, 0n)).toBeNull();
    // An old record without a block time never overrides the indexer.
    expect(chooseBook(server, { position: 10_000_000n, cost: 1n }, 10_000_000n)?.source).toBe("server");
  });
});
