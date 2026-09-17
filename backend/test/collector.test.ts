import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { KeyRing } from "../src/budget";
import type { ChainReader, ChainTrend } from "../src/chain";
import { Collector, type CollectorConfig } from "../src/collector";
import { migrate, type Sql } from "../src/db";
import { Bluesky } from "../src/sources/bluesky";
import { Elfa } from "../src/sources/elfa";
import { Gdelt } from "../src/sources/gdelt";
import { HackerNews } from "../src/sources/hackernews";
import { Nansen } from "../src/sources/nansen";
import { Wikipedia } from "../src/sources/wikipedia";
import { type NewCandidate, Store } from "../src/store";
import { fakeFetch, json, quietLog, testDb } from "./helpers";

let sql: Sql;
let store: Store;
beforeAll(async () => {
  sql = await testDb();
  store = new Store(sql);
});
afterAll(async () => {
  await sql.end();
});
beforeEach(async () => {
  await sql`TRUNCATE candidates, trend_meta, measurements, api_usage RESTART IDENTITY CASCADE`;
});

const NOW = Date.parse("2026-10-10T12:00:00Z");
const trend = (identifier: string, over: Partial<ChainTrend> = {}): ChainTrend => ({
  id: `0x${identifier.length.toString(16).padStart(64, "0")}`,
  identifier,
  assetClass: 6,
  status: "Active",
  createdAt: NOW / 1000,
  updatedAt: NOW / 1000,
  statusSince: NOW / 1000,
  index: 40,
  peakIndex: 40,
  surfacer: "0x0000000000000000000000000000000000000000",
  ...over,
});
const STALE_RETIRE_SEC = 7200;
const fakeChain = (trends: ChainTrend[]) =>
  ({ trends: async () => trends, lastRunId: async () => 0n, staleRetireWindow: async () => STALE_RETIRE_SEC }) as unknown as ChainReader;
const candidate = (identifier: string, over: Partial<NewCandidate> = {}): NewCandidate => ({
  identifier,
  displayName: identifier,
  assetClass: 6,
  keywords: ["Starlink"],
  article: "Starlink",
  ticker: null,
  summary: null,
  source: "elfa_narrative",
  sourceRef: {},
  surfacer: "0x00000000000000000000000000000000000000aa",
  status: "approved",
  confidence: 0.9,
  ai: {},
  decidedBy: "radar",
  ...over,
});
const cfg: CollectorConfig = {
  elfaRefreshSec: 7200,
  gdeltRefreshSec: 1800,
  nansenRefreshSec: 14_400,
  wikipediaRefreshSec: 21_600,
  elfaRadarCreditsPerDay: 0,
  maxGdeltPerTick: 2,
  maxWikipediaPerTick: 5,
};

function sources() {
  const f = fakeFetch([
    [/keyword-mentions/, () => json({ success: true, metadata: { total: 250 } })],
    [/pageviews\/per-article/, () => json({ items: [{ views: 5000 }] })],
    [/gdeltproject/, () => json({ timeline: [{ data: [{ value: 12 }] }] })],
    [/netflow/, () => json({ data: [{ token_symbol: "STRK", net_flow_24h_usd: 250_000 }] })],
  ]);
  const elfaRing = new KeyRing(sql, "elfa", ["e1"], { daily: 100 }, () => new Date(NOW));
  const nansenRing = new KeyRing(sql, "nansen", ["n1"], { daily: 10 }, () => new Date(NOW));
  return {
    f,
    elfaRing,
    deps: {
      elfa: { client: new Elfa(elfaRing, "https://api.elfa.ai", f.impl), ring: elfaRing },
      gdelt: new Gdelt(f.impl, async () => {}),
      nansen: new Nansen(nansenRing, "https://api.nansen.ai", ["all"], f.impl),
      wikipedia: new Wikipedia("Bot/1.0 (https://example.org)", "en.wikipedia", f.impl, { sleep: async () => {} }),
    },
  };
}

describe("Collector", () => {
  test("tracks live trends by base identifier and approved candidates, with their metadata", async () => {
    await store.insertCandidate(candidate("topic:starlink-mobile"));
    await store.insertCandidate(candidate("topic:rejected", { status: "rejected" }));
    await store.upsertTrendMeta({ identifier: "topic:openai.2", trendId: "0x01", displayName: "OpenAI", summary: null, keywords: ["OpenAI"], article: "OpenAI", ticker: null });
    const chain = fakeChain([trend("topic:openai.2"), trend("crypto:strk", { assetClass: 0 }), trend("topic:old", { status: "Retired" })]);
    const tracked = await new Collector(store, chain, sources().deps, cfg, quietLog).tracked();
    expect(tracked.map((t) => [t.identifier, t.live, t.keywords, t.ticker])).toEqual([
      ["topic:openai", true, ["OpenAI"], null],
      ["crypto:strk", true, ["$STRK"], "STRK"],
      ["topic:starlink-mobile", false, ["Starlink"], null],
    ]);
  });

  test("measures every source once, then waits for each refresh interval", async () => {
    await store.insertCandidate(candidate("topic:starlink-mobile"));
    const chain = fakeChain([trend("crypto:strk", { assetClass: 0 })]);
    const s = sources();
    const c = new Collector(store, chain, s.deps, cfg, quietLog);
    const first = await c.tick(NOW);
    expect(first.measured).toEqual({ elfa: 2, wikipedia: 1, gdelt: 1, nansen: 1 });
    const latest = await store.latest(["crypto:strk", "topic:starlink-mobile"]);
    expect(latest.get("crypto:strk")).toMatchObject({ elfa: { value: 250, windowSec: 86_400 }, nansen: { value: 250_000 } });
    expect(latest.get("topic:starlink-mobile")).toMatchObject({ elfa: { value: 250 }, wikipedia: { value: 5000 }, gdelt: { value: 12 } });
    const calls = s.f.calls.length;
    expect((await c.tick(NOW + 60_000)).measured).toEqual({});
    expect(s.f.calls.length).toBe(calls);
    // Thirty minutes later only GDELT is due.
    expect((await c.tick(NOW + 1_801_000)).measured).toEqual({ gdelt: 1 });
  });

  test("an empty GDELT answer is no reading, and waits for the refresh interval before a retry", async () => {
    await store.insertCandidate(candidate("topic:quiet-news"));
    const f = fakeFetch([
      [/gdeltproject/, () => json({})],
      [/keyword-mentions/, () => json({ success: true, metadata: { total: 1 } })],
      [/pageviews\/per-article/, () => json({ items: [{ views: 1 }] })],
    ]);
    const s = sources();
    const c = new Collector(store, fakeChain([]), { ...s.deps, gdelt: new Gdelt(f.impl, async () => {}) }, cfg, quietLog);
    const report = await c.tick(NOW);
    expect(report.measured.gdelt).toBeUndefined();
    expect(report.notes).toContain("gdelt: no timeline for topic:quiet-news");
    expect((await store.latest(["topic:quiet-news"])).get("topic:quiet-news")?.gdelt ?? null).toBeNull();
    const asked = f.calls.filter((u) => String(u).includes("gdeltproject")).length;
    await c.tick(NOW + 60_000);
    expect(f.calls.filter((u) => String(u).includes("gdeltproject")).length).toBe(asked);
  });

  test("GDELT measures live trends first, and candidates at their own slower refresh", async () => {
    await store.insertCandidate(candidate("topic:waiting"));
    await store.upsertTrendMeta({ identifier: "topic:openai", trendId: "0x01", displayName: "OpenAI", summary: null, keywords: ["OpenAI"], article: null, ticker: null });
    const f = fakeFetch([[/gdeltproject/, () => json({ timeline: [{ data: [{ value: 5 }] }] })]]);
    const s = sources();
    const c = new Collector(
      store,
      fakeChain([trend("topic:openai")]),
      { ...s.deps, elfa: null, nansen: null, gdelt: new Gdelt(f.impl, async () => {}) },
      { ...cfg, maxGdeltPerTick: 1, gdeltCandidateRefreshSec: 3600 },
      quietLog,
    );
    const asked = () => f.calls.map((x) => new URL(x.url).searchParams.get("query"));
    await c.tick(NOW);
    expect(asked()).toEqual(["OpenAI"]);
    await c.tick(NOW + 60_000);
    expect(asked()).toEqual(["OpenAI", "Starlink"]);
    // Half an hour on, only the live trend is due again; the candidate waits its hour.
    await c.tick(NOW + 1_861_000);
    await c.tick(NOW + 1_921_000);
    expect(asked()).toEqual(["OpenAI", "Starlink", "OpenAI"]);
    // An hour on both are due, and the live trend still goes first.
    await c.tick(NOW + 3_661_000);
    await c.tick(NOW + 3_721_000);
    expect(asked()).toEqual(["OpenAI", "Starlink", "OpenAI", "OpenAI", "Starlink"]);
  });

  test("stretches Elfa's interval so a day's credits cover every trend, and holds the radar's share", async () => {
    for (let i = 0; i < 30; i++) await store.insertCandidate(candidate(`topic:t${i}`, { article: null }));
    const s = sources();
    const c = new Collector(store, fakeChain([]), s.deps, { ...cfg, elfaRadarCreditsPerDay: 40 }, quietLog);
    const report = await c.tick(NOW);
    // 100 credits a day, 40 held for the radar: 30 trends every 30 * 86400 / 60 seconds.
    expect(report.elfaIntervalSec).toBe(43_200);
    // Every trend is due, and 30 credits leave more than the radar's 20 for the rest of the day.
    expect(report.measured.elfa).toBe(30);
    expect(await s.elfaRing.leftToday()).toBe(70);
  });

  test("stops spending Elfa credits at the radar's reserve", async () => {
    for (let i = 0; i < 10; i++) await store.insertCandidate(candidate(`topic:r${i}`, { article: null }));
    const s = sources();
    const ring = new KeyRing(sql, "elfa-small", ["e9"], { daily: 25 }, () => new Date(NOW));
    const deps = { ...s.deps, elfa: { client: new Elfa(ring, "https://api.elfa.ai", s.f.impl), ring } };
    const report = await new Collector(store, fakeChain([]), deps, { ...cfg, elfaRadarCreditsPerDay: 40 }, quietLog).tick(NOW);
    // Half the day left: 20 credits stay for the radar, so 5 of 25 are spent.
    expect(report.measured.elfa).toBe(5);
    expect(report.notes).toContain("elfa: holding the rest of today's credits for the radar");
  });

  test("measures Bluesky and Hacker News mentions over a day, paced, and skips keywords they cannot search", async () => {
    await store.insertCandidate(candidate("topic:starlink-mobile", { keywords: ["Starlink", "$SPCX"] }));
    await store.insertCandidate(candidate("crypto:mon", { assetClass: 0, keywords: ["$MON"], article: null }));
    const f = fakeFetch([
      [/searchPosts/, () => json({ posts: [], hitsTotal: 321 })],
      [/search_by_date/, () => json({ hits: [], nbHits: 11 })],
    ]);
    const quick = { fetchImpl: f.impl, sleep: async () => {} };
    const s = sources();
    const deps = { ...s.deps, elfa: null, bluesky: new Bluesky("https://api.bsky.app", quick), hn: new HackerNews("https://hn.algolia.com/api/v1", quick) };
    const c = new Collector(store, fakeChain([]), deps, { ...cfg, blueskyRefreshSec: 1800, hnRefreshSec: 3600 }, quietLog);
    const report = await c.tick(NOW);
    expect(report.measured).toMatchObject({ bluesky: 1, hn: 1 });
    expect((await store.latest(["topic:starlink-mobile"])).get("topic:starlink-mobile")).toMatchObject({ bluesky: { value: 321, windowSec: 86_400 }, hn: { value: 11, windowSec: 86_400 } });
    // A cashtag alone is no search on either.
    expect((await store.latest(["crypto:mon"])).get("crypto:mon")?.bluesky).toBeUndefined();
    const q = new URL(f.calls.find((x) => x.url.includes("searchPosts"))!.url).searchParams;
    expect([q.get("q"), q.get("since"), q.get("until")]).toEqual(["Starlink", "2026-10-09T12:00:00Z", "2026-10-10T12:00:00Z"]);
    // Bluesky refreshes after 30 minutes, Hacker News after an hour.
    const calls = f.calls.length;
    expect((await c.tick(NOW + 60_000)).measured).toEqual({});
    expect(f.calls.length).toBe(calls);
    expect((await c.tick(NOW + 1_801_000)).measured).toMatchObject({ bluesky: 1 });
    expect((await c.tick(NOW + 1_802_000)).measured.hn).toBeUndefined();
  });

  test("a budget too small for every trend measures live trends only, inside the workflow's age limit", async () => {
    for (let i = 0; i < 20; i++) await store.insertCandidate(candidate(`topic:q${i}`, { article: null }));
    const chain = fakeChain([trend("topic:live-a"), trend("topic:live-b")]);
    await store.upsertTrendMeta({ identifier: "topic:live-a", trendId: "0x0a", displayName: "A", summary: null, keywords: ["A"], article: null, ticker: null });
    await store.upsertTrendMeta({ identifier: "topic:live-b", trendId: "0x0b", displayName: "B", summary: null, keywords: ["B"], article: null, ticker: null });
    const s = sources();
    // One free key: 32 credits a day, 2 for the radar.
    const ring = new KeyRing(sql, "elfa-one", ["solo"], { daily: 32 }, () => new Date(NOW));
    const deps = { ...s.deps, elfa: { client: new Elfa(ring, "https://api.elfa.ai", s.f.impl), ring } };
    const report = await new Collector(store, chain, deps, { ...cfg, elfaRefreshSec: 3600, elfaRadarCreditsPerDay: () => 2 }, quietLog).tick(NOW);
    expect(report.notes).toContain("elfa: budget covers live trends only (2 of 22)");
    expect(report.measured.elfa).toBe(2);
    // Two live trends on 30 credits a day: each every 2 hours at most, well inside 12 hours.
    expect(report.elfaIntervalSec).toBe(5_760);
    expect((await store.latest(["topic:live-a", "topic:q0"])).get("topic:q0")?.elfa).toBeUndefined();
  });

  test("skips Elfa without a request when every key sits out", async () => {
    await store.insertCandidate(candidate("topic:quiet", { article: null }));
    const s = sources();
    s.elfaRing.reject(s.elfaRing.keyIds[0]!);
    const report = await new Collector(store, fakeChain([]), s.deps, cfg, quietLog).tick(NOW);
    expect(report.notes).toContain("elfa: every key is sitting out (rejected, out of quota or proxy down)");
    expect(s.f.calls.some((x) => x.url.includes("elfa"))).toBe(false);
  });

  test("marks a candidate live when the workflow lists it and carries its metadata over", async () => {
    const { candidate: c } = await store.insertCandidate(candidate("topic:openai", { displayName: "OpenAI", keywords: ["OpenAI", "ChatGPT"] }));
    const chain = fakeChain([trend("topic:openai", { status: "Retired", createdAt: 1 }), trend("topic:openai.2", { createdAt: Math.floor(c.createdAt.getTime() / 1000) })]);
    const listed = await new Collector(store, chain, sources().deps, cfg, quietLog).syncListings();
    expect(listed).toEqual(["topic:openai.2"]);
    expect((await store.candidate(c.id))?.status).toBe("live");
    expect((await store.trendMeta()).get("topic:openai.2")).toMatchObject({ displayName: "OpenAI", keywords: ["OpenAI", "ChatGPT"] });
  });
});

describe("retired trends", () => {
  const T = NOW / 1000;
  /** A trend retired at `retiredAt` after its last update at `updatedAt`. */
  const retired = (identifier: string, updatedAt: number, retiredAt: number, createdAt = T - 86_400) =>
    trend(identifier, { status: "Retired", createdAt, updatedAt, statusSince: retiredAt });
  const live = async (identifier: string, over: Partial<NewCandidate> = {}) => {
    const { candidate: c } = await store.insertCandidate(candidate(identifier, over));
    await store.markLive(c, identifier, `0x${c.id.toString(16).padStart(64, "0")}`);
    return c;
  };

  test("a trend the oracle let go stale puts its topic back in the queue, measured and listed again as .2", async () => {
    const eth = await live("crypto:eth", { assetClass: 0, ticker: "ETH", keywords: ["$ETH"], article: null });
    // The oracle stopped at T - 9 h; the keeper retired the trend 2 h 1 s later.
    const outage = retired("crypto:eth", T - 32_400, T - 32_400 + STALE_RETIRE_SEC + 1);
    const c = new Collector(store, fakeChain([{ ...outage, assetClass: 0 }]), sources().deps, cfg, quietLog);
    const report = await c.tick(NOW);
    expect(report.requeued).toEqual(["crypto:eth"]);
    expect((await store.candidate(eth.id))?.status).toBe("approved");
    // Back in the queue, so the collector keeps measuring it.
    expect((await c.tracked()).map((t) => [t.identifier, t.live])).toEqual([["crypto:eth", false]]);
    expect(report.measured.elfa).toBe(1);
    expect(report.measured.nansen).toBe(1);
    // A second pass changes nothing.
    expect(await c.syncRetirements()).toEqual({ requeued: [], retired: [] });

    // The workflow lists it again as crypto:eth.2; the candidate goes live with its metadata.
    const relisted = trend("crypto:eth.2", { assetClass: 0, createdAt: Math.floor(Date.now() / 1000) });
    const after = new Collector(store, fakeChain([{ ...outage, assetClass: 0 }, relisted]), sources().deps, cfg, quietLog);
    expect((await after.tick(NOW + 120_000)).listed).toEqual(["crypto:eth.2"]);
    expect((await store.candidate(eth.id))?.status).toBe("live");
    expect((await store.trendMeta()).get("crypto:eth.2")).toMatchObject({ ticker: "ETH", keywords: ["$ETH"] });
    expect(await after.syncRetirements()).toEqual({ requeued: [], retired: [] });
  });

  test("a trend that cooled and retired takes its topic out of the queue for good", async () => {
    const faded = await live("topic:faded");
    // Updated a minute before it retired from Cooling.
    const chain = fakeChain([retired("topic:faded", T - 600, T - 540)]);
    expect(await new Collector(store, chain, sources().deps, cfg, quietLog).syncRetirements()).toEqual({ requeued: [], retired: ["topic:faded"] });
    expect((await store.candidate(faded.id))?.status).toBe("retired");
    expect(await new Collector(store, chain, sources().deps, cfg, quietLog).tracked()).toEqual([]);
    // An admin can still approve it again.
    expect((await store.decide(faded.id, "approved", "0x00000000000000000000000000000000000000a1"))?.status).toBe("approved");
  });

  test("only the newest listing decides, and a listing still on chain keeps the topic live", async () => {
    const a = await live("topic:again");
    const b = await live("topic:busy");
    const chain = fakeChain([
      // An old listing faded, then the topic came back as .2 and went stale in an outage.
      retired("topic:again", T - 90_000, T - 89_000, T - 100_000),
      retired("topic:again.2", T - 20_000, T - 20_000 + STALE_RETIRE_SEC, T - 50_000),
      retired("topic:busy", T - 90_000, T - 80_000, T - 100_000),
      trend("topic:busy.2", { status: "Cooling", createdAt: T - 50_000 }),
    ]);
    expect(await new Collector(store, chain, sources().deps, cfg, quietLog).syncRetirements()).toEqual({ requeued: ["topic:again"], retired: [] });
    expect((await store.candidate(a.id))?.status).toBe("approved");
    expect((await store.candidate(b.id))?.status).toBe("live");
  });

  test("the new source names survive the migrations running again, and unknown ones are refused", async () => {
    await migrate(sql);
    await migrate(sql);
    for (const source of ["bluesky_trend", "coingecko_trending", "geckoterminal_trending"] as const) {
      expect((await store.insertCandidate(candidate(`topic:${source}`, { source }))).created).toBe(true);
    }
    await store.addMeasurement("topic:x", "bluesky", "posts", 5, 86_400, new Date(NOW));
    await store.addMeasurement("topic:x", "hn", "mentions", 2, 86_400, new Date(NOW));
    await expect(sql`INSERT INTO candidates (identifier, display_name, asset_class, source) VALUES ('topic:bad', 'b', 6, 'myspace')`.then(() => "inserted")).rejects.toThrow();
    await expect(sql`INSERT INTO measurements (identifier, source, metric, value, window_sec, observed_at) VALUES ('topic:x', 'myspace', 'm', 1, 1, now())`.then(() => "inserted")).rejects.toThrow();
  });

  test("the retired status survives the migrations running again", async () => {
    await migrate(sql);
    await migrate(sql);
    const c = await live("topic:twice");
    expect(await store.unlist(c.id, "retired")).toBe(true);
    expect(await store.unlist(c.id, "approved")).toBe(false);
    expect((await store.candidate(c.id))?.status).toBe("retired");
    await expect(sql`UPDATE candidates SET status = 'gone' WHERE id = ${c.id}`.then(() => "updated")).rejects.toThrow();
  });
});
