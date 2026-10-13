import { endpointPool } from "@trendr/chain";
import { perplSessionMaxLeverage } from "@trendr/contracts";
import { type Context, Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { cors } from "hono/cors";
import { isAddress } from "viem";
import { z } from "zod";
import { assess } from "../ai/assess";
import { autopilotAdminRoutes, autopilotRoutes } from "../autopilot/routes";
import type { AutopilotService } from "../autopilot/service";
import type { AutopilotStore } from "../autopilot/store";
import type { Ai } from "../ai/providers";
import type { KeyRing } from "../budget";
import type { ChainReader, ChainTrend } from "../chain";
import type { Collector } from "../collector";
import type { IndexHistory } from "../history";
import { isPushEndpoint, type Push, TOPICS, type Topic } from "../notify/push";
import { type Faucet, FaucetError } from "../faucet/faucet";
import { moderationRoutes } from "../social/moderation";
import { socialRoutes } from "../social/routes";
import { parseServices, serviceDetails, status } from "../status";
import { AccountKeys, SIGNER_CHECK_TTL_MS, tradingSelectors, userAuth } from "./user-auth";
import { ownerApprovalRoutes, OwnerApprovals } from "./owner-approval";
import type { Config } from "../config";
import { ASSET_CLASSES, baseOf, isNormalized } from "../identifiers";
import { LinkError, resolveLink } from "../links";
import type { Log } from "../log";
import { type Radar, SOURCE_ATTRIBUTION } from "../radar";
import { rankQueue } from "../queue";
import type { Jobs } from "../jobs";
import type { Gdelt } from "../sources/gdelt";
import type { Fetch } from "../sources/http";
import { type Candidate, type CandidateStatus, type Reading, SOURCES, type SourceName, type Store, type TrendMeta } from "../store";
import { ADMIN_SESSION_SEC, adminAuth, bearer, issueSession, tokenHash } from "./admin-auth";
import { byIp, rateLimit } from "./rate-limit";
import type { IndexerReader } from "../indexer";
import type { AuroraClient } from "@trendr/aurora";
import { depositRoutes } from "../deposits/routes";
import { type ActivationTickets, activationTicketRoutes } from "../activation/tickets";
import { waitlistAdminRoutes, waitlistRoutes } from "../waitlist/routes";
import type { KeyCheck } from "../sources/elfa";
import type { SystemMonitor } from "../system";

export interface AppDeps {
  cfg: Config;
  store: Store;
  chain: ChainReader;
  collector: Collector;
  radar: Radar;
  ai: Ai;
  gdelt: Gdelt;
  /** Keyless sources whose rate-limit state health reports. */
  feeds?: {
    bluesky?: { available: boolean } | null;
    hn?: { available: boolean } | null;
    coingecko?: { http: { available: boolean } } | null;
    geckoterminal?: { http: { available: boolean } } | null;
    /** Fallback traffic this month against its cap. */
    proxyFallback?: { stats: { month: string; bytes: number; capBytes: number; requests: number } } | null;
  };
  /** API budgets; `ai` is the daily allowance of AI provider requests the radar and links share. */
  rings: { elfa: KeyRing | null; nansen: KeyRing | null; ai?: KeyRing | null };
  jobs: Jobs;
  /** HMAC key for admin session tokens. */
  adminSessionSecret: string;
  history: IndexHistory;
  autopilot: { store: AutopilotStore; service: AutopilotService };
  push: Push;
  /** Testnet AUSD for testers; null on Mainnet or when unconfigured. */
  faucet: Faucet | null;
  /** Signs the relayer's activation tickets; null when no ticket key is configured. */
  tickets?: ActivationTickets | null;
  /** The Envio indexer's history; null when it is not configured. */
  indexer?: IndexerReader | null;
  /** Aurora Intents for any-chain deposits; null without an API key. */
  aurora?: AuroraClient | null;
  /** The admin system view (GET /v1/admin/system); null turns it off. */
  system?: SystemMonitor | null;
  /** Asks Elfa for every key's status (one credit per key), for the system view's "check keys" action. */
  elfaCheck?: ((onResult?: (done: readonly KeyCheck[]) => void) => Promise<KeyCheck[]>) | null;
  log: Log;
  fetchImpl?: Fetch;
  now?: () => number;
}

const readings = (r: Partial<Record<SourceName, Reading>> | undefined) =>
  Object.fromEntries(SOURCES.map((s) => [s, r?.[s] ? { value: r[s]!.value, windowSec: r[s]!.windowSec, observedAt: r[s]!.observedAt } : null]));

function trendJson(t: ChainTrend, meta: TrendMeta | undefined, latest: Partial<Record<SourceName, Reading>> | undefined) {
  return {
    id: t.id,
    identifier: t.identifier,
    displayName: meta?.displayName ?? null,
    summary: meta?.summary ?? null,
    assetClass: ASSET_CLASSES[t.assetClass] ?? "topic",
    status: t.status.toLowerCase(),
    index: t.index,
    peakIndex: t.peakIndex,
    createdAt: t.createdAt,
    updatedAt: t.updatedAt,
    surfacer: t.surfacer,
    keywords: meta?.keywords ?? [],
    article: meta?.article ?? null,
    ticker: meta?.ticker ?? null,
    readings: readings(latest),
  };
}

function candidateJson(c: Candidate, full: boolean) {
  return {
    id: c.id,
    identifier: c.identifier,
    displayName: c.displayName,
    summary: c.summary,
    assetClass: ASSET_CLASSES[c.assetClass] ?? "topic",
    keywords: c.keywords,
    article: c.article,
    ticker: c.ticker,
    source: c.source,
    /** Credit the source's terms require next to its data (CoinGecko, GeckoTerminal), else null. */
    attribution: SOURCE_ATTRIBUTION[c.source] ?? null,
    surfacer: c.surfacer,
    status: c.status,
    createdAt: c.createdAt.toISOString(),
    ...(full ? { confidence: c.confidence, ai: c.ai, sourceRef: c.sourceRef, decidedBy: c.decidedBy, updatedAt: c.updatedAt.toISOString() } : {}),
  };
}

const decisionBody = z.object({
  decision: z.enum(["approve", "reject"]),
  identifier: z.string().refine(isNormalized, "identifiers use a-z, 0-9 and :._- only").optional(),
  displayName: z.string().min(1).max(40).optional(),
  keywords: z.array(z.string().min(1).max(60)).min(1).max(5).optional(),
  article: z.string().max(200).nullable().optional(),
  summary: z.string().max(140).optional(),
});

const linkBody = z.object({
  url: z.string().min(8).max(2048),
  /** Optional: the signed-in account is the surfacer, and a different one is refused. */
  surfacer: z.string().refine((a) => isAddress(a), "surfacer must be an address").optional(),
});

/** The "check keys" action spends a credit per key, so it runs at most this often. */
export const ELFA_CHECK_INTERVAL_MS = 60_000;

/** The largest request body: the vault's biggest item (64 KiB of ciphertext) plus its JSON. */
export const MAX_BODY_BYTES = 72 * 1024;
/** Pasted links stop once this share of the day's AI budget is spent, keeping the rest for the radar. */
export const LINK_AI_SHARE = 0.5;
export const LINKS_PER_ACCOUNT_PER_DAY = 20;
/**
 * Sign-ins per client IP per SIGN_IN_WINDOW_MS. Checking a sign-in costs database and chain reads
 * (a session key's permissions, an admin wallet's signature), so an anonymous caller cannot make
 * them unbounded; a real user signs in a few times a day.
 */
export const SIGN_INS_PER_WINDOW = 60;
export const SIGN_IN_WINDOW_MS = 600_000;

export function createApp(d: AppDeps): Hono {
  const app = new Hono();
  const now = d.now ?? Date.now;
  const ipLimit = byIp(d.cfg.TRUSTED_PROXY_HOPS);
  // Who may act for an account: its own key, or its trading session key while active on chain.
  const keys = new AccountKeys(d.chain.client, tradingSelectors(d.cfg.deployment), (a, k) => d.autopilot.store.isGrantKey(a, k), SIGNER_CHECK_TTL_MS, now);
  const signedIn = userAuth(d.adminSessionSecret, (h) => d.store.isRevoked(h), keys, now);
  // Follows, enabling rules and identity links also need the passkey's approval, not only a session.
  const approvals = new OwnerApprovals(d.store.sql, d.chain.client, d.cfg.CHAIN_ID, now);

  // The app and admin origins reach every route; the website reaches only the waitlist form. Pages
  // read Retry-After to say when a refused request may try again, and admin downloads keep their names.
  const corsOrigin = (origin: string, c: Context) => (d.cfg.frontendOrigins.includes(origin) || (c.req.path === "/v1/waitlist" && d.cfg.landingOrigins.includes(origin)) ? origin : null);
  app.use("*", cors({ origin: corsOrigin, allowHeaders: ["content-type", "authorization", "x-trendr-address", "x-trendr-timestamp", "x-trendr-nonce", "x-trendr-signature"], exposeHeaders: ["retry-after", "content-disposition"], maxAge: 600 }));
  if (d.cfg.TRUSTED_PROXY_HOPS === 0) {
    // Behind a proxy with 0 hops, every caller shares the proxy's address and its per-IP limits.
    let warned = false;
    app.use("*", async (c, next) => {
      if (!warned && c.req.header("x-forwarded-for")) {
        warned = true;
        d.log.warn({}, "requests carry X-Forwarded-For but TRUSTED_PROXY_HOPS is 0: if a proxy is in front, every caller shares its address limits; set TRUSTED_PROXY_HOPS to the number of proxies (Railway: 1)");
      }
      await next();
    });
  }
  app.use("*", bodyLimit({ maxSize: MAX_BODY_BYTES, onError: (c) => c.json({ error: "request body too large" }, 413) }));
  app.onError((e, c) => {
    d.log.error({ err: e.message, path: c.req.path }, "request failed");
    return c.json({ error: "internal error" }, 500);
  });

  /** The full system picture for operators: budgets, AI providers, RPC health, job outcomes. */
  const healthDetail = async (): Promise<{ ok: boolean } & Record<string, unknown>> => {
    const checks: Record<string, unknown> = {};
    let ok = true;
    try {
      await d.store.sql`SELECT 1`;
      checks.db = "ok";
    } catch (e) {
      ok = false;
      checks.db = e instanceof Error ? e.message : "down";
    }
    try {
      const trends = await d.chain.trends();
      checks.chain = {
        chainId: d.cfg.CHAIN_ID,
        trends: trends.length,
        live: trends.filter((t) => t.status === "Active" || t.status === "Cooling").length,
        lastRunId: Number(await d.chain.lastRunId()),
        rpc: endpointPool(d.cfg.rpcUrls)?.report() ?? [],
      };
    } catch (e) {
      ok = false;
      checks.chain = e instanceof Error ? e.message.slice(0, 200) : "down";
    }
    const budget = async (ring: KeyRing | null) => (ring ? { keys: ring.size, leftToday: await ring.leftToday() } : null);
    checks.budgets = { elfa: await budget(d.rings.elfa), nansen: await budget(d.rings.nansen), ai: await budget(d.rings.ai ?? null) };
    checks.ai = d.ai.providers.map((p) => p.name);
    checks.gdelt = d.gdelt.available ? "ok" : "resting";
    const state = (available: boolean | undefined) => (available === undefined ? null : available ? "ok" : "resting");
    checks.feeds = {
      bluesky: state(d.feeds?.bluesky?.available),
      hn: state(d.feeds?.hn?.available),
      coingecko: state(d.feeds?.coingecko?.http.available),
      geckoterminal: state(d.feeds?.geckoterminal?.http.available),
      proxyFallback: d.feeds?.proxyFallback?.stats ?? null,
    };
    checks.jobs = ok ? await d.store.jobs() : [];
    return { ok, ...checks };
  };

  // Liveness for the platform's deploy check: the process serves (migrations ran before it
  // listens), without depending on the chain RPC.
  app.get("/live", (c) => c.json({ live: true }));

  // The bare origin names the service and where to look, instead of a 404 for anyone who opens it.
  app.get("/", (c) => c.json({ service: "Trendr API", live: true, health: "/health", status: "/v1/status", app: "https://app.trendr.bid" }));

  // Public: up or down, and how fresh the oracle is. The detail is behind admin sign-in.
  app.get("/health", async (c) => {
    const h = await healthDetail();
    const chain = h.chain as { chainId?: number; live?: number; lastRunId?: number } | string;
    return c.json(
      { ok: h.ok, db: h.db === "ok" ? "ok" : "down", chain: typeof chain === "string" ? "down" : { chainId: chain.chainId, live: chain.live, lastRunId: chain.lastRunId } },
      h.ok ? 200 : 503,
    );
  });

  // App reads.
  app.get("/v1/trends", async (c) => {
    const all = c.req.query("all") === "1";
    const [trends, meta] = await Promise.all([d.chain.trends(), d.store.trendMeta()]);
    const shown = trends.filter((t) => all || t.status === "Active" || t.status === "Cooling");
    const [latest, summaries] = await Promise.all([d.store.latest(shown.map((t) => baseOf(t.identifier))), d.history.summaries(shown.map((t) => t.id), Math.floor(now() / 1000))]);
    return c.json({
      lastRunId: Number(await d.chain.lastRunId()),
      trends: shown.map((t) => {
        const s = summaries.get(t.id);
        return { ...trendJson(t, meta.get(t.identifier) ?? meta.get(baseOf(t.identifier)), latest.get(baseOf(t.identifier))), change24h: s?.change ?? null, spark: s?.spark ?? [] };
      }),
    });
  });

  app.get("/v1/trends/:identifier", async (c) => {
    const id = c.req.param("identifier").toLowerCase();
    const all = await d.chain.trends();
    const trend = all.find((t) => t.identifier === id);
    if (!trend) return c.json({ error: "no such trend" }, 404);
    const meta = await d.store.trendMeta();
    const base = baseOf(id);
    const since = Math.floor(now() / 1000) - 7 * 86_400;
    const [latest, history, index] = await Promise.all([d.store.latest([base]), d.store.history(base, since), d.history.points(trend.id, since)]);
    // A retired listing whose topic listed again (base.2 to base.9) points to the newest live one.
    const relisted =
      trend.status === "Retired"
        ? all.filter((t) => t.identifier !== id && baseOf(t.identifier) === base && t.status !== "Retired").sort((a, b) => b.createdAt - a.createdAt)[0]
        : undefined;
    return c.json({ trend: trendJson(trend, meta.get(id) ?? meta.get(base), latest.get(base)), index, history, relistedAs: relisted?.identifier ?? null });
  });

  // History from the Envio indexer: track records, trade history, the trader leaderboard and trend stats.
  const fromIndexer = async (c: Context, read: (ix: IndexerReader) => Promise<unknown>) => {
    if (!d.indexer) return c.json({ error: "trade history is not available" }, 503);
    return c.json(await read(d.indexer));
  };
  app.get("/v1/accounts/:address", async (c) => {
    const address = c.req.param("address");
    if (!isAddress(address)) return c.json({ error: "bad address" }, 400);
    if (!d.indexer) return c.json({ error: "trade history is not available" }, 503);
    const account = await d.indexer.account(address);
    // ?optional=1: an account with no activity yet is an answer, not an error (the app asks this way).
    if (!account) return c.req.query("optional") === "1" ? c.json({ account: null }) : c.json({ error: "no activity yet" }, 404);
    return c.json({ account });
  });
  app.get("/v1/accounts/:address/activity", async (c) => {
    const address = c.req.param("address");
    if (!isAddress(address)) return c.json({ error: "bad address" }, 400);
    const limit = Math.min(Math.max(Number(c.req.query("limit") ?? 50) || 50, 1), 200);
    return fromIndexer(c, async (ix) => ({ items: await ix.activity(address, limit) }));
  });
  // Series the account holds outcome tokens of, old ones included; the app reads live balances on chain.
  app.get("/v1/accounts/:address/outcomes", async (c) => {
    const address = c.req.param("address");
    if (!isAddress(address)) return c.json({ error: "bad address" }, 400);
    return fromIndexer(c, async (ix) => ({ holdings: await ix.outcomeHoldings(address) }));
  });
  app.get("/v1/leaderboard/traders", (c) => fromIndexer(c, async (ix) => ({ traders: await ix.traders(50) })));
  app.get("/v1/trends/:identifier/stats", async (c) => {
    if (!d.indexer) return c.json({ error: "trade history is not available" }, 503);
    // A new listing has no trades yet: an empty answer, not an error (the app hides the strip).
    const stats = await d.indexer.trend(c.req.param("identifier"), Math.floor(now() / 1000));
    return c.json({ stats: stats ?? null });
  });

  app.get("/v1/candidates", async (c) => {
    const rows = await d.store.candidates("approved", 100);
    return c.json({ candidates: rows.map((r) => candidateJson(r, false)) });
  });

  // Link paste: a signed-in account proposes a trend and is its surfacer (the first surfacer of a
  // listed trend earns curation fees). Links always wait for a reviewer.
  app.post("/v1/links", rateLimit(6, 3_600_000, ipLimit, now), signedIn, async (c) => {
    const parsed = linkBody.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: parsed.error.issues[0]?.message ?? "bad request" }, 400);
    const surfacer = c.get("user").toLowerCase();
    if (parsed.data.surfacer && parsed.data.surfacer.toLowerCase() !== surfacer) return c.json({ error: "links are credited to the signed-in account" }, 403);
    if ((await d.store.recentLinkRequests(surfacer, 86_400)) >= LINKS_PER_ACCOUNT_PER_DAY) return c.json({ error: "daily link limit reached for this account" }, 429);
    if (d.rings.ai && (await d.rings.ai.leftToday()) <= Math.ceil(d.cfg.AI_DAILY_CALLS * (1 - LINK_AI_SHARE))) {
      return c.json({ error: "link proposals are paused for today; try again tomorrow" }, 429);
    }
    const requestId = await d.store.addLinkRequest(parsed.data.url, surfacer);
    try {
      const info = await resolveLink(parsed.data.url, d.fetchImpl);
      const { results } = await assess(
        d.ai,
        [{ kind: "link", url: info.url, platform: info.platform, title: info.title, author: info.author, text: info.text }],
        await d.store.knownIdentifiers(),
      );
      const a = results[0];
      if (!a) {
        await d.store.finishLinkRequest(requestId, "failed", null, "could not identify a topic");
        return c.json({ requestId, status: "failed", reason: "We could not tell what that link is about." }, 422);
      }
      const p = await d.radar.propose(a, "link", { url: info.url, platform: info.platform, title: info.title }, surfacer);
      await d.store.finishLinkRequest(requestId, p.status === "rejected" ? "rejected" : "proposed", p.id, p.reason);
      return c.json({ requestId, status: p.status, identifier: p.identifier, displayName: a.displayName, summary: a.summary, reason: p.reason, firstSurfacer: p.created });
    } catch (e) {
      const reason = e instanceof LinkError ? e.message : "the link could not be processed";
      await d.store.finishLinkRequest(requestId, "failed", null, reason);
      if (!(e instanceof LinkError)) d.log.warn({ err: e instanceof Error ? e.message : String(e) }, "link request failed");
      return c.json({ requestId, status: "failed", reason }, e instanceof LinkError ? 422 : 502);
    }
  });

  // The CRE workflow's reads.
  const oracle = new Hono();
  oracle.use("*", bearer(d.cfg.ORACLE_TOKEN));
  // The queue in priority order (see queue.ts): only candidates with a reading the workflow still
  // accepts, and crypto only once smart money confirms it, so the workflow's turns go to
  // candidates that can become trends.
  oracle.get("/candidates", async (c) => {
    const approved = await d.store.candidates("approved", 200);
    const latest = await d.store.latest(approved.map((a) => a.identifier));
    const tradable = new Set((await d.autopilot.service.markets().catch(() => [])).map((m) => m.symbol.toUpperCase()));
    const ranked = rankQueue(approved, latest, { nowSec: Math.floor(now() / 1000), confirmNetflowUsd: d.cfg.CRYPTO_CONFIRM_NETFLOW_USD, tradable });
    return c.json({ candidates: ranked.map((a) => ({ identifier: a.identifier, keywords: a.keywords.slice(0, 5), surfacer: a.surfacer })) });
  });
  oracle.get("/measurements", async (c) => {
    const tracked = await d.collector.tracked();
    const asked = (c.req.query("ids") ?? "").split(",").map((s) => baseOf(s.trim().toLowerCase())).filter(Boolean);
    const wanted = asked.length > 0 ? new Set(asked) : null;
    const rows = tracked.filter((t) => !wanted || wanted.has(t.identifier));
    const latest = await d.store.latest(rows.map((t) => t.identifier));
    return c.json({
      observedAt: Math.floor(now() / 1000),
      trends: Object.fromEntries(
        rows.map((t) => [t.identifier, { keywords: t.keywords, article: t.article, ticker: t.ticker, readings: readings(latest.get(t.identifier)) }]),
      ),
    });
  });
  app.route("/v1/oracle", oracle);

  // Sign-ins, before the routes that check them: the app's account sessions, the vault identity,
  // and every admin request signed by a wallet (bearer tokens skip it; they cost no chain read).
  const signInLimit = rateLimit(SIGN_INS_PER_WINDOW, SIGN_IN_WINDOW_MS, (c) => `sign-in:${ipLimit(c)}`, now);
  app.use("/v1/auth/session", signInLimit);
  app.use("/v1/identity/session", signInLimit);
  const adminSignedLimit = rateLimit<{ Variables: { admin: string; token: string | null } }>(SIGN_INS_PER_WINDOW, SIGN_IN_WINDOW_MS, (c) => `admin-signed:${ipLimit(c)}`, now);

  // Admin, signed by an allowlisted wallet.
  const admin = new Hono<{ Variables: { admin: string; token: string | null } }>();
  admin.use("*", (c, next) => (/^Bearer\s/i.test(c.req.header("authorization") ?? "") ? next() : adminSignedLimit(c, next)));
  admin.use("*", adminAuth(d.chain.client, d.cfg.ADMIN_ADDRESSES, d.adminSessionSecret, (h) => d.store.isRevoked(h), now));
  admin.get("/health", async (c) => {
    const h = await healthDetail();
    return c.json(h, h.ok ? 200 : 503);
  });
  // Each service's own health in detail: its wallets, alerts and, for the top-up service, the treasury.
  admin.get("/services", async (c) => c.json({ services: await serviceDetails(parseServices(d.cfg.STATUS_SERVICES)) }));
  // Everything at once for the system view: services, chain and indexer, oracle, Elfa keys, sources,
  // RPC providers, wallets and recent errors, with what is wrong ranked first. It spends no credits.
  admin.get("/system", async (c) => {
    if (!d.system) return c.json({ error: "the system view is not configured" }, 404);
    return c.json(await d.system.report());
  });
  // Checks every Elfa key's status (one credit each) in the background, one key at a time; the
  // system report shows each result as it lands. One check at a time, and a minute after the last.
  let elfaCheckAt = 0;
  let elfaChecking = false;
  admin.post("/system/elfa-check", async (c) => {
    const system = d.system;
    const check = d.elfaCheck;
    if (!system || !check) return c.json({ error: "no Elfa keys are configured" }, 404);
    if (elfaChecking) return c.json({ error: "a key check is already running" }, 429, { "Retry-After": "30" });
    const wait = elfaCheckAt + ELFA_CHECK_INTERVAL_MS - now();
    if (wait > 0) return c.json({ error: "keys were checked moments ago; try again in a minute" }, 429, { "Retry-After": String(Math.max(1, Math.ceil(wait / 1000))) });
    elfaChecking = true;
    let latest: readonly KeyCheck[] = [];
    system.noteKeyCheck([], { running: true });
    void check((done) => {
      latest = done;
      system.noteKeyCheck([...done], { running: true });
    })
      .then((all) => system.noteKeyCheck(all, { running: false }))
      .catch((e: Error) => {
        d.log.warn({ err: e.message }, "elfa key check failed");
        system.noteKeyCheck([...latest], { running: false });
      })
      .finally(() => {
        elfaChecking = false;
        elfaCheckAt = now();
      });
    d.log.info({ by: c.get("admin") }, "elfa key check started from the admin panel");
    const report = await system.report(0);
    return c.json({ check: report.elfa.lastCheck }, 202);
  });
  // Signs the session token out everywhere, not just in the tab that holds it.
  admin.post("/session/revoke", async (c) => {
    const token = c.get("token");
    if (!token) return c.json({ error: "sign out applies to session tokens" }, 400);
    const [payload] = token.split(".");
    const expiry = Number(Buffer.from(payload ?? "", "base64url").toString().split(".")[2] ?? 0);
    await d.store.revoke(tokenHash(token), expiry);
    return c.json({ ok: true });
  });
  // Exchanges one signed request for a bearer token, so the admin UI asks the wallet once. Only a
  // freshly signed request mints one: a bearer token cannot renew itself past its expiry or sign-out.
  admin.post("/session", (c) => {
    if (c.get("token") !== null) return c.json({ error: "sign this request with the admin wallet" }, 403);
    const expiresAt = Math.floor(now() / 1000) + ADMIN_SESSION_SEC;
    return c.json({ token: issueSession(d.adminSessionSecret, c.get("admin"), expiresAt), address: c.get("admin"), expiresAt });
  });
  admin.get("/candidates", async (c) => {
    const status = c.req.query("status");
    const valid: CandidateStatus[] = ["pending", "approved", "rejected", "live", "retired"];
    const rows = await d.store.candidates(valid.includes(status as CandidateStatus) ? (status as CandidateStatus) : null, 300);
    return c.json({ candidates: rows.map((r) => candidateJson(r, true)) });
  });
  admin.post("/candidates/:id/decision", async (c) => {
    const id = Number(c.req.param("id"));
    const parsed = decisionBody.safeParse(await c.req.json().catch(() => null));
    if (!Number.isInteger(id) || !parsed.success) return c.json({ error: parsed.success ? "bad id" : (parsed.error.issues[0]?.message ?? "bad request") }, 400);
    const b = parsed.data;
    if (b.identifier && b.identifier !== baseOf(b.identifier)) return c.json({ error: "use the base identifier; versions are assigned on listing" }, 400);
    const row = await d.store
      .decide(id, b.decision === "approve" ? "approved" : "rejected", c.get("admin"), {
        identifier: b.identifier,
        displayName: b.displayName,
        keywords: b.keywords,
        article: b.article,
        summary: b.summary,
      })
      .catch((e: Error) => {
        if (/unique/i.test(e.message)) return "duplicate" as const;
        throw e;
      });
    if (row === "duplicate") return c.json({ error: "another candidate already uses that identifier" }, 409);
    if (!row) return c.json({ error: "no such candidate, or it is already live" }, 404);
    d.log.info({ id, decision: b.decision, by: c.get("admin") }, "candidate decided");
    return c.json({ candidate: candidateJson(row, true) });
  });
  // Runs take a minute or more, so they start in the background; /health shows the outcome.
  admin.post("/jobs/:name/run", (c) => {
    const name = c.req.param("name");
    if (name !== "radar" && name !== "collector" && name !== "history") return c.json({ error: "no such job" }, 404);
    return c.json({ started: d.jobs.trigger(name) }, 202);
  });
  const autopilotDeps = {
    isRevoked: (h: string) => d.store.isRevoked(h),
    revoke: (h: string, expiresAt: number) => d.store.revoke(h, expiresAt),
    store: d.autopilot.store,
    service: d.autopilot.service,
    client: d.chain.client,
    keys,
    approvals,
    sessionSecret: d.adminSessionSecret,
    sealPublicKey: d.cfg.AUTOPILOT_SEAL_PUBLIC_KEY,
    perplExchange: d.cfg.deployment.perplExchange,
    perplOrderGuard: d.cfg.deployment.perplOrderGuard,
    sessionMaxLeverage: perplSessionMaxLeverage(d.cfg.deployment),
    botAddress: d.cfg.AUTOPILOT_BOT_ADDRESS as `0x${string}` | undefined,
    log: d.log,
    now,
  };
  admin.route("/", autopilotAdminRoutes(autopilotDeps));
  admin.route("/", moderationRoutes({ sql: d.store.sql }));
  admin.route("/", waitlistAdminRoutes({ sql: d.store.sql }));
  app.route("/v1/admin", admin);
  app.route("/v1", autopilotRoutes(autopilotDeps));
  if (d.aurora) {
    app.route(
      "/v1",
      depositRoutes({ sql: d.store.sql, aurora: d.aurora, live: d.cfg.CHAIN_ID === 143, sessionSecret: d.adminSessionSecret, isRevoked: (h) => d.store.isRevoked(h), keys, trustedProxyHops: d.cfg.TRUSTED_PROXY_HOPS, log: d.log, now }),
    );
  }
  app.route("/v1", socialRoutes({ sql: d.store.sql, chain: d.chain, approvals, sessionSecret: d.adminSessionSecret, isRevoked: (h) => d.store.isRevoked(h), now }));
  app.route("/v1", ownerApprovalRoutes(approvals, signedIn, now));
  // Sign-up: the relayer pays for an activation only with this API's ticket.
  app.route("/v1", activationTicketRoutes(d.tickets ?? null, d.cfg.TRUSTED_PROXY_HOPS, now));
  // The Mainnet waitlist, from the app and the website. Client addresses are stored as keyed hashes.
  app.route("/v1", waitlistRoutes({ sql: d.store.sql, trustedProxyHops: d.cfg.TRUSTED_PROXY_HOPS, ipSecret: d.adminSessionSecret, now }));

  // Web Push subscriptions for the signed-in account's devices.
  const subscription = z.object({
    endpoint: z.string().max(1000).refine(isPushEndpoint, "push endpoints must be a browser push service (https)"),
    keys: z.object({ p256dh: z.string().min(40).max(200), auth: z.string().min(10).max(100) }),
    topics: z.array(z.enum(TOPICS as [Topic, ...Topic[]])).min(1).default([...TOPICS]),
  });
  app.get("/v1/push/vapid", (c) => (d.push.vapid ? c.json({ publicKey: d.push.vapid.publicKey }) : c.json({ error: "push is not configured" }, 503)));
  app.post("/v1/push/subscriptions", signedIn, async (c) => {
    const b = subscription.safeParse(await c.req.json().catch(() => null));
    if (!b.success) return c.json({ error: b.error.issues[0]?.message ?? "bad subscription" }, 400);
    const stored = await d.push.subscribe(c.get("user"), { endpoint: b.data.endpoint, p256dh: b.data.keys.p256dh, auth: b.data.keys.auth, topics: b.data.topics });
    if (!stored) return c.json({ error: "another account receives notifications on this browser; it must turn them off first" }, 409);
    return c.json({ ok: true }, 201);
  });
  app.delete("/v1/push/subscriptions", signedIn, async (c) => {
    const b = z.object({ endpoint: z.string() }).safeParse(await c.req.json().catch(() => null));
    if (!b.success) return c.json({ error: "endpoint required" }, 400);
    await d.push.unsubscribe(c.get("user"), b.data.endpoint);
    return c.json({ ok: true });
  });

  // Testnet AUSD for beta testers, once a day per signed-in account.
  app.get("/v1/faucet", (c) => c.json({ available: d.faucet !== null, amount: d.faucet?.amount.toString() ?? null }));
  app.post("/v1/faucet", rateLimit(10, 3_600_000, ipLimit, now), signedIn, async (c) => {
    if (!d.faucet) return c.json({ error: "the faucet runs on Testnet only" }, 404);
    try {
      return c.json(await d.faucet.drip(c.get("user") as `0x${string}`));
    } catch (e) {
      if (e instanceof FaucetError) return c.json({ error: e.message }, e.status);
      throw e;
    }
  });

  // Public status: every service, the oracle and the chain head, as up or down. Cached briefly.
  let statusCache: { at: number; body: Awaited<ReturnType<typeof status>> } | null = null;
  app.get("/v1/status", async (c) => {
    if (!statusCache || now() - statusCache.at > 10_000) {
      statusCache = { at: now(), body: await status(d.chain, parseServices(d.cfg.STATUS_SERVICES), { oracleStaleSec: d.cfg.ORACLE_STALE_SEC }, Math.floor(now() / 1000)) };
    }
    return c.json(statusCache.body, statusCache.body.ok ? 200 : 503);
  });

  return app;
}
