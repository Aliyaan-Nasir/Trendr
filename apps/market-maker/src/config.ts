import { urlList } from "@trendr/chain";
import { type Deployment, deployments } from "@trendr/contracts";
import { z } from "zod";

const key = z.string().regex(/^0x[0-9a-fA-F]{64}$/, "expected a 0x-prefixed 32-byte private key");
const list = (v: string) => v.split(",").map((s) => s.trim()).filter(Boolean);
const optional = <T extends z.ZodType>(inner: T) => z.preprocess((v) => (v === "" ? undefined : v), inner.optional());
const price = z.coerce.number().positive().max(0.5);

const schema = z.object({
  RPC_URL: z.string().url(),
  /** Endpoints to load-balance across, comma-separated; RPC_URL alone when unset. */
  RPC_URLS: optional(z.string()),
  WS_URL: optional(z.string().url()),
  /** WebSocket endpoints to rotate through on reconnect, comma-separated; WS_URL alone when unset. */
  WS_URLS: optional(z.string()),
  CHAIN_ID: z.coerce.number().int().positive(),
  /** Requests per second to RPC_URL; the public Monad RPC allows 15 per IP across every process. */
  RPC_MAX_RPS: z.coerce.number().positive().default(10),
  MM_PRIVATE_KEY: key,
  PORT: z.coerce.number().int().positive().default(4300),
  LOG_LEVEL: z.string().default("info"),
  /** Series windows to quote. */
  QUOTE_WINDOWS: z.string().default("86400,604800").transform((v) => list(v).map(Number)),
  /** Complete sets (AUSD) minted per quoted series as ask inventory. */
  SETS_PER_SERIES: z.coerce.number().positive().default(100),
  /** AUSD kept in Kuru's MarginAccount to back bids across all series. */
  MARGIN_AUSD: z.coerce.number().nonnegative().default(1500),
  HALF_SPREAD: price.default(0.03),
  LEVEL_STEP: price.default(0.01),
  LEVELS: z.coerce.number().int().min(1).max(5).default(2),
  LEVEL_TOKENS: z.coerce.number().positive().default(20),
  MAX_SKEW: price.default(0.03),
  INVENTORY_LIMIT: z.coerce.number().positive().default(60),
  /** Re-quote when a level drifts this many 0.001 ticks; each re-quote is a transaction. */
  REQUOTE_TICKS: z.coerce.number().int().positive().default(20),
  /** Stop quoting this close to expiry, when the index is close to final. */
  STOP_BEFORE_EXPIRY_SEC: z.coerce.number().int().nonnegative().default(300),
  ARB_MIN_EDGE: z.coerce.number().positive().default(0.005),
  ARB_MAX_TOKENS: z.coerce.number().positive().default(200),
  QUOTE_EVERY_BLOCKS: z.coerce.number().int().positive().default(25),
  POLL_MS: z.coerce.number().int().positive().default(2000),
  /** MON the key must hold to keep quoting; below it /health turns red. */
  MIN_BALANCE_MON: z.coerce.number().nonnegative().default(0.5),
  /** Most series quoted at once (24-hour windows first, then by attention); every re-quote costs gas. */
  MAX_SERIES: z.coerce.number().int().positive().default(12),
  /** Least seconds between drift-only re-quotes of one market; fills and large moves re-quote at once. */
  MIN_REQUOTE_SEC: z.coerce.number().int().nonnegative().default(300),
  /** Any value but empty stops all quoting and pulls every order. */
  KILL_SWITCH: optional(z.string()),
  /** The same, by creating this file. */
  KILL_SWITCH_FILE: optional(z.string()),
  STATE_FILE: z.string().default(".mm-state.json"),
  ALERT_WEBHOOK_URL: optional(z.string().url()),
  DEPLOYMENT_JSON: optional(z.string()),
});

export type MarketMakerConfig = z.infer<typeof schema> & { deployment: Deployment; rpcUrls: string[]; wsUrls: string[] };

export function loadConfig(env: Record<string, string | undefined>, override?: Deployment): MarketMakerConfig {
  const parsed = schema.parse(env);
  const deployment =
    override ?? (parsed.DEPLOYMENT_JSON ? (JSON.parse(parsed.DEPLOYMENT_JSON) as Deployment) : deployments[parsed.CHAIN_ID]);
  if (!deployment) throw new Error(`no deployment for chain ${parsed.CHAIN_ID}`);
  if (parsed.LEVEL_TOKENS < 1) throw new Error("LEVEL_TOKENS must be at least one token, Kuru's minimum order");
  const rpcUrls = urlList(parsed.RPC_URLS).length > 0 ? urlList(parsed.RPC_URLS) : [parsed.RPC_URL];
  const wsUrls = urlList(parsed.WS_URLS).length > 0 ? urlList(parsed.WS_URLS) : parsed.WS_URL ? [parsed.WS_URL] : [];
  return { ...parsed, deployment, rpcUrls, wsUrls };
}
