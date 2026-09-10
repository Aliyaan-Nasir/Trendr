import type { HttpRequest } from "../http";

/**
 * Nansen smart-money netflows (https://docs.nansen.ai/api/smart-money/netflows): net USD flow of
 * smart-money wallets per token over 24 hours, summed across chains. The token filter takes
 * contract addresses, not tickers, so one call reads every token smart money traded (up to 1,000
 * rows, tokens above $1M market cap, most-traded first); a ticker missing from it had no
 * smart-money flow. Crypto trends need a positive confirmation before markets open.
 */

export function netflowRequest(baseUrl: string, apiKey: string, chains: readonly string[]): HttpRequest {
  return {
    url: `${baseUrl}/api/v1/smart-money/netflow`,
    method: "POST",
    headers: { apikey: apiKey, "content-type": "application/json" },
    body: JSON.stringify({
      chains,
      filters: { include_native_tokens: true, include_stablecoins: false, market_cap_usd: { min: 1_000_000 } },
      order_by: [{ field: "trader_count", direction: "DESC" }],
      pagination: { page: 1, per_page: 1000 },
    }),
  };
}

/** Net 24h smart-money flow (USD) per upper-case ticker, summed across chains. */
/** Wrapped and bridged forms count toward the asset they wrap. */
export const TICKER_ALIASES: Record<string, string> = {
  WBTC: "BTC",
  CBBTC: "BTC",
  BTCB: "BTC",
  TBTC: "BTC",
  WETH: "ETH",
  WSOL: "SOL",
  WMON: "MON",
};

export function parseNetflow(body: string): Map<string, number> {
  const json = JSON.parse(body) as { data?: Array<Record<string, unknown>> };
  if (!Array.isArray(json.data)) throw new Error("nansen: malformed netflow response");
  const out = new Map<string, number>();
  for (const row of json.data) {
    const symbol = row.token_symbol;
    const flow = row.net_flow_24h_usd;
    if (typeof symbol !== "string" || typeof flow !== "number" || !Number.isFinite(flow)) continue;
    const key = TICKER_ALIASES[symbol.toUpperCase()] ?? symbol.toUpperCase();
    out.set(key, (out.get(key) ?? 0) + flow);
  }
  return out;
}
