import { urlList } from "@trendr/chain";
import { type Deployment, deployments } from "@trendr/contracts";
import { z } from "zod";

const key = z.string().regex(/^0x[0-9a-fA-F]{64}$/, "expected a 0x-prefixed 32-byte private key");
const list = (v: string) => v.split(",").map((s) => s.trim()).filter(Boolean);
/** An optional setting left empty in an env file counts as unset. */
const optional = <T extends z.ZodType>(inner: T) => z.preprocess((v) => (v === "" ? undefined : v), inner.optional());

const schema = z.object({
  RPC_URL: z.string().url(),
  /** Endpoints to load-balance across, comma-separated; RPC_URL alone when unset. */
  RPC_URLS: optional(z.string()),
  /** monadNewHeads and monadLogs; without it the keeper polls over RPC_URL. */
  WS_URL: optional(z.string().url()),
  /** WebSocket endpoints to rotate through on reconnect, comma-separated; WS_URL alone when unset. */
  WS_URLS: optional(z.string()),
  CHAIN_ID: z.coerce.number().int().positive(),
  /** Requests per second to RPC_URL; the public Monad RPC allows 15 per IP across every process. */
  RPC_MAX_RPS: z.coerce.number().positive().default(10),
  KEEPER_PRIVATE_KEY: key,
  PORT: z.coerce.number().int().positive().default(4200),
  LOG_LEVEL: z.string().default("info"),
  /** Windows (seconds) to keep a series open in; each must be one OutcomeMarkets offers. */
  SERIES_WINDOWS: z.string().default("86400,604800").transform((v) => list(v).map(Number)),
  /** Windows whose series get Kuru markets. Listing costs two market deployments per series. */
  LIST_WINDOWS: z.string().default("86400,604800").transform((v) => list(v).map(Number)),
  /** Full rescan cadence in blocks, on top of rescans triggered by protocol events. */
  SCAN_EVERY_BLOCKS: z.coerce.number().int().positive().default(25),
  /** Polling interval when no WebSocket is configured or it is down. */
  POLL_MS: z.coerce.number().int().positive().default(2000),
  MAX_ACTIONS_PER_SCAN: z.coerce.number().int().positive().default(12),
  /** Alert when no head arrives for this long. */
  HEAD_LAG_ALERT_SEC: z.coerce.number().int().positive().default(30),
  /** Slack or Discord compatible webhook for alerts; alerts are always logged. */
  ALERT_WEBHOOK_URL: optional(z.string().url()),
  /** Deployment JSON for chains not in @trendr/contracts (a local Anvil chain). */
  DEPLOYMENT_JSON: optional(z.string()),
});

export type KeeperConfig = z.infer<typeof schema> & { deployment: Deployment; rpcUrls: string[]; wsUrls: string[] };

export function loadConfig(env: Record<string, string | undefined>, override?: Deployment): KeeperConfig {
  const parsed = schema.parse(env);
  const deployment =
    override ?? (parsed.DEPLOYMENT_JSON ? (JSON.parse(parsed.DEPLOYMENT_JSON) as Deployment) : deployments[parsed.CHAIN_ID]);
  if (!deployment) throw new Error(`no deployment for chain ${parsed.CHAIN_ID}`);
  if (!deployment.outcomeListing) throw new Error("the deployment has no OutcomeListing");
  for (const w of parsed.LIST_WINDOWS) {
    if (!parsed.SERIES_WINDOWS.includes(w)) throw new Error(`LIST_WINDOWS has ${w}, which is not in SERIES_WINDOWS`);
  }
  const rpcUrls = urlList(parsed.RPC_URLS).length > 0 ? urlList(parsed.RPC_URLS) : [parsed.RPC_URL];
  const wsUrls = urlList(parsed.WS_URLS).length > 0 ? urlList(parsed.WS_URLS) : parsed.WS_URL ? [parsed.WS_URL] : [];
  return { ...parsed, deployment, rpcUrls, wsUrls };
}
