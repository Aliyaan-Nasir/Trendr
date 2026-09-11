import { urlList } from "@trendr/chain";
import { deployments, type Deployment } from "@trendr/contracts";
import { z } from "zod";
import { type BudgetLimits, DEFAULT_LIMITS } from "./budget";

const key = z.string().regex(/^0x[0-9a-fA-F]{64}$/, "expected a 0x-prefixed 32-byte private key");

const schema = z.object({
  RPC_URL: z.string().url(),
  /** Endpoints to load-balance across, comma-separated; RPC_URL alone when unset. */
  RPC_URLS: z.string().optional(),
  CHAIN_ID: z.coerce.number().int().positive(),
  RELAYER_PRIVATE_KEYS: z
    .string()
    .transform((v) => v.split(",").map((s) => s.trim()).filter(Boolean))
    .pipe(z.array(key).min(1, "at least one relayer key is required")),
  PORT: z.coerce.number().int().positive().default(4100),
  ALLOWED_ORIGINS: z
    .string()
    .default("http://localhost:3000")
    .transform((v) => v.split(",").map((s) => s.trim()).filter(Boolean)),
  MAX_SESSION_DAILY_LIMIT: z.coerce.bigint().default(1_000_000_000n),
  MAX_SESSION_LIFETIME: z.coerce.number().int().positive().default(30 * 86_400),
  LOG_LEVEL: z.string().default("info"),
  /** MON each sponsor key should keep; /v1/health is red when every key is below it. */
  MIN_BALANCE_MON: z.coerce.number().nonnegative().default(1),
  /** Proxies in front that append to X-Forwarded-For (Railway: 1); 0 uses the socket address. */
  TRUSTED_PROXY_HOPS: z.coerce.number().int().min(0).max(8).default(0),
  /** Gas limit one account may spend per UTC day, activation included. */
  ACCOUNT_GAS_PER_DAY: z.coerce.bigint().positive().default(DEFAULT_LIMITS.accountGasPerDay),
  /** Gas limit all accounts together may spend in any rolling hour. */
  RELAYER_GAS_PER_HOUR: z.coerce.bigint().positive().default(DEFAULT_LIMITS.totalGasPerHour),
  /** Activations paid for in any rolling hour, across all accounts. */
  ACTIVATIONS_PER_HOUR: z.coerce.number().int().positive().default(DEFAULT_LIMITS.activationsPerHour),
  /** Activations one client address may request per hour. */
  ACTIVATIONS_PER_IP_PER_HOUR: z.coerce.number().int().positive().default(5),
  /**
   * The backend's activation ticket key (an address). When set, an activation must carry a ticket
   * it signed (see @trendr/contracts activation-ticket); unset, any activation within the caps is paid.
   */
  ACTIVATION_TICKET_SIGNER: z.preprocess((v) => (v === "" ? undefined : v), z.string().regex(/^0x[0-9a-fA-F]{40}$/).optional()),
  /** From this many reverted relays in a UTC day, each further one pauses the account. */
  REVERTS_BEFORE_COOLDOWN: z.coerce.number().int().positive().default(DEFAULT_LIMITS.revertsBeforeCooldown),
  /** Seconds an account is paused after such a revert. */
  REVERT_COOLDOWN_SECONDS: z.coerce.number().int().nonnegative().default(DEFAULT_LIMITS.revertCooldownSeconds),
  /** Deployment JSON for chains not in @trendr/contracts (a local Anvil chain). */
  DEPLOYMENT_JSON: z.string().optional(),
});

export type RelayerConfig = z.infer<typeof schema> & { deployment: Deployment; rpcUrls: string[]; limits: BudgetLimits };

export function loadConfig(env: Record<string, string | undefined>, override?: Deployment): RelayerConfig {
  const parsed = schema.parse(env);
  const deployment =
    override ?? (parsed.DEPLOYMENT_JSON ? (JSON.parse(parsed.DEPLOYMENT_JSON) as Deployment) : deployments[parsed.CHAIN_ID]);
  if (!deployment) throw new Error(`no deployment for chain ${parsed.CHAIN_ID}`);
  const rpcUrls = urlList(parsed.RPC_URLS).length > 0 ? urlList(parsed.RPC_URLS) : [parsed.RPC_URL];
  const limits: BudgetLimits = {
    accountGasPerDay: parsed.ACCOUNT_GAS_PER_DAY,
    totalGasPerHour: parsed.RELAYER_GAS_PER_HOUR,
    activationsPerHour: parsed.ACTIVATIONS_PER_HOUR,
    revertsBeforeCooldown: parsed.REVERTS_BEFORE_COOLDOWN,
    revertCooldownSeconds: parsed.REVERT_COOLDOWN_SECONDS,
  };
  return { ...parsed, deployment, rpcUrls, limits };
}
