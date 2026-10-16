import { urlList } from "@trendr/chain";
import { type Deployment, deployments } from "@trendr/contracts";
import { z } from "zod";
import { parseServices, type ServiceProbe } from "./status";

const list = (v: string | undefined) => (v ?? "").split(",").map((s) => s.trim()).filter(Boolean);
/** An optional setting left empty in an env file counts as unset. */
const optional = <T extends z.ZodType>(inner: T) => z.preprocess((v) => (v === "" ? undefined : v), inner.optional());
const address = z.string().regex(/^0x[0-9a-fA-F]{40}$/);

const schema = z.object({
  PORT: z.coerce.number().int().positive().default(4000),
  LOG_LEVEL: z.string().default("info"),
  DATABASE_URL: z.string().min(1),
  /** The Envio indexer's database (it may be the same one) and schema; history endpoints are off without it. */
  INDEXER_DATABASE_URL: z.preprocess((v) => (v === "" ? undefined : v), z.string().min(1).optional()),
  INDEXER_SCHEMA: z.string().regex(/^[a-z_][a-z0-9_]*$/).default("indexer"),
  /** Aurora Intents API key for any-chain deposits; deposit quotes are off without it. */
  AURORA_API_KEY: z.preprocess((v) => (v === "" ? undefined : v), z.string().min(1).optional()),
  /** Comma-separated app origins allowed by CORS. */
  FRONTEND_URL: z.string().default("http://localhost:3000"),
  /** Comma-separated website origins allowed by CORS, for the waitlist form only. */
  LANDING_URL: z.string().default("http://localhost:3004"),
  /**
   * Proxies in front of the backend that append to X-Forwarded-For (Railway: 1). 0 trusts no
   * header and rate limits by the socket address; n takes the entry n positions from the right.
   */
  TRUSTED_PROXY_HOPS: z.coerce.number().int().min(0).max(10).default(0),

  CHAIN_ID: z.coerce.number().int().positive().default(10143),
  MONAD_RPC_URL: optional(z.string().url()),
  MONAD_RPC_URLS: optional(z.string()),
  DEPLOYMENT_JSON: optional(z.string()),

  /** Bearer token the CRE workflow sends for candidates and measurements. */
  ORACLE_TOKEN: z.string().min(16),
  /** Signs admin session tokens; a random one per start when unset (sessions end on restart). */
  ADMIN_SESSION_SECRET: optional(z.string().min(32)),
  /** Wallets allowed to use the admin API (signed requests), comma-separated. */
  ADMIN_ADDRESSES: z.string().default("").transform((v) => list(v).map((a) => a.toLowerCase())),

  ELFA_API_KEYS: z.string().default("").transform(list),
  ELFA_API_BASE: z.string().url().default("https://api.elfa.ai"),
  /** Elfa credit budgets; the monthly budget is paced across the days left. */
  ELFA_DAILY_CREDITS_PER_KEY: z.coerce.number().int().positive().default(100),
  ELFA_MONTHLY_CREDITS_PER_KEY: z.coerce.number().int().positive().default(950),
  /** Read usage from Elfa on start (one credit each) so budgets match Elfa's count. */
  ELFA_SYNC_USAGE: z.enum(["on", "off"]).default("off"),
  /** Elfa calls go out one at a time; after each, the next waits a random gap between these bounds. */
  ELFA_MIN_GAP_SEC: z.coerce.number().min(0).default(20),
  ELFA_MAX_GAP_SEC: z.coerce.number().min(0).default(90),
  /** A key rests about this long (plus or minus 30%) between its own uses. */
  ELFA_KEY_MIN_GAP_SEC: z.coerce.number().min(0).default(600),
  /** A key check goes one key at a time, a random gap between these bounds apart. */
  ELFA_CHECK_GAP_MIN_SEC: z.coerce.number().min(0).default(30),
  ELFA_CHECK_GAP_MAX_SEC: z.coerce.number().min(0).default(90),
  /** Each key's daily credits open hour by hour, with this many credits of slack. */
  ELFA_HOURLY_SLACK: z.coerce.number().int().min(0).default(2),
  ELFA_PROXIES: z.string().default("").transform(list),
  PROXY_FALLBACK_MB_PER_MONTH: z.coerce.number().int().min(0).max(800).default(300),

  NANSEN_API_KEYS: z.string().default("").transform(list),
  NANSEN_API_BASE: z.string().url().default("https://api.nansen.ai"),
  /** Nansen's free plan tops up to 10 credits a day; a netflow call costs 5. */
  NANSEN_DAILY_CREDITS_PER_KEY: z.coerce.number().int().positive().default(10),
  NANSEN_CHAINS: z.string().default("all").transform(list),

  /** Wikimedia asks every client to identify itself. */
  WIKIMEDIA_USER_AGENT: z.string().default("TrendrAttentionIndex/1.0 (attention markets on Monad)"),

  GEMINI_API_KEY: optional(z.string()),
  GEMINI_MODEL: z.string().default("gemini-flash-latest"),
  GEMINI_FALLBACK_MODEL: z.string().default("gemini-flash-lite-latest"),
  OPENAI_API_KEY: optional(z.string()),
  OPENAI_MODEL: z.string().default("gpt-5.4-mini"),
  KIMI_API_KEY: optional(z.string()),
  KIMI_MODEL: z.string().default("kimi-k2.6"),
  KIMI_API_BASE: z.string().url().default("https://api.moonshot.ai/v1"),
  /** AI provider requests per UTC day, shared by the radar and pasted links (links may use half). */
  AI_DAILY_CALLS: z.coerce.number().int().positive().default(400),

  /** Radar cadence: Elfa trending tokens every run, narratives (5 credits) every NARRATIVES_EVERY runs. */
  RADAR_INTERVAL_SEC: z.coerce.number().int().positive().default(7200),
  NARRATIVES_EVERY: z.coerce.number().int().positive().default(6),
  /** Radar runs between Elfa trending-token calls (1 credit each); raise it when one free key must also feed the collector. */
  ELFA_TOKENS_EVERY: z.coerce.number().int().positive().default(1),
  /** AI confidence (0 to 1) at or above which a policy-clean candidate is approved without review. */
  AUTO_APPROVE_CONFIDENCE: z.coerce.number().min(0).max(1).default(0.8),
  /** Collector cadence and the shortest refresh per source for each tracked trend. */
  COLLECT_INTERVAL_SEC: z.coerce.number().int().positive().default(60),
  ELFA_REFRESH_SEC: z.coerce.number().int().positive().default(7200),
  GDELT_REFRESH_SEC: z.coerce.number().int().positive().default(1800),
  /** Candidates (not yet listed) refresh GDELT less often than live trends, within the workflow's 2 h age limit. */
  GDELT_CANDIDATE_REFRESH_SEC: z.coerce.number().int().positive().default(3600),
  NANSEN_REFRESH_SEC: z.coerce.number().int().positive().default(14400),
  WIKIPEDIA_REFRESH_SEC: z.coerce.number().int().positive().default(21600),
  /** Keyless sources: Bluesky mentions (one search per trend) and Hacker News mentions (up to three per trend). */
  BLUESKY_REFRESH_SEC: z.coerce.number().int().positive().default(1800),
  HN_REFRESH_SEC: z.coerce.number().int().positive().default(3600),
  /** The Autopilot executor's public key (base64url, P-256 raw): grants are sealed to it. */
  AUTOPILOT_SEAL_PUBLIC_KEY: optional(z.string().min(80)),
  /** The Trendr bot wallet whose rules trade through Perpl's API. */
  AUTOPILOT_BOT_ADDRESS: optional(address.transform((a) => a.toLowerCase())),
  /** Backtest costs: Perpl's tier-1 taker fee and a slippage allowance, basis points per fill. */
  PERPL_TAKER_FEE_BPS: z.coerce.number().nonnegative().default(4),
  BACKTEST_SLIPPAGE_BPS: z.coerce.number().nonnegative().default(5),
  HISTORY_INTERVAL_SEC: z.coerce.number().int().positive().default(60),
  /** Smart-money inflow (USD, 24h) a crypto candidate needs before it is offered to the workflow; keep equal to the workflow's minConfirmNetflowUsd. */
  CRYPTO_CONFIRM_NETFLOW_USD: z.coerce.number().nonnegative().default(100_000),
  /** Live slots: the workflow's `discovery.maxLiveTrends` (a test keeps them equal). */
  MAX_LIVE_TRENDS: z.coerce.number().int().positive().default(20),
  /** Rotation (rotation.ts): a full board swaps a faded trend for a stronger approved candidate. */
  ROTATION: z.enum(["on", "off"]).default("on"),
  ROTATION_MIN_AGE_SEC: z.coerce.number().int().positive().default(36 * 3600),
  ROTATION_FADE_RATIO: z.coerce.number().gt(0).lt(1).default(0.6),
  ROTATION_TIMEOUT_SEC: z.coerce.number().int().positive().default(6 * 3600),
  ROTATION_LIST_GRACE_SEC: z.coerce.number().int().positive().default(20 * 60),
  // The registry's staleRetireWindow (2 h on Testnet).
  ROTATION_STALE_WINDOW_SEC: z.coerce.number().int().positive().default(2 * 3600),
  ROTATION_COOLDOWN_SEC: z.coerce.number().int().nonnegative().default(3600),
  /** Web Push (VAPID). Generate with: bunx web-push generate-vapid-keys. Subject: a mailto: or https: contact. */
  VAPID_PUBLIC_KEY: optional(z.string().min(80)),
  VAPID_PRIVATE_KEY: optional(z.string().min(40)),
  VAPID_SUBJECT: optional(z.string().regex(/^(mailto:|https:\/\/)/)),
  /** Testnet only: the wallet that drips test AUSD to beta testers, and how much (raw, 6 decimals). */
  FAUCET_PRIVATE_KEY: optional(z.string().regex(/^0x[0-9a-fA-F]{64}$/)),
  FAUCET_AMOUNT: z.coerce.bigint().default(100_000_000n),
  /** Drips the faucet pays in any 24 hours, across all accounts. */
  FAUCET_DAILY_CAP: z.coerce.number().int().positive().default(200),
  /**
   * Signs the activation tickets the relayer requires (its ACTIVATION_TICKET_SIGNER is this key's
   * address). Without it the API issues none.
   */
  ACTIVATION_TICKET_KEY: optional(z.string().regex(/^0x[0-9a-fA-F]{64}$/)),
  /** Sign-up caps: tickets per client address per hour and per day, and for everyone per hour and per day. */
  ACTIVATION_TICKETS_PER_IP_PER_HOUR: z.coerce.number().int().positive().default(3),
  ACTIVATION_TICKETS_PER_IP_PER_DAY: z.coerce.number().int().positive().default(10),
  ACTIVATION_TICKETS_PER_HOUR: z.coerce.number().int().positive().default(30),
  ACTIVATION_TICKETS_PER_DAY: z.coerce.number().int().positive().default(150),
  /**
   * Services the public status view checks: name=url pairs, comma-separated. Each may carry
   * |-separated flags for the admin system view: `optional` (its outage is a warning, not
   * critical) and `staleMin=<minutes>` (stalled after that long without work).
   */
  STATUS_SERVICES: z.string().default(""),
  /** Services only the admin system view checks, on top of STATUS_SERVICES (internal ones the public view must not name), with the same flags. */
  ADMIN_SERVICES: z.string().default(""),
  /** The oracle counts as stale after this long without a run or a trend update. */
  ORACLE_STALE_SEC: z.coerce.number().int().positive().default(600),
  /** Turn the background loops off (tests, one-off scripts). */
  BACKGROUND: z.enum(["on", "off"]).default("on"),
});

export type Config = z.infer<typeof schema> & {
  deployment: Deployment;
  rpcUrls: string[];
  frontendOrigins: string[];
  landingOrigins: string[];
  /** What the admin system view probes: STATUS_SERVICES, then ADMIN_SERVICES, the first entry of each name winning. */
  systemServices: ServiceProbe[];
};

export const GLOBAL_PROXY_VARS = ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy"] as const;

export function loadConfig(env: Record<string, string | undefined>): Config {
  const global = GLOBAL_PROXY_VARS.filter((v) => (env[v] ?? "").trim() !== "");
  if (global.length > 0) throw new Error(`${global.join(", ")} must be unset: proxies serve Elfa only, set per key in ELFA_PROXIES`);
  const parsed = schema.parse(env);
  if (parsed.ELFA_PROXIES.length > 0 && new URL(parsed.ELFA_API_BASE).hostname !== "api.elfa.ai") {
    throw new Error("ELFA_PROXIES carry requests to api.elfa.ai only; ELFA_API_BASE must point there");
  }
  const deployment = parsed.DEPLOYMENT_JSON ? (JSON.parse(parsed.DEPLOYMENT_JSON) as Deployment) : deployments[parsed.CHAIN_ID];
  if (!deployment) throw new Error(`no deployment for chain ${parsed.CHAIN_ID}`);
  const rpcUrls = urlList(parsed.MONAD_RPC_URLS).length > 0 ? urlList(parsed.MONAD_RPC_URLS) : parsed.MONAD_RPC_URL ? [parsed.MONAD_RPC_URL] : [];
  if (rpcUrls.length === 0) throw new Error("MONAD_RPC_URLS or MONAD_RPC_URL is required");
  for (const a of parsed.ADMIN_ADDRESSES) address.parse(a);
  const systemServices = [...parseServices(parsed.STATUS_SERVICES), ...parseServices(parsed.ADMIN_SERVICES)].filter((s, i, all) => all.findIndex((x) => x.name === s.name) === i);
  return { ...parsed, deployment, rpcUrls, frontendOrigins: list(parsed.FRONTEND_URL), landingOrigins: list(parsed.LANDING_URL), systemServices };
}
