import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Ai, type Provider } from "../src/ai/providers";
import { issueSession } from "../src/api/admin-auth";
import { createApp, ELFA_CHECK_INTERVAL_MS } from "../src/api/app";
import { KeyRing, keyId } from "../src/budget";
import type { ChainTrend } from "../src/chain";
import { loadConfig } from "../src/config";
import type { Sql } from "../src/db";
import { ErrorLog, scrub } from "../src/errors";
import { Elfa } from "../src/sources/elfa";
import { HttpError } from "../src/sources/http";
import { SourceStats } from "../src/sources/stats";
import { parseServices } from "../src/status";
import {
  type ElfaInputs,
  findProblems,
  overallStatus,
  type Problem,
  gatewayReport,
  egressAddress,
  rankProblems,
  redactSecrets,
  secretsOf,
  serviceFacts,
  type SystemDeps,
  SystemMonitor,
  type SystemReport,
} from "../src/system";
import { fakeFetch, json, quietLog, testDb } from "./helpers";

const NOW = Date.parse("2026-10-13T12:00:00Z");
const NOW_SEC = NOW / 1000;

/** Secrets as the configuration would hold them; none may appear in a report. */
const ELFA_KEYS = ["elfak_live_0123456789abcdefAAAA", "elfak_dead_0123456789abcdefBBBB", "elfak_slow_0123456789abcdefCCCC"];
const ROUTES = ["http://routeuser1:hunter2pass@203.0.113.10:7001", "http://routeuser2:s3cr3t%40pw@198.51.100.20:7002", "http://routeuser3:another-pw@192.0.2.30:7003"];
const RPC = "https://monad-testnet.g.alchemy.com/v2/AlchemyKeyAbcdef0123456789";
const DB = "postgres://trendr:dbpassword123@db.internal:5432/trendr";

const trend = (identifier: string, updatedAt: number, status: ChainTrend["status"] = "Active"): ChainTrend => ({
  id: `0x${identifier.length.toString(16).padStart(64, "0")}`,
  identifier,
  assetClass: 6,
  status,
  createdAt: 1,
  updatedAt,
  statusSince: 1,
  index: 40,
  peakIndex: 50,
  surfacer: "0x0000000000000000000000000000000000000000",
});

/** Each service's /health as it answers today (trimmed). */
const HEALTH: Record<string, unknown> = {
  keeper: {
    ok: true,
    keeper: "0x0000000000000000000000000000000000001003",
    lastScan: { at: NOW - 5_000, block: "1" },
    lastError: null,
    oracle: { live: 2, stale: 0, oldestUpdateSec: 60 },
    balanceWei: "286189522668000000000",
    alerts: {},
    actions: { sent: { liquidate: 1, poke: 14 }, failed: 0 },
    rpc: [
      { provider: "localhost", requests: 10, failures: 0, healthy: true },
      { provider: "alchemy.com", requests: 9, failures: 5, healthy: false },
    ],
  },
  "market-maker": { ok: true, maker: "0x8b81C6fcB4B37417184F81A207a4D9104E07f9FA", lastTick: { at: NOW - 20_000, quoted: 10 }, lastError: null, balanceWei: "398097915890000000000", killed: false, equity: 7837, baselineEquity: 800, alerts: {}, rpc: [] },
  relayer: {
    ok: true,
    keys: [{ address: "0x0000000000000000000000000000000000001004", mon: 513.7 }],
    budget: { limits: { totalGasPerHour: 300_000_000, activationsPerHour: 60 }, lastHour: { gas: 15_090_657, activations: 3 }, today: { accounts: 7, reverts: 0 }, coolingDown: 0, busyAccounts: 0 },
    rpc: [{ provider: "monad.xyz", requests: 4, failures: 0, healthy: true }],
  },
  autopilot: { ok: true, botVenue: "api", kill: { engaged: false, reason: null }, lastTickAt: NOW_SEC - 3, lastError: null, rules: 7, ordersInFlight: 0, alerts: {} },
  topup: {
    ok: true,
    role: "leader",
    dryRun: false,
    lastCheck: { at: NOW - 1_000, error: null },
    lastSuccessAt: NOW - 1_000,
    treasury: { address: "0x0000000000000000000000000000000000001001", balance: "2251.38", floor: "12", spendable: "2239.38", burnPerDay: "81.7", runwayDays: 27.38 },
    targets: [
      { name: "oracle", address: "0x0000000000000000000000000000000000001002", balance: "435.2", min: "375", target: "450", state: "ok", burnPerDay: "15.2", lastError: null },
      { name: "keeper", address: "0x0000000000000000000000000000000000001003", balance: "120", min: "250", target: "300", state: "failing", burnPerDay: "0.6", lastError: `send failed via ${RPC}` },
    ],
    wouldSend: [],
    alerts: {},
  },
  worker: { ok: true, turns: 59, failures: 5, lastTurnAt: NOW - 60_000, budget: { txs: 22, txPerDay: 150, spentAusd: 47.5, spendPerDayAusd: 400 }, traders: { one: { ready: true, lastError: null }, two: { ready: false, lastError: "relay refused" } } },
  gateway: {
    ok: true,
    head: 1000,
    headAgeMs: 900,
    uptimeSec: 86_400,
    received: 1,
    upstream: 1,
    receivedPerSec: 12.3,
    upstreamPerSec: 6.8,
    failures: 0,
    clients: { indexer: 100, keeper: 5 },
    providers: [
      { provider: "monad-testnet.core.chainstack.com..43ab", healthy: true, reserve: false, head: 999, requests: 100, ok: 100, errors: 0, rateLimited: 0, timeouts: 0, refused: 0, units: 200_000, monthlyUnits: 3_000_000, avgLatencyMs: 124, lastError: null, lastErrorAgoSec: null },
      {
        provider: "monad-testnet.gateway.tatum.io..317b",
        healthy: false,
        reserve: false,
        head: 900,
        requests: 260,
        ok: 17,
        errors: 0,
        rateLimited: 0,
        timeouts: 0,
        refused: 243,
        units: 1_243,
        monthlyUnits: 1_000_000,
        avgLatencyMs: 236,
        lastError: "refused: Method 'eth_call' is available for paid plans only, see https://co.tatum.io/upgrade/AbCdEfGhIjKlMnOpQrSt",
        lastErrorAgoSec: 31,
      },
    ],
  },
};

/** Per-service flags, as STATUS_SERVICES and ADMIN_SERVICES carry them. */
const FLAGS: Record<string, string> = { worker: "|optional|staleMin=120", gateway: "|staleMin=1" };
const STATUS_SERVICES = Object.keys(HEALTH)
  .map((n) => `${n}=http://${n}.internal/health${FLAGS[n] ?? ""}`)
  .join(",");

function fakeElfa(): ElfaInputs {
  const routes = ELFA_KEYS.map((key, i) => ({ key, keyId: keyId(key), proxy: ROUTES[i]! }));
  const [live, dead, slow] = routes;
  return {
    routes,
    skipped: [],
    unusedRoutes: ["http://spare:sparepass@9.9.9.9:1000"],
    usage: [
      { keyId: live!.keyId, today: 12, month: 300, left: 18 },
      { keyId: dead!.keyId, today: 0, month: 10, left: 30 },
      { keyId: slow!.keyId, today: 5, month: 90, left: 25 },
    ],
    benches: [
      { keyId: dead!.keyId, until: NOW + 3_600_000, reason: "rejected" },
      { keyId: slow!.keyId, until: NOW + 300_000, reason: "route-down" },
    ],
    calls: [
      { keyId: live!.keyId, requests: 40, ok: 40, failures: 0, lastOkAt: NOW - 60_000, lastErrorAt: null, lastError: null, lastStatus: 200, lastOutcome: "ok", check: null },
      { keyId: dead!.keyId, requests: 2, ok: 0, failures: 2, lastOkAt: null, lastErrorAt: NOW - 120_000, lastError: "HTTP 401 Invalid API key", lastStatus: 401, lastOutcome: "rejected", check: null },
      // A route failure quoting the route's URL, credentials included, as Bun may.
      { keyId: slow!.keyId, requests: 3, ok: 1, failures: 2, lastOkAt: NOW - 900_000, lastErrorAt: NOW - 30_000, lastError: `connect failed ${ROUTES[2]}`, lastStatus: null, lastOutcome: "route-down", check: null },
    ],
    busy: new Set([ROUTES[0]!]),
    narrativesAllowed: () => false,
    narrativesAvailable: false,
  };
}

function deps(over: Partial<SystemDeps> = {}, health: Record<string, unknown> = HEALTH, down: string[] = []): SystemDeps {
  const errors = new ErrorLog(200, () => NOW);
  const stats = new SourceStats(errors, () => NOW);
  stats.register("wikipedia");
  return {
    chainId: 10143,
    services: parseServices(STATUS_SERVICES),
    oracleStaleSec: 600,
    jobIntervals: { collector: 60, radar: 7200, history: 60 },
    refreshSec: { wikipedia: 21_600, bluesky: 1800 },
    store: {
      ping: async () => {},
      jobs: async () => [
        { job: "collector", lastOkAt: new Date(NOW - 30_000), lastError: null, lastErrorAt: null, lastReport: {} },
        { job: "radar", lastOkAt: new Date(NOW - 3_600_000), lastError: `elfa: fetch failed ${RPC}`, lastErrorAt: new Date(NOW - 60_000), lastReport: {} },
      ],
      readingFreshness: async () => [
        { source: "wikipedia", newestAt: NOW - 600_000, lastHour: 4 },
        { source: "bluesky", newestAt: NOW - 30 * 3_600_000, lastHour: 0 },
      ],
    },
    chain: {
      trends: async () => [trend("topic:a", NOW_SEC - 60), trend("topic:b", NOW_SEC - 120), trend("topic:c.2", NOW_SEC - 99_999, "Retired")],
      lastRunId: async () => BigInt(NOW_SEC - 50),
      staleRetireWindow: async () => 7200,
      client: { getBlock: async () => ({ number: 1000n, timestamp: BigInt(NOW_SEC - 1) }) },
    },
    rpcUrls: [RPC],
    indexer: {
      progress: async () => ({ progressBlock: 990, sourceBlock: 1000, startBlock: 1, eventsProcessed: 4000, progressBlockAt: NOW - 5_000, readyAt: NOW - 86_400_000 }),
      oracle: async () => ({ lastRun: { runId: NOW_SEC - 50, created: 0, updated: 2, settled: 1, rejected: 0, at: NOW_SEC - 49 }, lastSettlementAt: NOW_SEC - 3600, settlements24h: 5 }),
    },
    elfa: async () => fakeElfa(),
    elfaLimits: { dailyPerKey: 100, monthlyPerKey: 950 },
    fallback: () => ({ month: "2026-10", bytes: 270 * 1024 * 1024, capBytes: 300 * 1024 * 1024, requests: 900 }),
    sources: {
      stats: () => {
        const s = stats.report();
        s.push({ name: "gdelt", requests: 10, ok: 8, errors: 0, rateLimited: 2, lastOkAt: NOW - 600_000, lastErrorAt: NOW - 60_000, lastError: "gdelt: HTTP 429", lastStatus: 429 });
        s.push({ name: "bluesky", requests: 50, ok: 50, errors: 0, rateLimited: 0, lastOkAt: NOW - 10_000, lastErrorAt: null, lastError: null, lastStatus: 200 });
        return s;
      },
      resting: { gdelt: () => true },
      configured: { nansen: false },
    },
    ai: {
      report: () => [
        { name: "gemini:flash", requests: 9, ok: 0, failures: 9, lastOkAt: null, lastErrorAt: NOW - 1000, lastError: scrub("gemini: HTTP 429 key AIzaSyA-0123456789abcdefghijklmnop"), benchedUntil: NOW + 60_000 },
        { name: "kimi:k2", requests: 4, ok: 4, failures: 0, lastOkAt: NOW - 5000, lastErrorAt: null, lastError: null, benchedUntil: null },
      ],
      leftToday: async () => 120,
      dailyCalls: 400,
    },
    errors,
    secrets: secretsOf({ keys: [...ELFA_KEYS, "AIzaSyA-0123456789abcdefghijklmnop"], routes: ROUTES, urls: [RPC, DB] }),
    fetchImpl: async (url: string) => {
      const name = new URL(url).hostname.replace(".internal", "");
      if (down.includes(name)) throw new Error("connect ECONNREFUSED");
      return json(health[name] ?? { ok: true });
    },
    now: () => NOW,
    startedAt: NOW - 3_600_000,
    ...over,
  };
}

describe("service facts", () => {
  test("reads each Trendr service's health shape", () => {
    const keeper = serviceFacts(HEALTH.keeper, NOW);
    expect(keeper.lastWorkAt).toBe(NOW - 5_000);
    expect(keeper.facts.find((f) => f.label === "Oracle")?.value).toBe("2 live, 0 stale");
    expect(keeper.facts.find((f) => f.label === "Actions")?.value).toBe("15 sent, 0 failed");

    const mm = serviceFacts(HEALTH["market-maker"], NOW);
    expect(mm.facts.find((f) => f.label === "Kill switch")).toEqual({ label: "Kill switch", value: "off", tone: "ok" });
    expect(serviceFacts({ ...(HEALTH["market-maker"] as object), killed: true }, NOW).flags).toEqual(["kill switch engaged"]);

    // The executor reports its tick in seconds.
    expect(serviceFacts(HEALTH.autopilot, NOW).lastWorkAt).toBe((NOW_SEC - 3) * 1000);
    expect(serviceFacts(HEALTH.relayer, NOW).facts.map((f) => f.label)).toEqual(["Sponsor keys", "Gas last hour", "Activations last hour", "Accounts today", "Queue"]);
    expect(serviceFacts(HEALTH.topup, NOW).facts.find((f) => f.label === "Role")?.value).toBe("leader");
    expect(serviceFacts(HEALTH.worker, NOW).facts.find((f) => f.label === "Traders ready")?.value).toBe("1 of 2");
    const gateway = serviceFacts(HEALTH.gateway, NOW);
    expect(gateway.lastWorkAt).toBe(NOW - 900);
    expect(gateway.facts.find((f) => f.label === "Providers healthy")).toMatchObject({ value: "1 of 2", tone: "warn" });
    expect(serviceFacts(null, NOW)).toEqual({ facts: [], lastWorkAt: null, flags: [] });
  });

  test("projects each gateway provider's month from its pace, and cuts URLs from its errors", () => {
    const gateway = gatewayReport(HEALTH.gateway, NOW)!;
    const [chainstack, tatum] = gateway.providers;
    // 200,000 units in a day is 6,000,000 a month: twice the free 3,000,000.
    expect(chainstack).toMatchObject({ projectedMonthUnits: 6_000_000, budgetPct: 200, headLag: 1 });
    expect(tatum).toMatchObject({ healthy: false, refused: 243, lastErrorAt: NOW - 31_000 });
    expect(tatum!.lastError).not.toContain("AbCdEfGhIjKlMnOpQrSt");
    // Minutes of traffic do not project.
    expect(gatewayReport({ ...(HEALTH.gateway as object), uptimeSec: 120 }, NOW)!.providers[0]!.budgetPct).toBeNull();
    // Recognized by its shape, whatever the service is called; anything else is no gateway.
    expect(gatewayReport({ ok: true, providers: [{ provider: "x" }] }, NOW)).toBeNull();
    expect(gatewayReport(HEALTH.keeper, NOW)).toBeNull();
  });
});

describe("problem ranking", () => {
  test("critical first, then by area, then by title", () => {
    const p = (severity: Problem["severity"], area: Problem["area"], title: string): Problem => ({ severity, area, title });
    const ranked = rankProblems([p("info", "sources", "b"), p("warning", "elfa", "x"), p("critical", "services", "topup is down"), p("warning", "services", "y"), p("critical", "database", "db")]);
    expect(ranked.map((r) => r.title)).toEqual(["db", "topup is down", "y", "x", "b"]);
    expect(overallStatus(ranked)).toBe("critical");
    expect(overallStatus([p("info", "sources", "b")])).toBe("ok");
    expect(overallStatus([p("warning", "elfa", "x")])).toBe("degraded");
  });
});

describe("system report", () => {
  test("aggregates every part and ranks what is wrong", async () => {
    const r = await new SystemMonitor(deps()).build();
    expect(r.services.map((s) => [s.name, s.state])).toEqual([
      ["backend", "degraded"],
      ["keeper", "up"],
      ["market-maker", "up"],
      ["relayer", "up"],
      ["autopilot", "up"],
      ["topup", "up"],
      ["worker", "up"],
      ["gateway", "up"],
      ["oracle", "up"],
      ["indexer", "up"],
    ]);
    expect(r.chain).toMatchObject({ ok: true, head: 1000, headAgeSec: 1 });
    expect(r.indexer).toMatchObject({ progressBlock: 990, lagBlocks: 10, lagSec: 4 });
    expect(r.oracle).toMatchObject({ ok: true, lastRunAgeSec: 50, liveTrends: 2, totalTrends: 3, staleTrends: 0, retireWindowSec: 7200, settlements24h: 5 });
    expect(r.elfa.keys.map((k) => [k.key, k.route, k.state, k.usedToday, k.allowanceToday])).toEqual([
      ["...AAAA", "203.0.113.10:7001", "ok", 12, 30],
      ["...BBBB", "198.51.100.20:7002", "rejected", 0, 30],
      ["...CCCC", "192.0.2.30:7003", "route-down", 5, 30],
    ]);
    expect(r.elfa.keys[0]!.busy).toBe(true);
    expect(r.elfa.unusedRoutes).toEqual(["9.9.9.9:1000"]);
    expect(r.elfa.fallback?.pct).toBe(90);
    expect(r.rpc.gateway!.providers).toHaveLength(2);
    expect(r.services.find((s) => s.name === "worker")?.core).toBe(false);
    expect(r.services.find((s) => s.name === "gateway")?.core).toBe(true);
    expect(r.rpc.services.map((s) => s.service)).toEqual(["keeper", "relayer"]);
    expect(r.wallets.treasury?.runwayDays).toBe(27.38);
    expect(r.wallets.rows.map((w) => w.name)).toEqual(["oracle", "keeper", "market-maker (maker)", "relayer (sponsor key 1)"]);
    expect(r.sources.find((s) => s.name === "gdelt")?.state).toBe("resting");
    expect(r.sources.find((s) => s.name === "nansen")?.state).toBe("off");
    expect(r.sources.find((s) => s.name === "bluesky")?.staleReadings).toBe(true);
    expect(r.ai.providers.map((p) => p.state)).toEqual(["resting", "ok"]);
    expect(r.jobs.find((j) => j.job === "radar")?.state).toBe("failing");

    expect(r.status).toBe("degraded");
    const titles = r.problems.map((p) => `${p.severity} ${p.title}`);
    expect(titles).toContain("warning Top-ups to keeper are failing");
    expect(titles).toContain("warning keeper holds 120 MON, under its 250 MON minimum");
    expect(titles).toContain("warning Elfa key 2 (...BBBB, via 198.51.100.20:7002) was rejected (401)");
    expect(titles).toContain("warning Elfa key 3 (...CCCC, via 192.0.2.30:7003): its route is not answering");
    expect(titles).toContain("warning 1 of 2 RPC gateway providers are failing");
    expect(titles).toContain("warning monad-testnet.core.chainstack.com..43ab is on pace for 200% of its free monthly units");
    expect(titles).toContain("warning keeper: alchemy.com failing");
    expect(titles).toContain("warning Keyless fallback routes have used 90% of this month's bandwidth");
    expect(titles).toContain("warning Bluesky's newest reading is 30.0h old");
    expect(titles).toContain("info GDELT is resting after rate limiting");
    // Most severe first.
    const ranks = r.problems.map((p) => ({ critical: 0, warning: 1, info: 2 })[p.severity]);
    expect([...ranks].sort((a, b) => a - b)).toEqual(ranks);
    expect(r.errors.map((e) => e.source)).toEqual(expect.arrayContaining(["topup", "worker", "gateway"]));
  });

  test("a stopped service, a stale oracle and a lagging indexer go to the top", async () => {
    const d = deps(
      {
        chain: { ...deps().chain, lastRunId: async () => BigInt(NOW_SEC - 1800) },
        indexer: { ...deps().indexer!, progress: async () => ({ progressBlock: 100, sourceBlock: 1000, startBlock: 1, eventsProcessed: 1, progressBlockAt: NOW - 1_200_000, readyAt: null }) },
      },
      HEALTH,
      ["topup"],
    );
    const r = await new SystemMonitor(d).build();
    expect(r.status).toBe("critical");
    expect(r.services.find((s) => s.name === "topup")).toMatchObject({ state: "down", httpStatus: null, reason: "no answer (connection refused or unreachable)" });
    const critical = r.problems.filter((p) => p.severity === "critical").map((p) => p.title);
    expect(critical).toEqual(["topup is down", "The oracle last reported 30m ago", "The indexer is 20m behind the chain"]);
    expect(r.problems[0]!.title).toBe("topup is down");
    // Without the top-up service there is no treasury, and its wallets are not listed.
    expect(r.wallets.treasury).toBeNull();

    // A service flagged optional being down is a warning, not critical.
    const optional = await new SystemMonitor(deps({}, HEALTH, ["worker"])).build();
    expect(optional.problems.find((p) => p.title === "worker is down")?.severity).toBe("warning");
  });

  test("each service stalls after its own staleMin, else after Trendr's default for it", async () => {
    const health = {
      ...HEALTH,
      worker: { ...(HEALTH.worker as object), lastTurnAt: NOW - 3 * 3_600_000 },
      gateway: { ...(HEALTH.gateway as object), headAgeMs: 120_000 },
    };
    const r = await new SystemMonitor(deps({}, health)).build();
    expect(r.services.find((s) => s.name === "worker")).toMatchObject({ state: "degraded", reason: "no work for 3.0h" });
    expect(r.services.find((s) => s.name === "gateway")).toMatchObject({ state: "degraded", reason: "no work for 2m" });
    // Within the window, and without a flag or a default, no stall.
    const calm = await new SystemMonitor(deps({ services: parseServices(STATUS_SERVICES.replace("|optional|staleMin=120", "")) }, { ...health, gateway: HEALTH.gateway })).build();
    expect(calm.services.find((s) => s.name === "worker")?.state).toBe("up");
    expect(calm.services.find((s) => s.name === "gateway")?.state).toBe("up");
  });

  test("a dependency that hangs or throws never holds or breaks the report", async () => {
    const hang = new Promise<never>(() => {});
    const r = await new SystemMonitor(
      deps({ store: { ...deps().store, ping: () => hang }, chain: { ...deps().chain, client: { getBlock: async () => Promise.reject(new Error(`fetch failed ${RPC}`)) } }, indexer: null, elfa: null }),
    ).build();
    expect(r.database).toMatchObject({ ok: false });
    expect(r.database.error).toContain("timed out");
    expect(r.chain.ok).toBe(false);
    expect(r.problems.slice(0, 2).map((p) => p.title)).toEqual(["The database is not answering", "The chain cannot be read"]);
    expect(r.elfa.configured).toBe(false);
    expect(JSON.stringify(r)).not.toContain("AlchemyKeyAbcdef0123456789");
  }, 15_000);

  test("never carries a key, a route credential or a keyed URL", async () => {
    const errors = new ErrorLog(200, () => NOW);
    // Errors as careless code might log them.
    errors.note("backend", `request failed: ${RPC} via ${ROUTES[1]}`);
    errors.note("backend", `elfa said no to ${ELFA_KEYS[0]}`);
    errors.note("backend", `db ${DB}`);
    const monitor = new SystemMonitor({ ...deps(), errors });
    monitor.noteKeyCheck([{ keyId: keyId(ELFA_KEYS[1]!), outcome: "rejected", status: 401, plan: null, free: null, usedThisMonth: null, monthlyLimit: null, remaining: null, error: "HTTP 401 Invalid API key" }]);
    const text = JSON.stringify(await monitor.report());
    for (const secret of [...ELFA_KEYS, "elfak_", "hunter2pass", "s3cr3t", "another-pw", "routeuser1", "routeuser2", "routeuser3", "sparepass", "AlchemyKeyAbcdef0123456789", "/v2/Alch", "dbpassword123", "AIzaSyA-0123456789", "AbCdEfGhIjKlMnOpQrSt"]) {
      expect(text).not.toContain(secret);
    }
    // What is shown instead: the last four characters, and the route's host and port.
    expect(text).toContain("...BBBB");
    expect(text).toContain("198.51.100.20:7002");
  });

  test("secrets left in text by anything else are replaced", () => {
    const secrets = secretsOf({ keys: ["k-0123456789"], routes: ["http://u:p%40ss-word@h:1"], urls: ["https://x.example/rpc/0123456789abcdef0123"] });
    expect(secrets).toContain("p@ss-word");
    const out = redactSecrets({ a: ["k-0123456789 and p@ss-word"], b: { c: "path 0123456789abcdef0123" }, n: 3 }, secrets);
    expect(out).toEqual({ a: ["[redacted] and [redacted]"], b: { c: "path [redacted]" }, n: 3 });
    expect(egressAddress(ROUTES[0]!)).toBe("203.0.113.10:7001");
    expect(egressAddress("nope")).toBe("invalid route");
  });

  test("the report is cached briefly, and a fresh one is built after", async () => {
    let probes = 0;
    let t = NOW;
    const d = deps({ now: () => t });
    const monitor = new SystemMonitor({ ...d, fetchImpl: async (url, init) => (probes++, d.fetchImpl!(url, init)) });
    await Promise.all([monitor.report(), monitor.report()]);
    expect(probes).toBe(Object.keys(HEALTH).length);
    t += 6000;
    await monitor.report();
    expect(probes).toBe(Object.keys(HEALTH).length * 2);
  });
});

describe("recent errors", () => {
  test("deduplicates by source and shape, counts repeats, and keeps the newest text", () => {
    let t = NOW;
    const log = new ErrorLog(3, () => t);
    log.note("keeper", "tx 0xabcdef0123456789 reverted at block 1234567");
    t += 1000;
    log.note("keeper", "tx 0x9999999999999999 reverted at block 1234999");
    // A reporter's own time: the same time is the same error.
    log.note("gateway", "tatum: refused", NOW - 5000);
    log.note("gateway", "tatum: refused", NOW - 5000);
    log.note("gateway", "tatum: refused", NOW - 1000);
    const recent = log.recent();
    expect(recent.map((e) => [e.source, e.count])).toEqual([
      ["keeper", 2],
      ["gateway", 2],
    ]);
    expect(recent[0]!.message).toBe("tx 0x9999999999999999 reverted at block 1234999");
    // A lastError reported on every poll counts once until it goes away for a while.
    log.seen("relayer", "low balance");
    t += 30_000;
    log.seen("relayer", "low balance");
    expect(log.recent().find((e) => e.source === "relayer")?.count).toBe(1);
    t += 200_000;
    log.seen("relayer", "low balance");
    expect(log.recent().find((e) => e.source === "relayer")?.count).toBe(2);
    // Bounded: the oldest observed entries go first.
    log.note("x", "one");
    log.note("y", "two");
    expect(log.recent(10).length).toBe(3);
  });

  test("scrubs URLs, credentials and keys", () => {
    expect(scrub(`failed ${RPC}.`)).toBe("failed https://monad-testnet.g.alchemy.com/...");
    expect(scrub("see https://co.tatum.io/upgrade/AbCdEfGhIjKl......")).toBe("see https://co.tatum.io/...");
    expect(scrub("via http://user:pw@1.2.3.4:80 refused")).toBe("via http://1.2.3.4:80 refused");
    expect(scrub("db postgres://u:p@db:5432/x?sslmode=require")).toBe("db postgres://db:5432/...");
    expect(scrub("key elfak_abcdefgh1234 rejected")).toBe("key *** rejected");
    expect(scrub("x".repeat(500)).length).toBe(300);
  });
});

describe("source counters", () => {
  test("count successes, refusals and failures per source", async () => {
    const errors = new ErrorLog(200, () => NOW);
    const stats = new SourceStats(errors, () => NOW);
    const answers = [json({}), json({}, 429), json({}, 503), json({}, 404)];
    const f = stats.track("bluesky", async () => answers.shift()!);
    await f("https://api.bsky.app/a");
    await f("https://api.bsky.app/b");
    await f("https://api.bsky.app/c");
    await f("https://api.bsky.app/d");
    const boom = stats.track("hn", async () => Promise.reject(new Error(`connect to ${ROUTES[0]} failed`)));
    await expect(boom("https://hn.algolia.com/x")).rejects.toThrow();
    const [bluesky, hn] = stats.report();
    expect(bluesky).toMatchObject({ requests: 4, ok: 2, rateLimited: 1, errors: 1, lastStatus: 404, lastOkAt: NOW });
    expect(hn).toMatchObject({ requests: 1, errors: 1, lastStatus: null });
    expect(hn!.lastError).not.toContain("hunter2pass");
    expect(errors.recent().map((e) => e.message).sort()).toEqual(["bluesky: HTTP 429", "bluesky: HTTP 503", expect.stringContaining("hn: connect to http://203.0.113.10:7001")]);
  });
});

describe("AI provider counters", () => {
  test("count each provider's requests and rest a refused one", async () => {
    let t = NOW;
    const refused: Provider = { name: "gemini:x", generate: async () => Promise.reject(new HttpError("gemini:x", 429, "quota exceeded for key AIzaSyA-0123456789abcdefghijklmnop")) };
    const fine: Provider = { name: "kimi:y", generate: async () => ({ ok: 1 }) };
    const ai = new Ai([refused, fine], () => {}, () => t);
    await ai.json("s", "u", { type: "object", properties: {}, required: [] } as never, "x", (v) => v);
    const [a, b] = ai.report();
    expect(a).toMatchObject({ requests: 1, failures: 1, benchedUntil: NOW + 3_600_000 });
    expect(a!.lastError).not.toContain("0123456789abcdefghijklmnop");
    expect(b).toMatchObject({ requests: 1, ok: 1, lastOkAt: NOW, benchedUntil: null });
    t += 3_600_001;
    expect(ai.report()[0]!.benchedUntil).toBeNull();
  });
});

describe("elfa key checks", () => {
  let sql: Sql;
  beforeAll(async () => {
    sql = await testDb();
  });
  afterAll(async () => {
    await sql.end();
  });

  test("check every key, act on each answer, and report it without the key", async () => {
    const keys = ["elfak_ok_000000000001", "elfak_dead_0000000002", "elfak_route_000000003"];
    const ring = new KeyRing(sql, "elfa-system", keys, { daily: 100, monthly: 950 }, () => new Date(NOW));
    const ids = keys.map(keyId);
    const routeOf = new Map(ids.map((id, i) => [id, ROUTES[i]!]));
    const f = fakeFetch([
      [
        /key-status/,
        (_url, init) => {
          const key = (init?.headers as Record<string, string>)["x-elfa-api-key"];
          if (key === keys[1]) return json({ success: false, message: "Invalid API key" }, 401);
          if (key === keys[2]) return new Response("", { status: 407 });
          return json({ success: true, data: { plan: "free", usage: { monthly: 120 }, monthlyRequestLimit: 1000 } });
        },
      ],
    ]);
    const elfa = new Elfa(ring, "https://api.elfa.ai", f.impl, (id) => routeOf.get(id) ?? null, true);
    const routes = keys.map((key, i) => ({ key, keyId: ids[i]! }));
    const checks = await elfa.checkKeys(routes);
    expect(checks.map((c) => [c.outcome, c.status, c.usedThisMonth])).toEqual([
      ["ok", 200, 120],
      ["rejected", 401, null],
      ["route-auth", 407, null],
    ]);
    expect(f.calls.map((c) => (c.init as { proxy?: string }).proxy)).toEqual(ROUTES);
    expect(ring.benches().map((b) => [b.keyId, b.reason])).toEqual([
      [ids[1]!, "rejected"],
      [ids[2]!, "route-auth"],
    ]);
    expect((await ring.usage())[0]!.month).toBe(120);
    expect(elfa.narrativesAllowed(ids[0]!)).toBe(false);
    const calls = elfa.keyCalls();
    expect(calls.map((c) => c.lastOutcome)).toEqual(["ok", "rejected", "route-auth"]);
    expect(calls[1]!.lastError).toBe("HTTP 401 Invalid API key");
    expect(calls[0]!.check).toMatchObject({ plan: "free", usedThisMonth: 120 });
    expect(JSON.stringify([checks, calls])).not.toMatch(/elfak_|hunter2pass|routeuser/);
    // The start-up sync keeps its answer.
    expect(await elfa.syncUsage(routes)).toEqual({ rejected: [ids[1]!], failed: [ids[2]!] });
  });

  test("the admin routes need a session, and the key check runs at most once a minute", async () => {
    const secret = "s".repeat(64);
    const admin = "0x70997970c51812dc3a010c7d01b50e0d17dc79c8";
    const cfg = loadConfig({ DATABASE_URL: "postgres://unused", MONAD_RPC_URL: "https://rpc.example.org", ORACLE_TOKEN: "test-oracle-token-0123456789", ADMIN_ADDRESSES: admin });
    let t = NOW;
    let checks = 0;
    const system = new SystemMonitor(deps({ now: () => t }));
    const app = createApp({
      cfg,
      store: { sql, isRevoked: async () => false } as never,
      chain: { client: {} } as never,
      collector: {} as never,
      radar: {} as never,
      ai: new Ai([]),
      gdelt: {} as never,
      rings: { elfa: null, nansen: null },
      jobs: {} as never,
      adminSessionSecret: secret,
      history: {} as never,
      autopilot: { store: {} as never, service: {} as never },
      push: {} as never,
      faucet: null,
      system,
      elfaCheck: async () => (checks++, [{ keyId: keyId(ELFA_KEYS[0]!), outcome: "ok", status: 200, plan: "free", free: true, usedThisMonth: 301, monthlyLimit: 1000, remaining: 699, error: null }]),
      log: quietLog,
      now: () => t,
    });
    expect((await app.request("/v1/admin/system")).status).toBe(401);
    const auth = { authorization: `Bearer ${issueSession(secret, admin, Math.floor(t / 1000) + 3600)}` };
    const res = await app.request("/v1/admin/system", { headers: auth });
    expect(res.status).toBe(200);
    const body = (await res.json()) as SystemReport;
    expect(body.services.length).toBeGreaterThan(5);
    expect(findProblems(body).length).toBe(body.problems.length);

    const check = await app.request("/v1/admin/system/elfa-check", { method: "POST", headers: auth });
    expect(check.status).toBe(202);
    // The check runs in the background; each result shows in the report as it lands.
    await new Promise((r) => setTimeout(r, 0));
    const after = (await (await app.request("/v1/admin/system", { headers: auth })).json()) as SystemReport;
    expect(after.elfa.lastCheck?.running).toBe(false);
    expect(after.elfa.lastCheck?.total).toBeGreaterThan(0);
    expect(after.elfa.lastCheck?.results[0]).toMatchObject({ index: 1, key: "...AAAA", route: "203.0.113.10:7001", outcome: "ok", usedThisMonth: 301 });
    const again = await app.request("/v1/admin/system/elfa-check", { method: "POST", headers: auth });
    expect(again.status).toBe(429);
    expect(Number(again.headers.get("retry-after"))).toBeGreaterThan(0);
    t += ELFA_CHECK_INTERVAL_MS;
    expect((await app.request("/v1/admin/system/elfa-check", { method: "POST", headers: auth })).status).toBe(202);
    await new Promise((r) => setTimeout(r, 0));
    expect(checks).toBe(2);
  });
});
