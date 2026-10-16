import { describe, expect, test } from "bun:test";
import { base64Utf8 } from "../src/http";
import * as candidates from "../src/sources/candidates";
import * as collector from "../src/sources/collector";
import * as elfa from "../src/sources/elfa";
import * as nansen from "../src/sources/nansen";
import * as reddit from "../src/sources/reddit";
import * as wikipedia from "../src/sources/wikipedia";
import { elfaMentions, elfaTrending, nansenNetflow, redditSearch, redditToken, wikiPageviews } from "./fixtures";

describe("sources", () => {
  test("base64 matches the platform encoder", () => {
    for (const s of ["", "a", "ab", "abc", "client:secret", "ünïcode ✓"]) {
      expect(base64Utf8(s)).toBe(Buffer.from(s, "utf8").toString("base64"));
    }
  });

  test("elfa keyword mentions", () => {
    const req = elfa.keywordMentionsRequest("https://api.elfa.ai", "k", ["world cup", "fifa"], 100, 86_500);
    expect(req.url).toBe("https://api.elfa.ai/v2/data/keyword-mentions?keywords=world%20cup%2Cfifa&from=100&to=86500&limit=1&searchType=or");
    expect(req.headers["x-elfa-api-key"]).toBe("k");
    expect(elfa.parseKeywordMentions(elfaMentions(420))).toBe(420);
    expect(() => elfa.parseKeywordMentions(JSON.stringify({ success: false }))).toThrow();
  });

  test("elfa trending tokens become crypto candidates", () => {
    const tokens = elfa.parseTrendingTokens(elfaTrending);
    expect(tokens.map((t) => t.token)).toEqual(["MON", "btc", "bad token"]);
    expect(candidates.fromTrendingTokens(tokens, 2).map((c) => c.identifier)).toEqual(["crypto:mon", "crypto:btc"]);
  });

  test("reddit counts posts and engagement in the window", () => {
    const now = 1_000_000;
    expect(reddit.parseToken(redditToken)).toBe("t0k3n");
    const a = reddit.parseSearch(redditSearch(now), now - 3600, now);
    expect(a).toEqual({ posts: 2, engagement: 160 });
    expect(reddit.activityCount(a, 50)).toBeCloseTo(5.2);
    const t = reddit.tokenRequest("id", "secret", "ua");
    expect(t.headers.authorization).toBe(`Basic ${Buffer.from("id:secret").toString("base64")}`);
    expect(reddit.searchRequest("tok", ["world cup", "fifa"], "ua").url).toContain("q=%22world%20cup%22%20OR%20fifa");
  });

  test("wikipedia reads the last complete UTC day", () => {
    expect(wikipedia.lastCompleteDay(Date.UTC(2026, 9, 9, 13, 0, 0) / 1000)).toBe("2026100800");
    expect(wikipedia.lastCompleteDay(Date.UTC(2026, 0, 1, 0, 30, 0) / 1000)).toBe("2025123100");
    const req = wikipedia.pageviewsRequest("en.wikipedia", "Monad_(blockchain)", "2026100800", "ua");
    expect(req.url).toBe(
      "https://wikimedia.org/api/rest_v1/metrics/pageviews/per-article/en.wikipedia/all-access/user/Monad_(blockchain)/daily/2026100800/2026100800",
    );
    expect(req.headers["user-agent"]).toBe("ua");
    expect(wikipedia.parsePageviews(wikiPageviews(1234))).toBe(1234);
    expect(() => wikipedia.parsePageviews(JSON.stringify({ items: [] }))).toThrow();
  });

  test("nansen sums flows per ticker across chains", () => {
    const flows = nansen.parseNetflow(nansenNetflow);
    expect(flows.get("MON")).toBe(200_000);
    const req = nansen.netflowRequest("https://api.nansen.ai", "key", ["all"]);
    // The token filter takes contract addresses only, so the request reads every traded token.
    expect(JSON.parse(req.body ?? "{}").filters).not.toHaveProperty("token_address");
    expect(req.headers.apikey).toBe("key");
  });

  test("candidates parse, normalize and dedupe deterministically", () => {
    const body = JSON.stringify({
      candidates: [
        { identifier: "Topic:World Cup", keywords: ["World Cup"], surfacer: "0x00000000000000000000000000000000000000A1" },
        { identifier: "!!!" },
        { identifier: "topic:alpha", surfacer: "not an address" },
      ],
    });
    const parsed = candidates.parseCandidates(body);
    expect(parsed).toEqual([
      { identifier: "topic:world-cup", assetClass: 6, keywords: ["World Cup"], surfacer: "0x00000000000000000000000000000000000000a1", priority: 0 },
    ]);
    const merged = candidates.canonicalCandidates([[candidates.toCandidate("topic:b")!], parsed, [candidates.toCandidate("topic:world-cup")!]], 5);
    expect(merged.map((c) => c.identifier)).toEqual(["topic:world-cup", "topic:b"]);
    expect(merged[0]?.keywords).toEqual(["World Cup"]);
  });

  test("the rotating list is optional, string-only and bounded", () => {
    expect(candidates.parseRotating(JSON.stringify({ candidates: [] }))).toEqual([]);
    expect(candidates.parseRotating(JSON.stringify({ candidates: [], rotating: "topic:a.2" }))).toEqual([]);
    expect(candidates.parseRotating(JSON.stringify({ candidates: [], rotating: ["topic:a.2", 7, "", "person:b"] }))).toEqual(["topic:a.2", "person:b"]);
    expect(candidates.parseRotating(JSON.stringify({ rotating: Array.from({ length: 80 }, (_, i) => `topic:t${i}`) }))).toHaveLength(50);
  });

  test("pinned topics form a tier ahead of the queue, first in every turn", () => {
    const parsed = candidates.parseCandidates(JSON.stringify({ candidates: [{ identifier: "topic:a" }, { identifier: "topic:b" }, { identifier: "crypto:eth", pinned: true }, { identifier: "topic:c", pinned: "yes" }] }));
    expect(parsed.find((c) => c.identifier === "crypto:eth")?.pinned).toBe(true);
    expect(parsed.find((c) => c.identifier === "topic:a")?.pinned).toBeUndefined();
    for (const rotation of [0, 1, 2, 7]) {
      expect(candidates.canonicalCandidates([parsed], 10, rotation)[0]?.identifier).toBe("crypto:eth");
    }
  });

  test("rotation turns each tier in its own order and keeps the tiers' precedence", () => {
    const queue = ["topic:c", "topic:a", "topic:b"].map((x, i) => ({ ...candidates.toCandidate(x)!, priority: candidates.PRIORITY_QUEUE + i / 100_000 }));
    const seeds = ["topic:s1", "topic:s2"].map((x) => candidates.toCandidate(x)!);
    const ids = (rotation: number, max = 10) => candidates.canonicalCandidates([queue, seeds], max, rotation).map((c) => c.identifier);
    expect(ids(0)).toEqual(["topic:c", "topic:a", "topic:b", "topic:s1", "topic:s2"]);
    // The backend's ranking, not the identifiers, orders the queue's turn.
    expect(ids(1)).toEqual(["topic:a", "topic:b", "topic:c", "topic:s2", "topic:s1"]);
    expect(ids(-1)).toEqual(["topic:b", "topic:c", "topic:a", "topic:s2", "topic:s1"]);
    // The cap applies after the turn, so candidates beyond it still get one.
    expect(ids(2, 2)).toEqual(["topic:b", "topic:c"]);
  });

  test("collector readings by base identifier, with an age limit", () => {
    const req = collector.measurementsRequest("http://localhost:4000/v1/oracle/measurements", "tok", ["topic:b", "topic:a", "topic:b"]);
    expect(req.url).toBe("http://localhost:4000/v1/oracle/measurements?ids=topic%3Aa,topic%3Ab");
    expect(req.headers.authorization).toBe("Bearer tok");
    const parsed = collector.parseMeasurements(
      JSON.stringify({ trends: { "topic:a": { article: "A", readings: { elfa: { value: 5, observedAt: 100 }, gdelt: null, nansen: { value: "x", observedAt: 1 } } } } }),
    );
    expect(parsed.get("topic:a")).toEqual({ article: "A", readings: { elfa: { value: 5, observedAt: 100 } } });
    expect(collector.fresh({ value: 5, observedAt: 100 }, 160, 60)).toBe(5);
    expect(collector.fresh({ value: 5, observedAt: 100 }, 161, 60)).toBeNull();
    expect(() => collector.parseMeasurements("{}")).toThrow();
  });
});
