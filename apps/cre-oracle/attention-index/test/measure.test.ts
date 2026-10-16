import { describe, expect, test } from "bun:test";
import testnet from "../config.testnet.json";
import type { Config } from "../src/config";
import { configSchema } from "../src/config";
import type { HttpRequest } from "../src/http";
import { activeSources, anyAttentionSource, discover, fixedCalls, MISSING, measure, perTargetCalls, type Secrets } from "../src/measure";
import { collectorMeasurements, elfaMentions, elfaTrending, nansenNetflow, redditSearch, redditToken, wikiPageviews } from "./fixtures";

const NOW = 1_791_522_000;
const collectorCfg: Config = configSchema.parse(testnet);
/** Testnet with Bluesky and Hacker News at full weight (their phase-in over). */
const fullWeightCfg: Config = configSchema.parse({
  ...testnet,
  sources: { ...testnet.sources, bluesky: { ...testnet.sources.bluesky, phaseIn: undefined }, hn: { ...testnet.sources.hn, phaseIn: undefined } },
});
/** Paid keys: every source called from the node. */
const directCfg: Config = configSchema.parse({
  ...testnet,
  sources: {
    ...testnet.sources,
    elfa: { ...testnet.sources.elfa, mode: "direct" },
    reddit: { ...testnet.sources.reddit, enabled: true },
    wikipedia: { ...testnet.sources.wikipedia, mode: "direct" },
    nansen: { ...testnet.sources.nansen, mode: "direct" },
  },
  collector: { measurementsUrl: "" },
  discovery: { ...testnet.discovery, candidatesUrl: "", seedCandidates: [{ identifier: "topic:monad" }], elfaTrending: { ...testnet.discovery.elfaTrending, enabled: true } },
});
const all: Secrets = { elfaApiKey: "e", redditClientId: "i", redditClientSecret: "s", nansenApiKey: "n", backendToken: "tok" };
const none: Secrets = { elfaApiKey: "", redditClientId: "", redditClientSecret: "", nansenApiKey: "", backendToken: "" };
const target = (identifier: string, over: Partial<{ keywords: string[]; ticker: string | null; article: string | null }> = {}) => ({
  identifier,
  keywords: ["x"],
  ticker: null,
  article: null,
  ...over,
});

function fakeSend(overrides: Partial<Record<"elfa" | "reddit" | "nansen" | "token" | "wiki" | "collector", number>> = {}, collected = "") {
  const calls: HttpRequest[] = [];
  const send = (req: HttpRequest) => {
    calls.push(req);
    const fail = (k: keyof typeof overrides) => overrides[k] !== undefined && { status: overrides[k] as number, body: "{}" };
    if (req.url.includes("/v1/oracle/measurements")) return fail("collector") || { status: 200, body: collected };
    if (req.url.includes("keyword-mentions")) return fail("elfa") || { status: 200, body: elfaMentions(600) };
    if (req.url.includes("trending-tokens")) return { status: 200, body: elfaTrending };
    if (req.url.includes("access_token")) return fail("token") || { status: 200, body: redditToken };
    if (req.url.includes("oauth.reddit.com")) return fail("reddit") || { status: 200, body: redditSearch(NOW) };
    if (req.url.includes("smart-money/netflow")) return fail("nansen") || { status: 200, body: nansenNetflow };
    if (req.url.includes("wikimedia.org")) return fail("wiki") || { status: 200, body: wikiPageviews(40_000) };
    return { status: 404, body: "" };
  };
  return { send, calls };
}

describe("measure in direct mode", () => {
  test("combines every source over a day-long Elfa window and stays within the HTTP budget", () => {
    const { send, calls } = fakeSend();
    const out = measure(send, directCfg, all, [target("topic:world-cup", { keywords: ["world cup"], article: "2026_FIFA_World_Cup" }), target("crypto:mon", { keywords: ["$MON"], ticker: "MON" })], NOW);
    expect(out.p0).toBeGreaterThan(0);
    expect(out.n0).toBe(0);
    expect(out.p1).toBeGreaterThan(0);
    expect(out.f1).toBe(200_000);
    expect(out.n1).toBe(1);
    // token + nansen + 2 x (elfa + reddit) + one article
    expect(calls.length).toBe(7);
    expect(fixedCalls(directCfg, all, true) + 2 * perTargetCalls(directCfg, all)).toBeGreaterThanOrEqual(calls.length);
    const mentions = new URL(calls.find((c) => c.url.includes("keyword-mentions"))!.url);
    expect(Number(mentions.searchParams.get("to")) - Number(mentions.searchParams.get("from"))).toBe(86_400);
    const netflow = JSON.parse(calls.find((c) => c.url.includes("netflow"))!.body ?? "{}");
    expect(netflow.filters).not.toHaveProperty("token_address");
  });

  test("a failing source removes only its component", () => {
    const t = [target("topic:x")];
    const both = measure(fakeSend().send, directCfg, all, t, NOW);
    const elfaDown = measure(fakeSend({ elfa: 500 }).send, directCfg, all, t, NOW);
    const allDown = measure(fakeSend({ elfa: 500, token: 401 }).send, directCfg, all, t, NOW);
    expect(elfaDown.p0).toBeGreaterThan(0);
    expect(elfaDown.p0).not.toBe(both.p0);
    expect(allDown.p0).toBe(MISSING);
  });

  test("without keys only Wikipedia measures, and only with an article", () => {
    expect(measure(fakeSend().send, directCfg, none, [target("topic:x")], NOW).p0).toBe(MISSING);
    expect(measure(fakeSend().send, directCfg, none, [target("topic:x", { article: "X" })], NOW).p0).toBeGreaterThan(0);
    expect(perTargetCalls(directCfg, none)).toBe(1);
  });

  test("discovery merges seeds and trending into canonical JSON", () => {
    const json = discover(fakeSend().send, directCfg, all, 0);
    const ids = (JSON.parse(json) as { candidates: Array<{ identifier: string }> }).candidates.map((c) => c.identifier);
    expect(ids.indexOf("topic:monad")).toBeLessThan(ids.indexOf("crypto:mon"));
    expect(discover(fakeSend().send, directCfg, all, 0)).toBe(json);
  });
});

test("discovery passes the backend's rotating list through, and an older backend means none", () => {
  const cfg = { ...directCfg, discovery: { ...directCfg.discovery, candidatesUrl: "https://api.example/v1/oracle/candidates" } };
  const withList = JSON.stringify({ candidates: [{ identifier: "topic:a" }], rotating: ["topic:old.2"] });
  const found = JSON.parse(discover(() => ({ status: 200, body: withList }), cfg, none, 0)) as { candidates: Array<{ identifier: string }>; rotating: string[] };
  expect(found.rotating).toEqual(["topic:old.2"]);
  expect(found.candidates.map((c) => c.identifier)).toContain("topic:a");
  const older = JSON.stringify({ candidates: [{ identifier: "topic:a" }] });
  expect((JSON.parse(discover(() => ({ status: 200, body: older }), cfg, none, 0)) as { rotating: string[] }).rotating).toEqual([]);
});

describe("candidate order", () => {
  const queueOf = (ids: string[]) => JSON.stringify({ candidates: ids.map((identifier) => ({ identifier })) });
  /** The candidates a run samples first: its window of `take` from the rotated queue. */
  const sampled = (cfg: Config, body: string, runAt: number, take: number) =>
    (JSON.parse(discover(() => ({ status: 200, body }), cfg, none, runAt, take)) as { candidates: Array<{ identifier: string }> }).candidates.slice(0, take).map((c) => c.identifier);

  test("the backend's queue takes turns in its ranked order", () => {
    const ranked = ["topic:z", "crypto:eth", "topic:a", "topic:m", "topic:b"];
    const body = queueOf(ranked);
    // NOW is a whole minute, so its run starts the walk at the head.
    const start = NOW - ((NOW / 60) % ranked.length) * 60;
    expect(sampled(collectorCfg, body, start, 2)).toEqual(["topic:z", "crypto:eth"]);
    expect(sampled(collectorCfg, body, start + 60, 2)).toEqual(["topic:a", "topic:m"]);
    expect(sampled(collectorCfg, body, start + 120, 2)).toEqual(["topic:b", "topic:z"]);
    // Every node of a run gets the same answer.
    expect(sampled(collectorCfg, body, start + 60, 2)).toEqual(sampled(collectorCfg, body, start + 60, 2));
  });

  test("a head that never qualifies cannot starve the rest of the queue", () => {
    const ranked = Array.from({ length: 11 }, (_, i) => `topic:q${i}`);
    const body = queueOf(ranked);
    for (const take of [1, 2]) {
      const seen = new Set<string>();
      const runs = Math.ceil(ranked.length / take);
      for (let run = 0; run < runs; run++) for (const id of sampled(collectorCfg, body, NOW + run * 60, take)) seen.add(id);
      expect(seen.size).toBe(ranked.length);
    }
  });

  test("runs count in the schedule's period, so a slower schedule still visits every candidate", () => {
    const every2 = configSchema.parse({ ...testnet, schedule: "0 */2 * * * *" });
    const ranked = ["topic:a", "topic:b", "topic:c", "topic:d"];
    const body = queueOf(ranked);
    const seen = new Set<string>();
    for (let run = 0; run < 2; run++) for (const id of sampled(every2, body, NOW + run * 120, 2)) seen.add(id);
    expect([...seen].sort()).toEqual(ranked);
  });

  test("seed candidates take turns as runs go by", () => {
    const seeds = ["a", "b", "c", "d", "e", "f", "g", "h"].map((x) => ({ identifier: `topic:${x}` }));
    const cfg = configSchema.parse({ ...testnet, discovery: { ...testnet.discovery, candidatesUrl: "", maxCandidatesPerRun: 2, seedCandidates: seeds } });
    const send = () => ({ status: 404, body: "" });
    const firstTwo = (runAt: number) => (JSON.parse(discover(send, cfg, none, runAt)) as { candidates: Array<{ identifier: string }> }).candidates.slice(0, 2).map((c) => c.identifier);
    const seen = new Set<string>();
    for (let run = 0; run < 4; run++) for (const id of firstTwo(NOW + run * 60)) seen.add(id);
    expect(seen.size).toBe(8);
    expect(firstTwo(NOW)).toEqual(firstTwo(NOW));
  });
});

describe("measure in collector mode", () => {
  test("reads every trend's readings in one call and makes no per-trend calls", () => {
    const body = collectorMeasurements(NOW, {
      "topic:openai": { elfa: 2_000, gdelt: 400, wikipedia: 90_000 },
      "crypto:strk": { elfa: 300, nansen: 250_000 },
    });
    const { send, calls } = fakeSend({}, body);
    const out = measure(send, collectorCfg, none, [target("topic:openai.2"), target("crypto:strk", { ticker: "STRK" }), target("topic:unknown")], NOW);
    expect(calls).toHaveLength(1);
    expect(new URL(calls[0]!.url).searchParams.get("ids")).toBe("crypto:strk,topic:openai,topic:unknown");
    expect(calls[0]!.headers.authorization).toBeUndefined();
    expect(out.p0).toBeGreaterThan(out.p1!);
    expect([out.f1, out.n1]).toEqual([250_000, 1]);
    expect(out.p2).toBe(MISSING);
    expect(perTargetCalls(collectorCfg, none)).toBe(0);
  });

  test("sends the backend token and ignores readings past their age limit", () => {
    const fresh = collectorMeasurements(NOW, { "topic:a": { elfa: 2_000, wikipedia: 50_000 } });
    const stale = collectorMeasurements(NOW, { "topic:a": { elfa: 2_000, wikipedia: 50_000, ageSec: collectorCfg.sources.elfa.maxAgeSec + 1 } });
    const a = fakeSend({}, fresh);
    const withElfa = measure(a.send, collectorCfg, all, [target("topic:a")], NOW);
    expect(a.calls[0]!.headers.authorization).toBe("Bearer tok");
    const withoutElfa = measure(fakeSend({}, stale).send, collectorCfg, all, [target("topic:a")], NOW);
    // Elfa's reading is too old; Wikipedia's (48 h limit) still counts.
    expect(withoutElfa.p0).toBeGreaterThan(0);
    expect(withoutElfa.p0).not.toBe(withElfa.p0);
  });

  test("a collector outage leaves every trend unmeasured, never a guess", () => {
    const out = measure(fakeSend({ collector: 503 }).send, collectorCfg, none, [target("topic:a")], NOW);
    expect(out.p0).toBe(MISSING);
  });

  test("smart money counts only next to attention", () => {
    const body = collectorMeasurements(NOW, { "crypto:x": { nansen: 900_000 } });
    const out = measure(fakeSend({}, body).send, collectorCfg, none, [target("crypto:x", { ticker: "X" })], NOW);
    expect(out.p0).toBe(MISSING);
    expect([out.f0, out.n0]).toEqual([900_000, 1]);
  });

  test("sources and budgets", () => {
    const a = activeSources(collectorCfg, none);
    expect([a.elfa.collector, a.gdelt.collector, a.wikipedia.collector, a.nansen.collector, a.bluesky.collector, a.hn.collector, a.elfa.direct]).toEqual([true, true, true, true, true, true, false]);
    expect(fixedCalls(collectorCfg, none, true)).toBe(2);
    expect(anyAttentionSource(collectorCfg, none)).toBe(true);
    expect(anyAttentionSource(configSchema.parse({ ...testnet, collector: { measurementsUrl: "" } }), none)).toBe(false);
  });

  test("Bluesky weighs in over its phase-in, and its readings alone measure a trend", () => {
    const ramp = { fromSec: NOW - 3_600, durationSec: 7_200 };
    const cfgAt = (phaseIn?: { fromSec: number; durationSec: number }) =>
      configSchema.parse({ ...testnet, sources: { ...testnet.sources, bluesky: { ...testnet.sources.bluesky, phaseIn } } });
    const body = collectorMeasurements(NOW, { "topic:a": { wikipedia: 120_000, bluesky: 40 }, "topic:b": { bluesky: 400 } });
    const run = (cfg: Config, at = NOW) => measure(fakeSend({}, body).send, cfg, none, [target("topic:a"), target("topic:b")], at);
    const wikiOnly = measure(fakeSend({}, collectorMeasurements(NOW, { "topic:a": { wikipedia: 120_000 } })).send, fullWeightCfg, none, [target("topic:a")], NOW).p0!;
    const before = run(cfgAt({ fromSec: NOW + 1, durationSec: 7_200 }));
    const half = run(cfgAt(ramp));
    const full = run(fullWeightCfg);
    // Before the ramp Bluesky changes nothing; halfway it has moved the index part of the way.
    expect(before.p0).toBe(wikiOnly);
    expect(half.p0).toBeLessThan(wikiOnly);
    expect(half.p0).toBeGreaterThan(full.p0!);
    // A trend only Bluesky measured is measured once Bluesky counts at all.
    expect(full.p1).toBeGreaterThan(0);
    expect(before.p1).toBe(MISSING);
  });

  test("Elfa can be phased in too", () => {
    const body = collectorMeasurements(NOW, { "topic:a": { elfa: 20, wikipedia: 120_000 } });
    const cfgWith = (fromSec: number) => configSchema.parse({ ...testnet, sources: { ...testnet.sources, elfa: { ...testnet.sources.elfa, phaseIn: { fromSec, durationSec: 3_600 } } } });
    const at = (cfg: Config) => measure(fakeSend({}, body).send, cfg, none, [target("topic:a")], NOW).p0!;
    const wikiOnly = measure(fakeSend({}, collectorMeasurements(NOW, { "topic:a": { wikipedia: 120_000 } })).send, collectorCfg, none, [target("topic:a")], NOW).p0!;
    expect(at(cfgWith(NOW + 60))).toBe(wikiOnly);
    expect(at(cfgWith(NOW - 3_600))).toBe(at(collectorCfg));
  });

  test("Hacker News lifts an index it would raise and never lowers one", () => {
    const at = (t: Record<string, number>) => measure(fakeSend({}, collectorMeasurements(NOW, { "topic:a": t })).send, fullWeightCfg, none, [target("topic:a")], NOW).p0!;
    const base = at({ wikipedia: 20_000, bluesky: 30 });
    expect(at({ wikipedia: 20_000, bluesky: 30, hn: 0 })).toBe(base);
    expect(at({ wikipedia: 20_000, bluesky: 30, hn: 2 })).toBe(base);
    expect(at({ wikipedia: 20_000, bluesky: 30, hn: 400 })).toBeGreaterThan(base);
    // On its own it measures nothing.
    expect(at({ hn: 400 })).toBe(MISSING);
  });

  test("only localhost may use plain http", () => {
    expect(() => configSchema.parse({ ...testnet, collector: { measurementsUrl: "http://evil.example/m" } })).toThrow();
    expect(configSchema.parse({ ...testnet, collector: { measurementsUrl: "http://127.0.0.1:4000/v1/oracle/measurements" } }).collector.measurementsUrl).toContain("127.0.0.1");
  });
});
