/** Response bodies shaped like each API's documented schema. */
export const elfaMentions = (total: number) =>
  JSON.stringify({ success: true, data: [{ tweetId: "1", link: "https://x.com/a/status/1" }], metadata: { total, cursor: 1 } });

export const elfaTrending = JSON.stringify({
  success: true,
  data: {
    page: 1,
    pageSize: 50,
    total: 3,
    data: [
      { token: "$MON", current_count: 900, previous_count: 300, change_percent: 200 },
      { token: "btc", current_count: 5000, previous_count: 4800, change_percent: 4.1 },
      { token: "bad token", current_count: 10, previous_count: 1, change_percent: 900 },
    ],
  },
});

export const redditSearch = (now: number) =>
  JSON.stringify({
    data: {
      children: [
        { data: { created_utc: now - 60, score: 120, num_comments: 30 } },
        { data: { created_utc: now - 1_800, score: 10, num_comments: 0 } },
        { data: { created_utc: now - 7_200, score: 5000, num_comments: 900 } }, // outside the hour
      ],
    },
  });

export const redditToken = JSON.stringify({ access_token: "t0k3n", token_type: "bearer", expires_in: 86400 });

export const nansenNetflow = JSON.stringify({
  data: [
    { token_symbol: "MON", chain: "monad", token_address: "0x1", net_flow_24h_usd: 150_000, net_flow_1h_usd: 1, net_flow_7d_usd: 1, net_flow_30d_usd: 1, token_sectors: [], trader_count: 9, token_age_days: 300 },
    { token_symbol: "mon", chain: "base", token_address: "0x2", net_flow_24h_usd: 50_000, net_flow_1h_usd: 1, net_flow_7d_usd: 1, net_flow_30d_usd: 1, token_sectors: [], trader_count: 3, token_age_days: 30 },
  ],
  pagination: { page: 1, per_page: 200, is_last_page: true },
});

export const wikiPageviews = (views: number) =>
  JSON.stringify({ items: [{ project: "en.wikipedia", article: "X", granularity: "daily", timestamp: "2026100800", access: "all-access", agent: "user", views }] });

/** The backend collector's /v1/oracle/measurements answer. */
export const collectorMeasurements = (
  observedAt: number,
  trends: Record<string, { article?: string | null; elfa?: number; gdelt?: number; wikipedia?: number; nansen?: number; bluesky?: number; hn?: number; ageSec?: number }>,
) =>
  JSON.stringify({
    observedAt,
    trends: Object.fromEntries(
      Object.entries(trends).map(([id, t]) => {
        const at = observedAt - (t.ageSec ?? 60);
        const r = (v: number | undefined) => (v === undefined ? null : { value: v, windowSec: 86_400, observedAt: at });
        return [id, { keywords: [], article: t.article ?? null, ticker: null, readings: { elfa: r(t.elfa), gdelt: r(t.gdelt), nansen: r(t.nansen), wikipedia: r(t.wikipedia), bluesky: r(t.bluesky), hn: r(t.hn) } }];
      }),
    ),
  });
