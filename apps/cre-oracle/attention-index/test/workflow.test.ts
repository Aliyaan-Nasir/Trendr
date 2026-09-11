import { describe, expect } from "bun:test";
import { getNetwork, TxStatus } from "@chainlink/cre-sdk";
import {
  addContractMock,
  EvmMock,
  HttpActionsMock,
  newTestRuntime,
  REPORT_METADATA_HEADER_LENGTH,
  test,
} from "@chainlink/cre-sdk/test";
import { bytesToHex, decodeAbiParameters, type Hex, keccak256, toBytes } from "viem";
import { LENS_ABI } from "../src/chain";
import { type Config, configSchema } from "../src/config";
import { normalizeCount, seasonalFactor, toIndexUnits } from "../src/index-method";
import { REPORT_ABI } from "../src/report";
import { onCron } from "../src/workflow";
import testnet from "../config.testnet.json";
import { collectorMeasurements, elfaMentions, elfaTrending, nansenNetflow, redditSearch, redditToken, wikiPageviews } from "./fixtures";

const NOW = 1_791_522_000;
/** Paid keys: every node calls each source itself. */
const cfg: Config = configSchema.parse({
  ...testnet,
  sources: {
    ...testnet.sources,
    elfa: { ...testnet.sources.elfa, mode: "direct" },
    reddit: { ...testnet.sources.reddit, enabled: true },
    wikipedia: { ...testnet.sources.wikipedia, mode: "direct" },
    nansen: { ...testnet.sources.nansen, mode: "direct" },
  },
  collector: { measurementsUrl: "" },
  discovery: {
    ...testnet.discovery,
    candidatesUrl: "",
    seedCandidates: [{ identifier: "topic:world-cup", keywords: ["World Cup"] }],
    elfaTrending: { ...testnet.discovery.elfaTrending, enabled: true },
  },
});
/** Free plans: the backend collector serves every reading. */
const collectorCfg: Config = configSchema.parse(testnet);
const noWiki: Config = { ...cfg, sources: { ...cfg.sources, wikipedia: { ...cfg.sources.wikipedia, enabled: false } } };
const id = (s: string) => keccak256(toBytes(s));
const selector = getNetwork({ chainFamily: "evm", chainSelectorName: "monad-testnet" })!.chainSelector.selector;

interface Row {
  identifier: string;
  index: bigint;
  updatedAt: bigint;
  pendingExpiry?: bigint;
}

function secrets(values: Record<string, string>) {
  return new Map([["main", new Map(Object.entries(values))]]);
}

function setup(rows: Row[], lastRunId = 0n, liveStatuses: Record<string, number> = {}, backend: Record<string, string> = {}) {
  const evm = EvmMock.testInstance(selector);
  const lens = addContractMock(evm, { address: cfg.lens as Hex, abi: LENS_ABI });
  lens.oracleSnapshot = () => [
    lastRunId,
    BigInt(rows.length),
    BigInt(rows.length),
    rows.map((r) => ({
      id: id(r.identifier),
      index: r.index,
      updatedAt: r.updatedAt,
      status: 1,
      assetClass: r.identifier.startsWith("crypto:") ? 0 : 6,
      pendingExpiry: r.pendingExpiry ?? 0n,
      nextExpiry: 0n,
    })),
  ];
  const byId = new Map(rows.map((r) => [id(r.identifier), r.identifier]));
  lens.identifiers = (ids: readonly Hex[]) => ids.map((x) => byId.get(x) ?? "");
  const statusById = new Map(Object.entries(liveStatuses).map(([k, v]) => [id(k), v]));
  lens.statuses = (ids: readonly Hex[]) => ids.map((x) => statusById.get(x) ?? (byId.has(x) ? 1 : 0));

  const writes: Array<{ payload: Hex; gasLimit: string }> = [];
  const registry = addContractMock(evm, { address: cfg.registry as Hex, abi: [] });
  registry.writeReport = ({ report, gasConfig }) => {
    writes.push({ payload: bytesToHex(report.rawReport.slice(REPORT_METADATA_HEADER_LENGTH)), gasLimit: String(gasConfig.gasLimit) });
    return { txStatus: TxStatus.SUCCESS, txHash: new Uint8Array(32).fill(0xab) };
  };

  const http = HttpActionsMock.testInstance();
  const urls: string[] = [];
  http.sendRequest = (req) => {
    urls.push(req.url);
    const fromBackend = Object.entries(backend).find(([path]) => req.url.includes(path));
    if (fromBackend) return { statusCode: 200, body: new TextEncoder().encode(fromBackend[1]) };
    const body = req.url.includes("keyword-mentions")
      ? elfaMentions(req.url.includes("World%20Cup") ? 2_500 : 300)
      : req.url.includes("trending-tokens")
        ? elfaTrending
        : req.url.includes("access_token")
          ? redditToken
          : req.url.includes("oauth.reddit.com")
            ? redditSearch(NOW)
            : req.url.includes("smart-money/netflow")
              ? nansenNetflow
              : req.url.includes("wikimedia.org")
                ? wikiPageviews(20_000)
                : "{}";
    return { statusCode: 200, body: new TextEncoder().encode(body) };
  };
  return { writes, urls };
}

const payload = { scheduledExecutionTime: { seconds: BigInt(NOW), nanos: 0 } } as never;

describe("onCron", () => {
  test("measures, creates, updates and settles in one report", () => {
    const { writes, urls } = setup([
      { identifier: "topic:alpha", index: 10_000_000n, updatedAt: BigInt(NOW - 600) },
      { identifier: "topic:beta", index: 40_000_000n, updatedAt: BigInt(NOW - 30), pendingExpiry: BigInt(NOW - 20) },
    ]);
    const runtime = newTestRuntime(secrets({ ELFA_API_KEY: "e", REDDIT_CLIENT_ID: "i", REDDIT_CLIENT_SECRET: "s", NANSEN_API_KEY: "n", BACKEND_TOKEN: "" }), {}, cfg);
    const result = onCron(runtime as never, payload);
    expect(result).toContain("tx 0xabab");
    expect(urls.length).toBeLessThanOrEqual(15);
    expect(writes.length).toBe(1);

    const [r] = decodeAbiParameters(REPORT_ABI, writes[0]!.payload);
    expect(r.runId).toBe(BigInt(NOW));
    expect(r.observedAt).toBe(BigInt(NOW));
    // The pending series is measured and settled; the stale trend gets its heartbeat.
    expect(r.updates.map((u) => u.id)).toEqual([id("topic:beta"), id("topic:alpha")]);
    expect(r.settlements).toEqual([{ id: id("topic:beta"), expiry: BigInt(NOW - 20) }]);
    // World Cup is busy, so the seed becomes a trend; MON has smart-money inflow, so it lists too.
    const created = r.newTrends.map((t) => [t.identifier, t.smartMoneyConfirmed]);
    expect(created).toContainEqual(["topic:world-cup", false]);
    expect(created).toContainEqual(["crypto:mon", true]);
    expect(Number(writes[0]!.gasLimit)).toBeLessThanOrEqual(cfg.gas.max);
  });

  test("a run already reported is skipped", () => {
    const { writes } = setup([], BigInt(NOW));
    const runtime = newTestRuntime(secrets({ ELFA_API_KEY: "e" }), {}, cfg);
    expect(onCron(runtime as never, payload)).toContain("already reported");
    expect(writes.length).toBe(0);
  });

  test("without any source nothing is measured or written", () => {
    const { writes } = setup([{ identifier: "topic:alpha", index: 10_000_000n, updatedAt: BigInt(NOW - 600) }]);
    const runtime = newTestRuntime(secrets({}), {}, noWiki);
    expect(onCron(runtime as never, payload)).toContain("no attention source");
    expect(writes.length).toBe(0);
  });

  test("keyless, Wikipedia alone measures and reports", () => {
    const { writes, urls } = setup([{ identifier: "topic:alpha", index: 10_000_000n, updatedAt: BigInt(NOW - 600) }]);
    const runtime = newTestRuntime(secrets({}), {}, cfg);
    expect(onCron(runtime as never, payload)).toContain("tx 0x");
    expect(urls.every((u) => u.startsWith("https://wikimedia.org/"))).toBe(true);
    const [r] = decodeAbiParameters(REPORT_ABI, writes[0]!.payload);
    expect(r.updates.map((u) => u.id)).toEqual([id("topic:alpha")]);
    expect(r.newTrends.map((t) => t.identifier)).toEqual(["topic:world-cup"]);
  });

  test("fresh, unmoved trends produce no transaction", () => {
    // Elfa alone: the index is exactly the Elfa component.
    const e = cfg.sources.elfa;
    const hour = new Date(NOW * 1000).getUTCHours();
    const unchanged = toIndexUnits(100 * normalizeCount(300, e.clip, e.saturation, seasonalFactor(e.seasonality, hour)));
    const { writes } = setup(
      [{ identifier: "topic:alpha", index: unchanged, updatedAt: BigInt(NOW - 30) }],
      0n,
      { "topic:world-cup": 1, "topic:monad": 1, "topic:openai": 1, "crypto:mon": 1, "crypto:btc": 1 },
    );
    const runtime = newTestRuntime(secrets({ ELFA_API_KEY: "e" }), {}, noWiki);
    const result = onCron(runtime as never, payload);
    expect(writes.length).toBe(0);
    expect(result).toContain("nothing to report");
  });

  test("collector mode: two calls measure every trend and list a measured candidate", () => {
    const rows: Row[] = [
      { identifier: "topic:openai.2", index: 10_000_000n, updatedAt: BigInt(NOW - 600) },
      { identifier: "crypto:strk", index: 30_000_000n, updatedAt: BigInt(NOW - 600), pendingExpiry: BigInt(NOW - 5) },
    ];
    const candidates = JSON.stringify({
      candidates: [
        { identifier: "topic:starlink-mobile", keywords: ["Starlink"], surfacer: "0x00000000000000000000000000000000000000aa" },
        { identifier: "crypto:quiet", keywords: ["$QUIET"] },
      ],
    });
    const measurements = collectorMeasurements(NOW, {
      "topic:openai": { elfa: 3_000, gdelt: 800, wikipedia: 120_000 },
      "crypto:strk": { elfa: 400, nansen: 50_000 },
      "topic:starlink-mobile": { elfa: 1_500, gdelt: 300 },
      // Smart money sold: no confirmation, so no listing.
      "crypto:quiet": { elfa: 900, nansen: -10_000 },
    });
    const { writes, urls } = setup(rows, 0n, {}, { "/v1/oracle/candidates": candidates, "/v1/oracle/measurements": measurements });
    const runtime = newTestRuntime(secrets({ BACKEND_TOKEN: "tok" }), {}, collectorCfg);
    expect(onCron(runtime as never, payload)).toContain("tx 0xabab");
    expect(urls).toHaveLength(2);
    expect(urls[1]).toContain("ids=crypto%3Aquiet,crypto%3Astrk,topic%3Aopenai,topic%3Astarlink-mobile");
    const [r] = decodeAbiParameters(REPORT_ABI, writes[0]!.payload);
    expect(r.updates.map((u) => u.id)).toEqual([id("crypto:strk"), id("topic:openai.2")]);
    expect(r.settlements).toEqual([{ id: id("crypto:strk"), expiry: BigInt(NOW - 5) }]);
    expect(r.newTrends.map((t) => [t.identifier, t.surfacer.toLowerCase()])).toEqual([["topic:starlink-mobile", "0x00000000000000000000000000000000000000aa"]]);
  });

  test("collector mode without the backend measures nothing and writes nothing", () => {
    const { writes } = setup([{ identifier: "topic:alpha", index: 10_000_000n, updatedAt: BigInt(NOW - 600) }]);
    const runtime = newTestRuntime(secrets({}), {}, collectorCfg);
    expect(onCron(runtime as never, payload)).toContain("nothing to report");
    expect(writes.length).toBe(0);
  });

  test("candidates at the head that never qualify cannot starve the queue", () => {
    // The backend ranks two candidates with no fresh reading first; the next run moves past them.
    const queue = ["equity:stuck-a", "equity:stuck-b", "topic:fresh", "topic:later"];
    const candidates = JSON.stringify({ candidates: queue.map((identifier) => ({ identifier })) });
    const measurements = collectorMeasurements(NOW, {
      "equity:stuck-a": { elfa: 70, ageSec: 50_000 },
      "equity:stuck-b": { elfa: 64, ageSec: 50_000 },
      "topic:fresh": { wikipedia: 90_000 },
    });
    const backend = { "/v1/oracle/candidates": candidates, "/v1/oracle/measurements": measurements };
    const runtime = () => newTestRuntime(secrets({ BACKEND_TOKEN: "tok" }), {}, collectorCfg);
    // NOW is the run that starts a turn at the head of a four-candidate queue.
    const turn = (n: number) => ({ scheduledExecutionTime: { seconds: BigInt(NOW + n * 60), nanos: 0 } }) as never;
    const first = setup([], 0n, {}, backend);
    expect(onCron(runtime() as never, turn(0))).toContain("tried equity:stuck-a, equity:stuck-b");
    expect(first.writes).toHaveLength(0);
    const second = setup([], 0n, {}, backend);
    expect(onCron(runtime() as never, turn(1))).toContain("1 new");
    const [r] = decodeAbiParameters(REPORT_ABI, second.writes[0]!.payload);
    expect(r.newTrends.map((t) => t.identifier)).toEqual(["topic:fresh"]);
  });

  test("a topic whose trend retired is listed again under its next identifier", () => {
    const candidates = JSON.stringify({ candidates: [{ identifier: "topic:eth-etf" }] });
    const measurements = collectorMeasurements(NOW, { "topic:eth-etf": { elfa: 2_000, wikipedia: 50_000 } });
    const { writes } = setup([], 0n, { "topic:eth-etf": 3 }, { "/v1/oracle/candidates": candidates, "/v1/oracle/measurements": measurements });
    const runtime = newTestRuntime(secrets({ BACKEND_TOKEN: "tok" }), {}, collectorCfg);
    expect(onCron(runtime as never, payload)).toContain("tried topic:eth-etf.2");
    const [r] = decodeAbiParameters(REPORT_ABI, writes[0]!.payload);
    expect(r.newTrends.map((t) => t.identifier)).toEqual(["topic:eth-etf.2"]);
  });

  test("no new trends while the live cap is reached", () => {
    const capped = configSchema.parse({ ...testnet, discovery: { ...testnet.discovery, maxLiveTrends: 1 } });
    const candidates = JSON.stringify({ candidates: [{ identifier: "topic:new" }] });
    const measurements = collectorMeasurements(NOW, { "topic:alpha": { elfa: 3_000 }, "topic:new": { elfa: 3_000 } });
    const { writes } = setup([{ identifier: "topic:alpha", index: 10_000_000n, updatedAt: BigInt(NOW - 600) }], 0n, {}, { "/v1/oracle/candidates": candidates, "/v1/oracle/measurements": measurements });
    const runtime = newTestRuntime(secrets({ BACKEND_TOKEN: "tok" }), {}, capped);
    expect(onCron(runtime as never, payload)).toContain("0 new, 1 updates");
    const [r] = decodeAbiParameters(REPORT_ABI, writes[0]!.payload);
    expect(r.newTrends).toHaveLength(0);
  });
});
