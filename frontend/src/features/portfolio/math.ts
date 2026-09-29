import type { OrderBook } from "@trendr/contracts";

/**
 * The portfolio's arithmetic, mirroring the contracts:
 *
 * - AUSD and outcome tokens carry 6 decimals (OutcomeToken takes the collateral's decimals), and a
 *   complete set (one UP plus one DOWN) mints and redeems for exactly 1 AUSD, so 1e6 raw of a
 *   token is one token and a set is worth 1.00 AUSD at any time.
 * - Kuru outcome books price in 0.0001 AUSD per token; the mid is the value of an unpaired token
 *   while its series is open. After settlement a winning token is worth 1 AUSD, a losing one 0,
 *   and every token of a void series 0.50.
 * - Trend coins carry 18 decimals; BondingCurve.spotPrice is AUSD raw per whole coin, 1e18-scaled.
 * - AttentionPerp: qty is 1e18-scaled contracts, each worth `unit` raw AUSD per index point
 *   (unit is 1e6, so one contract moves 1 AUSD per point). Maintenance margin is 10% of notional.
 */

export const AUSD_UNIT = 1e6;
export const toAusd = (raw: bigint) => Number(raw) / AUSD_UNIT;
export const toTokens = (raw: bigint, decimals = 6) => Number(raw) / 10 ** decimals;

/** 0 open, 1 UP won, 2 DOWN won, 3 void (OutcomeMarkets.Outcome). */
export type Outcome = 0 | 1 | 2 | 3;

/** What one token of each side redeems for once the outcome is known. */
export function payoutPerToken(outcome: Outcome): { up: number; down: number } | null {
  if (outcome === 1) return { up: 1, down: 0 };
  if (outcome === 2) return { up: 0, down: 1 };
  if (outcome === 3) return { up: 0.5, down: 0.5 };
  return null;
}

/** The outcome a registry settlement decides: UP only when strictly above the opening index. */
export const settledOutcome = (openingIndex: number, settlementIndex: number): Outcome => (settlementIndex > openingIndex ? 1 : 2);

/** Raw AUSD that redeemWinnings pays for these balances (void pays half of each, rounded down). */
export function winningsRaw(outcome: Outcome, up: bigint, down: bigint): bigint {
  if (outcome === 1) return up;
  if (outcome === 2) return down;
  if (outcome === 3) return up / 2n + down / 2n;
  return 0n;
}

export interface OutcomeValue {
  /** AUSD, or null when part of the holding has no price yet. */
  value: number | null;
  /** Complete sets held (raw): each redeems for 1 AUSD. */
  sets: bigint;
}

/**
 * The value of an outcome holding: complete sets at 1.00 each (they redeem for exactly that), the
 * unpaired remainder at the side's mid while open, or at the payout once the outcome is known.
 */
export function outcomeValue(p: { up: bigint; down: bigint; outcome: Outcome | null; upMid: number | null; downMid: number | null }): OutcomeValue {
  const sets = p.up < p.down ? p.up : p.down;
  const known = p.outcome === null ? null : payoutPerToken(p.outcome);
  if (known) return { value: Number(winningsRaw(p.outcome!, p.up, p.down)) / AUSD_UNIT, sets };
  const upLeft = p.up - sets;
  const downLeft = p.down - sets;
  let value = toAusd(sets);
  if (upLeft > 0n) {
    if (p.upMid === null) return { value: null, sets };
    value += toTokens(upLeft) * p.upMid;
  }
  if (downLeft > 0n) {
    if (p.downMid === null) return { value: null, sets };
    value += toTokens(downLeft) * p.downMid;
  }
  return { value, sets };
}

export interface PerpNumbers {
  /** AUSD per index point (signed: positive for longs). */
  perPoint: number;
  /** Notional at the current index, AUSD. */
  notional: number;
  leverage: number;
  /** Equity less margin: price PnL net of funding so far, AUSD. */
  pnl: number;
  pnlPct: number;
  /** Index (points) at which equity falls below maintenance, or null when it never does in 0 to 1000. */
  liquidationIndex: number | null;
  /** Equity left above maintenance, as a share of equity (0 = liquidatable). */
  cushion: number;
}

const MAINTENANCE = 0.1;

/**
 * A position's numbers from the lens (equity already includes funding accrued to now).
 * Equity moves `k` AUSD per point with the index (k = qty x unit / 1e18 / 1e6), so with E the
 * equity at the current index i and maintenance 10% of notional:
 *   long:  E + k(x - i) = 0.1 k x  =>  x = (k i - E) / (0.9 k)
 *   short: E - k(x - i) = 0.1 k x  =>  x = (E + k i) / (1.1 k)
 */
export function perpNumbers(p: { isLong: boolean; qty: bigint; unit: bigint; index: number; margin: bigint; equity: bigint }): PerpNumbers {
  const k = (Number(p.qty) * Number(p.unit)) / 1e18 / AUSD_UNIT;
  const equity = toAusd(p.equity);
  const margin = toAusd(p.margin);
  const notional = k * p.index;
  let liq: number | null = p.isLong ? (k * p.index - equity) / ((1 - MAINTENANCE) * k) : (equity + k * p.index) / ((1 + MAINTENANCE) * k);
  if (!Number.isFinite(liq) || liq <= 0 || liq > 1000) liq = null;
  const maintenance = MAINTENANCE * notional;
  return {
    perPoint: p.isLong ? k : -k,
    notional,
    leverage: margin > 0 ? notional / margin : 0,
    pnl: equity - margin,
    pnlPct: margin > 0 ? ((equity - margin) / margin) * 100 : 0,
    liquidationIndex: liq,
    cushion: equity > 0 ? Math.max(0, (equity - maintenance) / equity) : 0,
  };
}

/** The liquidation index after adding `extra` AUSD of margin (equity rises by the same). */
export function liquidationAfterMargin(p: { isLong: boolean; qty: bigint; unit: bigint; index: number; equity: bigint }, extraRaw: bigint) {
  return perpNumbers({ ...p, margin: 1n, equity: p.equity + extraRaw }).liquidationIndex;
}

/** The closing fee AttentionPerp charges: 0.1% of notional at the exit index. */
export const closeFee = (notional: number) => notional * 0.001;

/** AUSD out for selling `tokensIn` raw into a Kuru book of any precision, after the taker fee. */
export function kuruSellQuote(book: OrderBook, params: { pricePrecision: number; sizePrecision: number; baseDecimals: number; quoteDecimals: number; takerFeeBps: number }, tokensIn: bigint) {
  const baseUnit = 10n ** BigInt(params.baseDecimals);
  const wanted = (tokensIn * BigInt(params.sizePrecision)) / baseUnit;
  let left = wanted;
  let quoteRaw = 0n;
  const scale = BigInt(params.pricePrecision) * BigInt(params.sizePrecision);
  const quoteUnit = 10n ** BigInt(params.quoteDecimals);
  for (const level of book.bids) {
    if (left === 0n) break;
    const take = left < level.size ? left : level.size;
    quoteRaw += (take * BigInt(level.price) * quoteUnit) / scale;
    left -= take;
  }
  const out = (quoteRaw * BigInt(10_000 - params.takerFeeBps)) / 10_000n;
  return { out, complete: left === 0n };
}
