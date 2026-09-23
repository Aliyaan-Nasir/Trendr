import type { CoinBalance, OutcomeTokenBalance, Token } from "envio";
import {
  type Context,
  isTrader,
  recordClosedTrade,
  recordRealizedPnl,
  updateAccount,
  updateTrendStats,
} from "./aggregates";
import { ausd, toDecimal, ZERO_DECIMAL, min } from "./units";

/**
 * Average-cost position book. `position` counts tokens bought (minted or filled) and not yet sold,
 * redeemed or paid out; `costBasis` is what they cost in AUSD.
 */
export interface Book {
  position: bigint;
  costBasis: bigint;
  realizedPnl: bigint;
}

export function bookBuy(book: Book, qty: bigint, cost: bigint): Book {
  return { ...book, position: book.position + qty, costBasis: book.costBasis + cost };
}

/**
 * Sells `qty` for `proceeds`. Only the part covered by the tracked position is realized: tokens
 * that arrived by plain transfer have no known cost, so their proceeds are not counted as profit.
 */
export function bookSell(book: Book, qty: bigint, proceeds: bigint): { book: Book; pnl: bigint; matched: bigint } {
  if (qty === 0n) return { book, pnl: 0n, matched: 0n };
  const matched = min(qty, book.position);
  if (matched === 0n) return { book, pnl: 0n, matched };
  const costOut = (book.costBasis * matched) / book.position;
  const proceedsMatched = (proceeds * matched) / qty;
  const pnl = proceedsMatched - costOut;
  return {
    book: {
      position: book.position - matched,
      costBasis: book.costBasis - costOut,
      realizedPnl: book.realizedPnl + pnl,
    },
    pnl,
    matched,
  };
}

// ---------------------------------------------------------------------------------------------
// Balance rows
// ---------------------------------------------------------------------------------------------

async function loadOutcomeBalance(
  context: Context,
  token: Token,
  account: string,
  timestamp: bigint,
): Promise<OutcomeTokenBalance> {
  return context.OutcomeTokenBalance.getOrCreate({
    id: `${token.id}-${account}`,
    account_id: account,
    token_id: token.id,
    series_id: token.series_id ?? "",
    trend_id: token.trend_id,
    side: token.kind,
    balance: 0n,
    balanceTokens: ZERO_DECIMAL,
    position: 0n,
    costBasis: 0n,
    realizedPnl: 0n,
    realizedPnlAusd: ZERO_DECIMAL,
    updatedAt: timestamp,
  });
}

async function loadCoinBalance(
  context: Context,
  token: Token,
  account: string,
  timestamp: bigint,
): Promise<CoinBalance> {
  return context.CoinBalance.getOrCreate({
    id: `${token.id}-${account}`,
    account_id: account,
    token_id: token.id,
    curve_id: token.trend_id,
    trend_id: token.trend_id,
    balance: 0n,
    balanceTokens: ZERO_DECIMAL,
    position: 0n,
    costBasis: 0n,
    realizedPnl: 0n,
    realizedPnlAusd: ZERO_DECIMAL,
    cyclePnl: 0n,
    updatedAt: timestamp,
  });
}

/**
 * An account holds a token while its wallet balance or its traded position is non-zero, so a
 * trader whose tokens rest in Kuru's MarginAccount behind an order still counts as a holder.
 */
const isHeld = (row: { balance: bigint; position: bigint }): boolean => row.balance > 0n || row.position > 0n;

/**
 * Keeps holder counts in step when an account starts or stops holding a token: the token's, the
 * trend's (an account counts once however many of the trend's tokens it holds) and the account's
 * own. Protocol contracts (Kuru's MarginAccount, vaults, Router) are never holders.
 */
async function updateHolding(
  context: Context,
  token: Token,
  account: string,
  wasHeld: boolean,
  nowHeld: boolean,
  timestamp: bigint,
): Promise<void> {
  if (wasHeld === nowHeld) return;
  const step = nowHeld ? 1 : -1;
  const isCoin = token.kind === "TREND_COIN";
  const holder = await updateAccount(context, account, timestamp, (a) =>
    a.kind === "PROTOCOL"
      ? {}
      : isCoin
        ? { coinHoldingCount: a.coinHoldingCount + step }
        : { outcomeHoldingCount: a.outcomeHoldingCount + step },
  );
  if (holder.kind === "PROTOCOL") return;

  const latest = await context.Token.get(token.id);
  if (latest) context.Token.set({ ...latest, holderCount: latest.holderCount + step });

  const ta = await context.TrendAccount.getOrCreate({
    id: `${token.trend_id}-${account}`,
    trend_id: token.trend_id,
    account_id: account,
    heldTokenCount: 0,
    volume: 0n,
    tradeCount: 0,
    realizedPnl: 0n,
    firstTradeAt: undefined,
    lastTradeAt: undefined,
  });
  const held = ta.heldTokenCount + step;
  context.TrendAccount.set({ ...ta, heldTokenCount: held });
  if ((nowHeld && held === 1) || (!nowHeld && held === 0)) {
    await updateTrendStats(context, token.trend_id, timestamp, (s) => ({ holderCount: s.holderCount + step }));
  }
}

/** Moves an account's wallet balance of `token` by `delta` (a Transfer). */
export async function applyBalanceChange(
  context: Context,
  token: Token,
  account: string,
  delta: bigint,
  timestamp: bigint,
): Promise<void> {
  const isCoin = token.kind === "TREND_COIN";
  const row = isCoin
    ? await loadCoinBalance(context, token, account, timestamp)
    : await loadOutcomeBalance(context, token, account, timestamp);
  const balance = row.balance + delta;
  const balanceTokens = toDecimal(balance, token.decimals);
  if (isCoin) context.CoinBalance.set({ ...(row as CoinBalance), balance, balanceTokens, updatedAt: timestamp });
  else
    context.OutcomeTokenBalance.set({ ...(row as OutcomeTokenBalance), balance, balanceTokens, updatedAt: timestamp });
  if (!isCoin)
    await updateAccount(context, account, timestamp, (a) => ({ outcomeTokensHeld: a.outcomeTokensHeld + delta }));
  await updateHolding(context, token, account, isHeld(row), isHeld({ balance, position: row.position }), timestamp);
}

// ---------------------------------------------------------------------------------------------
// Trades against the book
// ---------------------------------------------------------------------------------------------

export interface Leg {
  token: Token;
  isBuy: boolean;
  /** Token amount, raw units. */
  qty: bigint;
  /** AUSD paid (buy) or received (sell), raw units. */
  quote: bigint;
}

/**
 * Applies an account's outcome trade to its book. All legs belong to one series; a mint or a
 * redemption has two. A round trip closes when both sides of the series are back to zero.
 */
export async function applyOutcomeTrade(
  context: Context,
  account: string,
  legs: Leg[],
  timestamp: bigint,
): Promise<void> {
  const first = legs[0];
  if (!first || !isTrader(context, account)) return;
  const seriesId = first.token.series_id;
  if (!seriesId) return;

  const cycleId = `${seriesId}-${account}`;
  let cycle = await context.OutcomeCycle.getOrCreate({ id: cycleId, open: false, pnl: 0n });
  let realized = 0n;
  let bought = false;
  for (const leg of legs) {
    const row = await loadOutcomeBalance(context, leg.token, account, timestamp);
    let book: Book = { position: row.position, costBasis: row.costBasis, realizedPnl: row.realizedPnl };
    if (leg.isBuy) {
      book = bookBuy(book, leg.qty, leg.quote);
      bought = bought || leg.qty > 0n;
    } else {
      const sold = bookSell(book, leg.qty, leg.quote);
      book = sold.book;
      realized += sold.pnl;
    }
    context.OutcomeTokenBalance.set({
      ...row,
      ...book,
      realizedPnlAusd: ausd(book.realizedPnl),
      updatedAt: timestamp,
    });
    await updateHolding(
      context,
      leg.token,
      account,
      isHeld(row),
      isHeld({ balance: row.balance, position: book.position }),
      timestamp,
    );
  }

  if (bought && !cycle.open) cycle = { ...cycle, open: true, pnl: 0n };
  cycle = { ...cycle, pnl: cycle.pnl + realized };
  await recordRealizedPnl(context, {
    account,
    trendId: first.token.trend_id,
    product: "outcome",
    pnl: realized,
    timestamp,
  });

  if (cycle.open) {
    const series = await context.Series.get(seriesId);
    if (series) {
      const [up, down] = await Promise.all([
        context.OutcomeTokenBalance.get(`${series.upToken_id}-${account}`),
        context.OutcomeTokenBalance.get(`${series.downToken_id}-${account}`),
      ]);
      if ((up?.position ?? 0n) === 0n && (down?.position ?? 0n) === 0n) {
        await recordClosedTrade(context, account, cycle.pnl, timestamp);
        cycle = { ...cycle, open: false, pnl: 0n };
      }
    }
  }
  context.OutcomeCycle.set(cycle);
}

/** Applies an account's trend coin trade (curve or graduated market) to its book. */
export async function applyCoinTrade(context: Context, account: string, leg: Leg, timestamp: bigint): Promise<void> {
  if (!isTrader(context, account)) return;
  const row = await loadCoinBalance(context, leg.token, account, timestamp);
  let book: Book = { position: row.position, costBasis: row.costBasis, realizedPnl: row.realizedPnl };
  let cyclePnl = row.cyclePnl;
  let pnl = 0n;
  let closedTrip = false;
  if (leg.isBuy) {
    if (book.position === 0n) cyclePnl = 0n;
    book = bookBuy(book, leg.qty, leg.quote);
  } else {
    const sold = bookSell(book, leg.qty, leg.quote);
    book = sold.book;
    pnl = sold.pnl;
    cyclePnl += pnl;
    closedTrip = sold.matched > 0n && book.position === 0n;
  }
  context.CoinBalance.set({
    ...row,
    ...book,
    realizedPnlAusd: ausd(book.realizedPnl),
    cyclePnl,
    updatedAt: timestamp,
  });
  await updateHolding(
    context,
    leg.token,
    account,
    isHeld(row),
    isHeld({ balance: row.balance, position: book.position }),
    timestamp,
  );
  await recordRealizedPnl(context, { account, trendId: leg.token.trend_id, product: "curve", pnl, timestamp });
  if (closedTrip) await recordClosedTrade(context, account, cyclePnl, timestamp);
}

/** Routes a spot trade of any Trendr token to the right book. */
export async function applyTokenTrade(context: Context, account: string, leg: Leg, timestamp: bigint): Promise<void> {
  if (leg.token.kind === "TREND_COIN") await applyCoinTrade(context, account, leg, timestamp);
  else await applyOutcomeTrade(context, account, [leg], timestamp);
}
