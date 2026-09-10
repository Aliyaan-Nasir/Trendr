import { type HttpRequest, query } from "../http";

/**
 * Elfa API v2 (https://docs.elfa.ai): X and Telegram attention. Keyword mentions give each
 * trend's mention count over the last day (`metadata.total`, one credit per call; Elfa rejects
 * windows shorter than one day); trending tokens surface crypto candidates.
 */

/** Keyword-mentions windows must span one to thirty days. */
export const MENTIONS_WINDOW_SEC = 86_400;

export interface TrendingToken {
  token: string;
  currentCount: number;
  previousCount: number;
  changePercent: number;
}

export function keywordMentionsRequest(
  baseUrl: string,
  apiKey: string,
  keywords: readonly string[],
  fromSec: number,
  toSec: number,
): HttpRequest {
  const qs = query([
    ["keywords", keywords.slice(0, 5).join(",")],
    ["from", fromSec],
    ["to", toSec],
    ["limit", 1],
    ["searchType", "or"],
  ]);
  return { url: `${baseUrl}/v2/data/keyword-mentions?${qs}`, method: "GET", headers: { "x-elfa-api-key": apiKey } };
}

/** Total mentions in the window; Elfa caps `total` at 10,000. */
export function parseKeywordMentions(body: string): number {
  const json = JSON.parse(body) as { success?: boolean; metadata?: { total?: unknown } };
  const total = json.metadata?.total;
  if (json.success !== true || typeof total !== "number" || !Number.isFinite(total) || total < 0) {
    throw new Error("elfa: malformed keyword-mentions response");
  }
  return total;
}

export function trendingTokensRequest(
  baseUrl: string,
  apiKey: string,
  timeWindow: string,
  minMentions: number,
): HttpRequest {
  const qs = query([
    ["timeWindow", timeWindow],
    ["minMentions", minMentions],
    ["page", 1],
    ["pageSize", 50],
  ]);
  return {
    url: `${baseUrl}/v2/aggregations/trending-tokens?${qs}`,
    method: "GET",
    headers: { "x-elfa-api-key": apiKey },
  };
}

export function parseTrendingTokens(body: string): TrendingToken[] {
  const json = JSON.parse(body) as {
    success?: boolean;
    data?: { data?: Array<Record<string, unknown>> };
  };
  if (json.success !== true || !Array.isArray(json.data?.data)) throw new Error("elfa: malformed trending-tokens response");
  const out: TrendingToken[] = [];
  for (const row of json.data.data) {
    const token = row.token;
    const current = row.current_count;
    const previous = row.previous_count;
    const change = row.change_percent;
    if (typeof token !== "string" || typeof current !== "number" || typeof previous !== "number") continue;
    out.push({
      token: token.replace(/^\$/, ""),
      currentCount: current,
      previousCount: previous,
      changePercent: typeof change === "number" && Number.isFinite(change) ? change : 0,
    });
  }
  return out;
}
