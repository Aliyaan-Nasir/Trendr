"use client";
import { useQuery } from "@tanstack/react-query";
import { outcomeMarketsAbi, trendrSpotAbi } from "@trendr/contracts";
import { useSyncExternalStore } from "react";
import { type Address, decodeEventLog, erc20Abi, type Hex, type Log } from "viem";
import { ApiError, history, type IndexedOutcomeHolding } from "@/lib/api";
import { publicClient } from "@/lib/chain/client";

/**
 * What the account paid for each UP and DOWN token it holds, at average cost, so a position can
 * show its entry and unrealized PnL. Trendr's indexer keeps that book for every account from all
 * of its trades (a swap at its AUSD leg, a minted pair at 0.50 AUSD a side, a sale or a redeemed
 * pair taking out average cost), and the backend's outcomes route serves it, so it follows the
 * account to any device.
 *
 * The indexer can trail the chain, so the app also records each fill it makes from the
 * transaction's own receipt, by the same rules. A position shows the indexer's book when it
 * accounts for the whole balance and includes this device's latest fill, else this device's
 * record when that accounts for the whole balance, else value only, never a guess.
 */

/** Tokens held (6 decimals) and what they cost (AUSD, 6 decimals). */
export interface CostBook {
  position: bigint;
  cost: bigint;
  /** Block time (seconds) of the last fill the book includes; absent when unknown. */
  at?: number;
}

const EMPTY: CostBook = { position: 0n, cost: 0n };

export function bookBuy(book: CostBook, qty: bigint, cost: bigint): CostBook {
  return { position: book.position + qty, cost: book.cost + cost };
}

/** Takes `qty` out at average cost; what the book never held has no cost to take. */
export function bookSell(book: CostBook, qty: bigint): CostBook {
  const matched = qty < book.position ? qty : book.position;
  if (matched === 0n) return book;
  const out = (book.cost * matched) / book.position;
  return { position: book.position - matched, cost: book.cost - out };
}

export interface Unrealized {
  /** AUSD paid for the whole balance. */
  cost: number;
  /** Average price paid per token (0 to 1 AUSD). */
  average: number;
  /** AUSD at `price`, and the gain over cost. */
  value: number;
  pnl: number;
  /** Percent of cost. */
  pct: number;
}

/**
 * Entry and unrealized PnL of `balance` tokens at `price` (AUSD per token), or null when the book
 * does not cover exactly that balance or there is no price.
 */
export function unrealized(book: CostBook | null, balance: bigint, price: number | null): Unrealized | null {
  if (!book || balance === 0n || book.position !== balance || price === null) return null;
  const tokens = Number(balance) / 1e6;
  const cost = Number(book.cost) / 1e6;
  const value = tokens * price;
  return { cost, average: cost / tokens, value, pnl: value - cost, pct: cost > 0 ? ((value - cost) / cost) * 100 : 0 };
}

// ---------------------------------------------------------------------------------------------
// The record, per account and token, in this browser
// ---------------------------------------------------------------------------------------------

const KEY = (account: string) => `trendr.cost-basis:${account.toLowerCase()}`;
const EVENT = "trendr-cost-basis";
type Stored = Record<string, { p: string; c: string; t?: number }>;

function read(account: string): Stored {
  try {
    const raw = localStorage.getItem(KEY(account));
    const v = raw ? (JSON.parse(raw) as unknown) : {};
    return v && typeof v === "object" ? (v as Stored) : {};
  } catch {
    return {};
  }
}

function write(account: string, all: Stored) {
  try {
    localStorage.setItem(KEY(account), JSON.stringify(all));
  } catch {
    // Storage blocked: entries last this visit only as far as the screen shows them.
  }
  window.dispatchEvent(new Event(EVENT));
}

export function bookOf(all: Stored, token: string): CostBook | null {
  const e = all[token.toLowerCase()];
  if (!e) return null;
  try {
    return { position: BigInt(e.p), cost: BigInt(e.c), ...(typeof e.t === "number" ? { at: e.t } : {}) };
  } catch {
    return null;
  }
}

const put = (all: Stored, token: string, book: CostBook, at: number | undefined) => {
  if (book.position === 0n) delete all[token.toLowerCase()];
  else all[token.toLowerCase()] = { p: book.position.toString(), c: book.cost.toString(), ...(at !== undefined ? { t: at } : {}) };
};

/** One fill's effect on a series' two books, from its receipt's logs. */
export interface SeriesTokens {
  seriesId: Hex;
  up: Address;
  down: Address;
}

type Change = { token: Address; kind: "buy"; qty: bigint; cost: bigint } | { token: Address; kind: "sell"; qty: bigint } | { token: Address; kind: "clear" };

/** The account's changes to the series' books in a transaction's logs. */
export function fillChanges(logs: readonly Pick<Log, "data" | "topics">[], account: Address, s: SeriesTokens): Change[] {
  const me = account.toLowerCase();
  const side = (t: string) => (t.toLowerCase() === s.up.toLowerCase() ? s.up : t.toLowerCase() === s.down.toLowerCase() ? s.down : null);
  const ours = (id: string) => id.toLowerCase() === s.seriesId.toLowerCase();
  const out: Change[] = [];
  for (const log of logs) {
    const swap = decode(trendrSpotAbi, log, "Swapped");
    if (swap) {
      const a = swap.args as { trader: Address; token: Address; isBuy: boolean; amountIn: bigint; amountOut: bigint };
      const token = side(a.token);
      if (token && a.trader.toLowerCase() === me) out.push(a.isBuy ? { token, kind: "buy", qty: a.amountOut, cost: a.amountIn } : { token, kind: "sell", qty: a.amountIn });
      continue;
    }
    const ev = decode(outcomeMarketsAbi, log, "SetsMinted", "SetsRedeemed", "WinningsRedeemed");
    if (!ev) continue;
    const a = ev.args as { seriesId: Hex; to?: Address; owner?: Address; amount?: bigint };
    if (!ours(a.seriesId)) continue;
    if (ev.eventName === "SetsMinted" && a.to?.toLowerCase() === me) {
      const half = a.amount! / 2n;
      out.push({ token: s.up, kind: "buy", qty: a.amount!, cost: half }, { token: s.down, kind: "buy", qty: a.amount!, cost: a.amount! - half });
    } else if (ev.eventName === "SetsRedeemed" && a.owner?.toLowerCase() === me) {
      out.push({ token: s.up, kind: "sell", qty: a.amount! }, { token: s.down, kind: "sell", qty: a.amount! });
    } else if (ev.eventName === "WinningsRedeemed" && a.owner?.toLowerCase() === me) {
      out.push({ token: s.up, kind: "clear" }, { token: s.down, kind: "clear" });
    }
  }
  return out;
}

function decode(abi: typeof trendrSpotAbi | typeof outcomeMarketsAbi, log: Pick<Log, "data" | "topics">, ...names: string[]) {
  try {
    const ev = decodeEventLog({ abi, data: log.data, topics: log.topics as [Hex, ...Hex[]] });
    return names.includes(ev.eventName) ? ev : null;
  } catch {
    return null;
  }
}

/**
 * Applies `changes` to the books. `before` is each token's balance before the fill: a book that
 * did not match it restarts from an empty position when there was none, and otherwise stays
 * unmatched (so it is not shown). `at` is the fill's block time, when known.
 */
export function applyChanges(all: Stored, changes: Change[], before: Map<string, bigint>, at?: number): Stored {
  const next = { ...all };
  for (const c of changes) {
    const key = c.token.toLowerCase();
    let book = bookOf(next, key) ?? EMPTY;
    const held = before.get(key);
    if (held === 0n && book.position !== 0n) book = EMPTY;
    put(next, key, c.kind === "buy" ? bookBuy(book, c.qty, c.cost) : c.kind === "sell" ? bookSell(book, c.qty) : EMPTY, at);
    // Later changes to the same token in this fill follow on from this one.
    if (held !== undefined) before.delete(key);
  }
  return next;
}

/** Records a filled outcome trade from its receipt. Never throws: the entry is a convenience. */
export async function recordFill(account: Address, hash: Hex, s: SeriesTokens): Promise<void> {
  try {
    const receipt = await publicClient.getTransactionReceipt({ hash });
    const changes = fillChanges(receipt.logs, account, s);
    if (changes.length === 0) return;
    // Balances just before the fill, to restart a book that a sale elsewhere left behind.
    const tokens = [...new Set(changes.map((c) => c.token.toLowerCase()))] as Address[];
    const before = new Map<string, bigint>();
    // The fill's block time tells whether the indexer's book includes it yet.
    let at: number | undefined;
    await Promise.all([
      ...tokens.map(async (t) => {
        try {
          before.set(t, await publicClient.readContract({ address: t, abi: erc20Abi, functionName: "balanceOf", args: [account], blockNumber: receipt.blockNumber - 1n }));
        } catch {
          // Unknown: the book carries on as it was.
        }
      }),
      publicClient
        .getBlock({ blockNumber: receipt.blockNumber })
        .then((b) => (at = Number(b.timestamp)))
        .catch(() => undefined),
    ]);
    write(account, applyChanges(read(account), changes, before, at));
  } catch {
    // The receipt could not be read: this fill goes unrecorded, and its position shows value only.
  }
}

// ---------------------------------------------------------------------------------------------
// Reading it in components
// ---------------------------------------------------------------------------------------------

let cache: { account: string; raw: string | null; all: Stored } | null = null;
const NONE: Stored = {};

function snapshot(account: string | undefined): Stored {
  if (!account) return NONE;
  let raw: string | null = null;
  try {
    raw = localStorage.getItem(KEY(account));
  } catch {
    return NONE;
  }
  if (!cache || cache.account !== account || cache.raw !== raw) cache = { account, raw, all: read(account) };
  return cache.all;
}

function subscribe(notify: () => void) {
  window.addEventListener(EVENT, notify);
  window.addEventListener("storage", notify);
  return () => {
    window.removeEventListener(EVENT, notify);
    window.removeEventListener("storage", notify);
  };
}

function useDeviceBooks(account: string | undefined): Stored {
  return useSyncExternalStore(
    subscribe,
    () => snapshot(account),
    () => NONE,
  );
}

// ---------------------------------------------------------------------------------------------
// The indexer's books, and which book a position shows
// ---------------------------------------------------------------------------------------------

/**
 * The backend's indexed outcome holdings of `address`. The portfolio reads its series from the
 * same query, so one request serves both.
 */
export function indexedOutcomesQuery(address: string | undefined) {
  return {
    queryKey: ["indexed-outcomes", address?.toLowerCase()] as const,
    enabled: Boolean(address),
    refetchInterval: 60_000,
    retry: (n: number, e: Error) => !(e instanceof ApiError && (e.status === 503 || e.status === 400)) && n < 1,
    queryFn: async () => (await history.outcomes(address!)).holdings,
  };
}

/** The indexer's book of each UP and DOWN token, by lowercase address (older backends serve none). */
export function serverBooks(rows: readonly IndexedOutcomeHolding[]): Map<string, CostBook> {
  const out = new Map<string, CostBook>();
  const add = (token: string, position: string | undefined, cost: string | undefined, at: number | undefined) => {
    if (position === undefined || cost === undefined) return;
    try {
      out.set(token.toLowerCase(), { position: BigInt(position), cost: BigInt(cost), at: at ?? 0 });
    } catch {
      // A malformed figure: no book rather than a wrong one.
    }
  };
  for (const r of rows) {
    add(r.up, r.upPosition, r.upCostBasis, r.upUpdatedAt);
    add(r.down, r.downPosition, r.downCostBasis, r.downUpdatedAt);
  }
  return out;
}

export interface ChosenBook {
  book: CostBook;
  source: "server" | "device";
}

/**
 * The book behind a position of `balance` tokens. The indexer's counts every device's trades, so
 * it comes first, unless it trails a fill this device recorded (the indexer is behind) or does
 * not account for the whole balance; then this device's record, when that accounts for it. Null
 * when neither does: the position then shows value only.
 */
export function chooseBook(server: CostBook | null, device: CostBook | null, balance: bigint): ChosenBook | null {
  if (balance === 0n) return null;
  const behind = server !== null && device !== null && (device.at ?? 0) > (server.at ?? 0);
  if (server && !behind && server.position === balance) return { book: server, source: "server" };
  if (device && device.position === balance) return { book: device, source: "device" };
  return null;
}

/**
 * The account's cost books (empty during server rendering): `pick` chooses the book for a token
 * and its live balance, and `indexed` says whether the indexer's books arrived (so a position
 * without a book is waiting on the indexer rather than unknown to this device).
 */
export function useCostBooks(account: string | undefined): { pick: (token: string, balance: bigint) => ChosenBook | null; indexed: boolean } {
  const device = useDeviceBooks(account);
  const server = useQuery({ ...indexedOutcomesQuery(account), select: serverBooks });
  const books = server.data;
  return {
    pick: (token, balance) => chooseBook(books?.get(token.toLowerCase()) ?? null, bookOf(device, token), balance),
    indexed: books !== undefined,
  };
}
