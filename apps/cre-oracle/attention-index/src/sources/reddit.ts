import { base64Utf8, type HttpRequest, query } from "../http";

/**
 * Reddit (https://www.reddit.com/dev/api): posts and engagement per trend in the measurement
 * window, through the application-only OAuth flow (client credentials). Reddit refuses
 * unauthenticated API access.
 */

export interface RedditActivity {
  posts: number;
  engagement: number;
}

export function tokenRequest(clientId: string, clientSecret: string, userAgent: string): HttpRequest {
  return {
    url: "https://www.reddit.com/api/v1/access_token",
    method: "POST",
    headers: {
      authorization: `Basic ${base64Utf8(`${clientId}:${clientSecret}`)}`,
      "content-type": "application/x-www-form-urlencoded",
      "user-agent": userAgent,
    },
    body: "grant_type=client_credentials",
  };
}

export function parseToken(body: string): string {
  const json = JSON.parse(body) as { access_token?: unknown };
  if (typeof json.access_token !== "string" || json.access_token.length === 0) {
    throw new Error("reddit: no access token");
  }
  return json.access_token;
}

export function searchRequest(token: string, keywords: readonly string[], userAgent: string): HttpRequest {
  const q = keywords.map((k) => (k.includes(" ") ? `"${k}"` : k)).join(" OR ");
  const qs = query([
    ["q", q],
    ["sort", "new"],
    ["t", "day"],
    ["limit", 100],
    ["raw_json", 1],
    ["type", "link"],
  ]);
  return {
    url: `https://oauth.reddit.com/search?${qs}`,
    method: "GET",
    headers: { authorization: `Bearer ${token}`, "user-agent": userAgent },
  };
}

/** Posts created inside [fromSec, toSec] and their summed score plus comments. */
export function parseSearch(body: string, fromSec: number, toSec: number): RedditActivity {
  const json = JSON.parse(body) as { data?: { children?: Array<{ data?: Record<string, unknown> }> } };
  const children = json.data?.children;
  if (!Array.isArray(children)) throw new Error("reddit: malformed search response");
  let posts = 0;
  let engagement = 0;
  for (const child of children) {
    const d = child.data ?? {};
    const created = d.created_utc;
    if (typeof created !== "number" || created < fromSec || created > toSec) continue;
    posts += 1;
    const score = typeof d.score === "number" ? Math.max(d.score, 0) : 0;
    const comments = typeof d.num_comments === "number" ? Math.max(d.num_comments, 0) : 0;
    engagement += score + comments;
  }
  return { posts, engagement };
}

/** Activity as one count: posts plus engagement converted to post-equivalents. */
export function activityCount(a: RedditActivity, engagementPerPost: number): number {
  return a.posts + a.engagement / engagementPerPost;
}
