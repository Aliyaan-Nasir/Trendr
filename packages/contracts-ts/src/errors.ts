import type { Abi } from "viem";
import {
  attentionPerpAbi,
  bondingCurveAbi,
  curationFeesAbi,
  kuruGraduationVenueAbi,
  outcomeListingAbi,
  outcomeMarketsAbi,
  outcomeTokenAbi,
  passkeyAccountAbi,
  perplOrderGuardAbi,
  trendCoinAbi,
  trendRegistryAbi,
  trendrSpotAbi,
} from "./abis";

/** Every Trendr contract ABI with custom errors, for decoding revert reasons. */
export const trendrErrorAbis: readonly Abi[] = [
  passkeyAccountAbi,
  perplOrderGuardAbi,
  outcomeMarketsAbi,
  outcomeListingAbi,
  attentionPerpAbi,
  bondingCurveAbi,
  curationFeesAbi,
  trendRegistryAbi,
  kuruGraduationVenueAbi,
  outcomeTokenAbi,
  trendCoinAbi,
  trendrSpotAbi,
] as Abi[];
