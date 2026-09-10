import type { HttpRequest } from "../http";

/**
 * Wikimedia pageviews (https://doc.wikimedia.org/generated-docs/analytics-api/): human views of a
 * trend's Wikipedia article over the last complete UTC day. Keyless; Wikimedia asks every client
 * to identify itself with a descriptive User-Agent. Daily data moves the index level slowly, while
 * Elfa and Reddit carry the intraday moves.
 */

/** `YYYYMMDD00` for the UTC day before `atSec`, the latest complete day. */
export function lastCompleteDay(atSec: number): string {
  const d = new Date((atSec - 86_400) * 1000);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}00`;
}

export function pageviewsRequest(project: string, article: string, day: string, userAgent: string): HttpRequest {
  return {
    url: `https://wikimedia.org/api/rest_v1/metrics/pageviews/per-article/${project}/all-access/user/${encodeURIComponent(article)}/daily/${day}/${day}`,
    method: "GET",
    headers: { "user-agent": userAgent, accept: "application/json" },
  };
}

export function parsePageviews(body: string): number {
  const json = JSON.parse(body) as { items?: Array<{ views?: unknown }> };
  if (!Array.isArray(json.items) || json.items.length === 0) throw new Error("wikipedia: no pageview items");
  let views = 0;
  for (const item of json.items) {
    if (typeof item.views !== "number" || !Number.isFinite(item.views)) throw new Error("wikipedia: malformed views");
    views += item.views;
  }
  return views;
}
