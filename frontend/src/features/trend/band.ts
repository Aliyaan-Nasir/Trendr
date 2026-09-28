import { insideBand, type PriceBand, type Quote } from "@trendr/contracts";
import { cents } from "@/lib/format";

/**
 * Session or passkey for an UP or DOWN trade. A trading session trades only inside TrendrSpot's
 * band around the attention-implied value (see TrendrSpot), which keeps a stolen session key from
 * selling the account's tokens into its holder's bid. Anything else needs the passkey.
 */

/**
 * Whether a quoted trade needs the passkey: outside the band, or while TrendrSpot gives none (null:
 * the series closed or the oracle is stale). While the band loads (undefined) the session is tried.
 */
export function needsPasskey(quote: Quote | null, band: PriceBand | null | undefined, isBuy: boolean): boolean {
  if (!quote || band === undefined) return false;
  return band === null || !insideBand(quote, band, isBuy);
}

/** Why a trade needs the passkey, for the note above its button. */
export function passkeyReason(band: PriceBand | null): string {
  if (!band) return "Gas-free session trades of this series are paused until the attention index updates, so your passkey confirms this one.";
  const reach = Math.max(band.high - band.fair, band.fair - band.low);
  return `Session trades stay within ${cents(reach)} of the ${cents(band.fair)} the attention index implies. This price is further out, so your passkey confirms it.`;
}
