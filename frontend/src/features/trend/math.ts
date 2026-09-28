import type { OrderBook, Quote } from "@trendr/contracts";

/**
 * Pure numbers behind the trend page's tickets, mirroring the contracts so what the ticket shows
 * before confirming is what the chain does: AttentionPerp's fee, size, liquidation and funding,
 * and quotes against any Kuru book.
 */

const WAD = 10n ** 18n;
const BPS = 10_000n;
const INDEX_SCALE = 1_000_000n;
const AUSD = 1e6;

/** Monad makes a block every 400 ms. */
export const BLOCKS_PER_HOUR = 9_000;

export const PERP = {
  maxLeverage: 3,
  feeBps: 10n,
  maintenanceBps: 1_000n,
  /** Funding per block at full skew, as a 1e18 fraction of notional; also the cap. */
  maxFundingPerBlock: 2n * 10n ** 11n,
} as const;

/** The index never leaves 0 to 100 points. */
export const INDEX_MAX = 100;

export const leverageWad = (leverage: number) => BigInt(Math.round(leverage * 1e6)) * 10n ** 12n;
export const indexRaw = (points: number) => BigInt(Math.round(points * 1e6));

/** Signed funding rate per block (1e18 fraction of notional), positive when longs pay. */
export function fundingRate(longQty: bigint, shortQty: bigint): bigint {
  const total = longQty + shortQty;
  if (total === 0n || longQty === shortQty) return 0n;
  const diff = longQty > shortQty ? longQty - shortQty : shortQty - longQty;
  const r = (diff * PERP.maxFundingPerBlock) / total;
  const capped = r > PERP.maxFundingPerBlock ? PERP.maxFundingPerBlock : r;
  return longQty > shortQty ? capped : -capped;
}

/**
 * What one side earns or pays per hour, in percent of its notional: positive pays, negative
 * receives. The paying side pays the rate; the other side shares what it pays.
 */
export function fundingPerHourPct(longQty: bigint, shortQty: bigint, isLong: boolean): number {
  const rate = fundingRate(longQty, shortQty);
  if (rate === 0n) return 0;
  const perHour = (Number(rate < 0n ? -rate : rate) / 1e18) * BLOCKS_PER_HOUR * 100;
  const longsPay = rate > 0n;
  if (longsPay === isLong) return perHour;
  const [payQty, recvQty] = longsPay ? [longQty, shortQty] : [shortQty, longQty];
  return recvQty === 0n ? 0 : -perHour * (Number(payQty) / Number(recvQty));
}

export interface PerpPreview {
  /** Margin left after the opening fee (raw AUSD). */
  net: bigint;
  fee: bigint;
  notional: bigint;
  qty: bigint;
  /** AUSD gained or lost per index point. */
  perPoint: number;
  /** Index (points) at which the position can be liquidated, or null when it is out of the index's range. */
  liquidationIndex: number | null;
  /** Funding for this side once the trade is in, percent of notional per hour (positive pays). */
  fundingPerHourPct: number;
  /** This side's notional after the trade, to check against the open interest cap (raw AUSD). */
  sideNotionalAfter: bigint;
  /** Fee to close at today's index (raw AUSD). */
  closeFee: bigint;
}

/** AttentionPerp.openFor's arithmetic for a ticket, before it is sent. */
export function perpPreview(p: { margin: bigint; leverage: number; index: number; isLong: boolean; longQty: bigint; shortQty: bigint; unit: bigint }): PerpPreview | null {
  if (p.margin <= 0n || p.index <= 0 || p.leverage <= 0 || p.leverage > PERP.maxLeverage) return null;
  const lev = leverageWad(p.leverage);
  const idx = indexRaw(p.index);
  const net = (p.margin * BPS * WAD) / (BPS * WAD + lev * PERP.feeBps);
  const fee = p.margin - net;
  const notional = (net * lev) / WAD;
  const qty = (notional * WAD * INDEX_SCALE) / (idx * p.unit);
  if (qty === 0n) return null;
  const perPoint = Number((qty * p.unit) / WAD) / AUSD;
  const n = Number(net) / AUSD;
  const entry = p.index;
  // Equity (net + PnL) meets maintenance (10% of notional at the index), funding aside.
  const m = Number(PERP.maintenanceBps) / Number(BPS);
  const liq = p.isLong ? (perPoint * entry - n) / ((1 - m) * perPoint) : (n + perPoint * entry) / ((1 + m) * perPoint);
  const liquidationIndex = liq <= 0 || liq >= INDEX_MAX ? null : liq;
  const longAfter = p.longQty + (p.isLong ? qty : 0n);
  const shortAfter = p.shortQty + (p.isLong ? 0n : qty);
  const sideQty = p.isLong ? longAfter : shortAfter;
  return {
    net,
    fee,
    notional,
    qty,
    perPoint,
    liquidationIndex,
    fundingPerHourPct: fundingPerHourPct(longAfter, shortAfter, p.isLong),
    sideNotionalAfter: (sideQty * idx * p.unit) / (WAD * INDEX_SCALE),
    closeFee: (notional * PERP.feeBps) / BPS,
  };
}

/** The worst index a perp order accepts: above the current one for longs, below for shorts. */
export function acceptableIndex(index: number, isLong: boolean, slippageBps: number): bigint {
  const raw = indexRaw(index);
  return isLong ? (raw * (BPS + BigInt(slippageBps))) / BPS : (raw * (BPS - BigInt(slippageBps))) / BPS;
}

/** A Kuru market's units: prices in 1/pricePrecision quote per base token, sizes in 1/sizePrecision base tokens. */
export interface KuruParams {
  pricePrecision: bigint;
  sizePrecision: bigint;
  baseDecimals: number;
  quoteDecimals: number;
  takerFeeBps: bigint;
}

/** Raw quote for `price` units times `size` units. */
const levelCost = (k: KuruParams, price: bigint, size: bigint) => (price * size * 10n ** BigInt(k.quoteDecimals)) / (k.pricePrecision * k.sizePrecision);
const rawPerSize = (k: KuruParams) => 10n ** BigInt(k.baseDecimals) / k.sizePrecision;
const afterFee = (k: KuruParams, amount: bigint) => (amount * (BPS - k.takerFeeBps)) / BPS;

/** Base tokens (raw) that `quoteIn` (raw) buys from the asks, in whole size units, after the taker fee. */
export function kuruQuoteBuy(book: OrderBook, k: KuruParams, quoteIn: bigint): Quote {
  let left = quoteIn;
  let sizeUnits = 0n;
  let complete = false;
  for (const level of book.asks) {
    const price = BigInt(level.price);
    if (price === 0n) continue;
    const affordable = (left * k.pricePrecision * k.sizePrecision) / (price * 10n ** BigInt(k.quoteDecimals));
    if (affordable < level.size) {
      sizeUnits += affordable;
      left -= levelCost(k, price, affordable);
      complete = true;
      break;
    }
    sizeUnits += level.size;
    left -= levelCost(k, price, level.size);
  }
  const out = afterFee(k, sizeUnits * rawPerSize(k));
  const filled = quoteIn - left;
  const tokens = Number(out) / 10 ** k.baseDecimals;
  return { out, filled, complete: complete || left === 0n, averagePrice: tokens > 0 ? Number(filled) / 10 ** k.quoteDecimals / tokens : 0 };
}

/** Quote (raw) that selling `baseIn` (raw) into the bids returns, in whole size units, after the taker fee. */
export function kuruQuoteSell(book: OrderBook, k: KuruParams, baseIn: bigint): Quote {
  const wanted = baseIn / rawPerSize(k);
  let left = wanted;
  let quote = 0n;
  for (const level of book.bids) {
    if (left === 0n) break;
    const take = left < level.size ? left : level.size;
    quote += levelCost(k, BigInt(level.price), take);
    left -= take;
  }
  const out = afterFee(k, quote);
  const filled = (wanted - left) * rawPerSize(k);
  const tokens = Number(filled) / 10 ** k.baseDecimals;
  return { out, filled, complete: left === 0n, averagePrice: tokens > 0 ? Number(out) / 10 ** k.quoteDecimals / tokens : 0 };
}

/** Best bid and ask of a book in quote per base token. */
export function topOfBook(book: OrderBook | null, k: Pick<KuruParams, "pricePrecision">): { bid: number | null; ask: number | null } {
  const p = Number(k.pricePrecision);
  return { bid: book?.bids[0] ? book.bids[0].price / p : null, ask: book?.asks[0] ? book.asks[0].price / p : null };
}

export { formatAmount, parseAmount } from "@/lib/amount";
