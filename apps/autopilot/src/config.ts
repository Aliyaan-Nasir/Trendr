import { urlList } from "@trendr/chain";
import { type Deployment, deployments } from "@trendr/contracts";
import { z } from "zod";

const optional = <T extends z.ZodType>(inner: T) => z.preprocess((v) => (v === "" ? undefined : v), inner.optional());
const address = z.string().regex(/^0x[0-9a-fA-F]{40}$/);

const schema = z.object({
  DATABASE_URL: z.string().min(1),
  CHAIN_ID: z.coerce.number().int().positive().default(10143),
  RPC_URLS: z.string().min(1),
  /** The relayer that pays gas for accounts' session batches. */
  RELAYER_URL: z.string().url(),
  /** Opens the grants the app sealed to this executor (base64url PKCS#8 P-256). Without it, only the bot trades. */
  AUTOPILOT_SEAL_PRIVATE_KEY: optional(z.string().min(100)),
  /** The Trendr bot: its wallet, and the Perpl API key it trades through. */
  AUTOPILOT_BOT_ADDRESS: optional(address),
  /** api: Perpl's signed API (the default); chain: the bot wallet calls the Exchange itself. */
  BOT_VENUE: z.enum(["api", "chain"]).default("api"),
  /** The bot wallet's key, for the chain venue. */
  AUTOPILOT_BOT_PRIVATE_KEY: optional(z.string().regex(/^0x[0-9a-fA-F]{64}$/)),
  PERPL_API_TOKEN: optional(z.string().min(8)),
  /** Ed25519 seed, 32 bytes hex. */
  PERPL_API_SECRET_KEY: optional(z.string().regex(/^(0x)?[0-9a-fA-F]{64}$/)),
  TICK_SEC: z.coerce.number().int().min(5).default(15),
  /**
   * Worst fill accepted on market orders, basis points from the mark. At most 1%: an account's
   * order guard refuses session orders more than 2% from Perpl's mark, and the mark moves between
   * the tick reading it and the order landing.
   */
  SLIPPAGE_BPS: z.coerce.number().int().min(5).max(100).default(50),
  /** Wait this long for an order's on-chain result before retrying next tick. */
  FILL_TIMEOUT_SEC: z.coerce.number().int().positive().default(30),
  /** Pause a rule after this many failed orders in a row. */
  MAX_CONSECUTIVE_FAILURES: z.coerce.number().int().positive().default(3),
  /** Any value engages the kill switch from the environment, on top of the admin switch. */
  KILL_SWITCH: optional(z.string()),
  PORT: z.coerce.number().int().positive().default(4400),
  LOG_LEVEL: z.string().default("info"),
  ALERT_WEBHOOK_URL: optional(z.string().url()),
  DEPLOYMENT_JSON: optional(z.string()),
});

export type ExecutorConfig = z.infer<typeof schema> & { deployment: Deployment; rpcUrls: string[]; perplSecret: Uint8Array | null };

export function loadConfig(env: Record<string, string | undefined>): ExecutorConfig {
  const parsed = schema.parse(env);
  const deployment = parsed.DEPLOYMENT_JSON ? (JSON.parse(parsed.DEPLOYMENT_JSON) as Deployment) : deployments[parsed.CHAIN_ID];
  if (!deployment) throw new Error(`no deployment for chain ${parsed.CHAIN_ID}`);
  if (!deployment.perplExchange) throw new Error("the deployment has no Perpl exchange");
  // Session orders must name the order guard, and openings stay under its leverage cap.
  if (!deployment.perplOrderGuard || !(deployment.perplSessionMaxLeverageHdths > 0)) throw new Error("the deployment has no Perpl order guard or session leverage cap");
  const rpcUrls = urlList(parsed.RPC_URLS);
  if (rpcUrls.length === 0) throw new Error("RPC_URLS is required");
  const botReady = parsed.AUTOPILOT_BOT_ADDRESS && parsed.PERPL_API_TOKEN && parsed.PERPL_API_SECRET_KEY;
  if ((parsed.PERPL_API_TOKEN || parsed.PERPL_API_SECRET_KEY) && !botReady) throw new Error("the bot needs AUTOPILOT_BOT_ADDRESS, PERPL_API_TOKEN and PERPL_API_SECRET_KEY together");
  if (parsed.BOT_VENUE === "chain" && parsed.AUTOPILOT_BOT_ADDRESS && !parsed.AUTOPILOT_BOT_PRIVATE_KEY) throw new Error("BOT_VENUE=chain needs AUTOPILOT_BOT_PRIVATE_KEY");
  const hex = parsed.PERPL_API_SECRET_KEY?.replace(/^0x/, "");
  const perplSecret = hex ? Uint8Array.from(hex.match(/../g)!.map((b) => Number.parseInt(b, 16))) : null;
  return { ...parsed, deployment, rpcUrls, perplSecret };
}
