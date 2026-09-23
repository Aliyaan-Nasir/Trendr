import { BigDecimal } from "envio";
import { AUSD_DECIMALS, INDEX_DECIMALS } from "./constants";

/** A raw integer amount as a decimal with `decimals` places. */
export function toDecimal(raw: bigint, decimals: number): BigDecimal {
  return new BigDecimal(raw.toString()).shiftedBy(-decimals);
}

export const ausd = (raw: bigint): BigDecimal => toDecimal(raw, AUSD_DECIMALS);
export const points = (raw: bigint): BigDecimal => toDecimal(raw, INDEX_DECIMALS);

export const ZERO_DECIMAL = new BigDecimal(0);

/** numerator / denominator as a decimal, zero when the denominator is zero. */
export function ratio(numerator: bigint, denominator: bigint, decimals = 18): BigDecimal {
  if (denominator === 0n) return ZERO_DECIMAL;
  return new BigDecimal(numerator.toString()).div(denominator.toString()).decimalPlaces(decimals);
}

export const SECONDS_PER_DAY = 86_400n;

/** Start of the UTC day containing `timestamp`, unix seconds. */
export function dayStart(timestamp: bigint): bigint {
  return (timestamp / SECONDS_PER_DAY) * SECONDS_PER_DAY;
}

export const abs = (x: bigint): bigint => (x < 0n ? -x : x);
export const min = (a: bigint, b: bigint): bigint => (a < b ? a : b);
export const max = (a: bigint, b: bigint): bigint => (a > b ? a : b);

/** Floor of a * b / d for non-negative inputs. */
export function mulDiv(a: bigint, b: bigint, d: bigint): bigint {
  return d === 0n ? 0n : (a * b) / d;
}
