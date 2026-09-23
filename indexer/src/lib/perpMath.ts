import { AUSD_DECIMALS, FUNDING_RATE_PER_BLOCK_AT_FULL_SKEW, MAX_FUNDING_RATE_PER_BLOCK, WAD } from "./constants";
import { abs, min } from "./units";

const UNIT = 10n ** BigInt(AUSD_DECIMALS);
const INDEX_SCALE = 1_000_000n;

/** AUSD notional of `qty` contracts at `index` (AttentionPerp._notional). */
export const notional = (qty: bigint, index: bigint): bigint => (qty * index * UNIT) / (WAD * INDEX_SCALE);

/** AttentionPerp._rate: per-block funding at the given skew, positive when longs pay. */
export function fundingRate(longQty: bigint, shortQty: bigint): bigint {
  const total = longQty + shortQty;
  if (total === 0n || longQty === shortQty) return 0n;
  const rate = min((abs(longQty - shortQty) * FUNDING_RATE_PER_BLOCK_AT_FULL_SKEW) / total, MAX_FUNDING_RATE_PER_BLOCK);
  return longQty > shortQty ? rate : -rate;
}
