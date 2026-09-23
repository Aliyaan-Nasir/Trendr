import type { KuruMarket, Token } from "envio";
import { type Context, updateAccount, updateProtocol } from "./aggregates";
import { AUSD_DECIMALS, OUTCOME_MARKET_PARAMS } from "./constants";
import { ZERO_DECIMAL } from "./units";

export interface RecordMarket {
  market: string;
  token: Token;
  quoteToken: string;
  deployedByTrendr: boolean;
  timestamp: bigint;
  blockNumber: number;
}

/**
 * Records a Trendr token's Kuru market. Parameters come from the Router's MarketRegistered when it
 * was seen (it precedes graduation listings, and adopted outcome markets); outcome markets
 * deployed by OutcomeListing are recorded just before the Router registers them, so they start
 * from OutcomeListing's fixed parameters and the registration confirms them.
 */
export async function recordKuruMarket(context: Context, r: RecordMarket): Promise<KuruMarket | undefined> {
  const existing = await context.KuruMarket.get(r.market);
  if (existing) return existing;
  const registration = await context.KuruMarketRegistration.get(r.market);
  const params = registration ?? (r.token.kind === "TREND_COIN" ? undefined : OUTCOME_MARKET_PARAMS);
  if (!params) {
    context.log.warn(`Kuru market ${r.market} of ${r.token.id} has no registered parameters`);
    return undefined;
  }
  const market: KuruMarket = {
    id: r.market,
    kind: r.token.kind,
    baseToken_id: r.token.id,
    quoteToken: r.quoteToken,
    trend_id: r.token.trend_id,
    series_id: r.token.series_id,
    vault: registration?.vault,
    pricePrecision: params.pricePrecision,
    sizePrecision: params.sizePrecision,
    tickSize: params.tickSize,
    minSize: params.minSize,
    maxSize: params.maxSize,
    takerFeeBps: params.takerFeeBps,
    makerFeeBps: params.makerFeeBps,
    baseDecimals: r.token.decimals,
    quoteDecimals: AUSD_DECIMALS,
    deployedByTrendr: r.deployedByTrendr,
    recordedAt: r.timestamp,
    recordedBlock: r.blockNumber,
    volumeBase: 0n,
    volumeBaseTokens: ZERO_DECIMAL,
    volumeQuote: 0n,
    volumeAusd: ZERO_DECIMAL,
    fillCount: 0,
    lastPrice: undefined,
    lastPriceAusd: undefined,
    lastTradeAt: undefined,
    openOrderCount: 0,
  };
  context.KuruMarket.set(market);

  const token = await context.Token.get(r.token.id);
  if (token) context.Token.set({ ...token, market_id: r.market });
  if (r.token.series_id) {
    const series = await context.Series.get(r.token.series_id);
    if (series) {
      context.Series.set({
        ...series,
        upMarket_id: series.upToken_id === r.token.id ? r.market : series.upMarket_id,
        downMarket_id: series.downToken_id === r.token.id ? r.market : series.downMarket_id,
      });
    }
  }
  // The book and its vault only hold tokens on behalf of traders.
  await markInfrastructure(context, r.market, r.timestamp);
  if (registration) await markInfrastructure(context, registration.vault, r.timestamp);
  await updateProtocol(context, r.timestamp, (p) => ({ kuruMarketCount: p.kuruMarketCount + 1 }));
  return market;
}

/** Marks a contract address (such as a Kuru AMM vault) so it never counts as a holder or trader. */
export async function markInfrastructure(context: Context, address: string, timestamp: bigint): Promise<void> {
  await updateAccount(context, address, timestamp, () => ({ kind: "PROTOCOL" }));
}
