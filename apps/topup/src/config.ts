import { urlList } from "@trendr/chain";
import { type Address, isAddress, parseEther } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { z } from "zod";

export const MAINNET_CHAIN_ID = 143;
/** Chains that run Monad's reserve balance rule (Mainnet and Testnet). */
const MONAD_CHAIN_IDS = [143, 10143];
/** Monad's per-account reserve balance: a transfer that leaves the sender below it reverts. */
const MONAD_RESERVE_MON = "10";

/** A wallet the treasury keeps funded. Amounts are in wei. */
export interface Target {
  name: string;
  /** Lowercase 0x hex. */
  address: Address;
  /** Refill when the balance drops below this. */
  min: bigint;
  /** Refill up to this. */
  target: bigint;
  maxPerTransfer: bigint;
  /** Most it receives in any 24 hours. */
  maxPerDay: bigint;
}

const MON = /^\d+(\.\d{1,18})?$/;
const NAME = /^[a-z0-9][a-z0-9_-]{0,31}$/i;

/**
 * Parses `name:address:min:target:maxPerTransfer:maxPerDay` entries (amounts in MON) separated by
 * commas, semicolons or newlines. The order is the priority when the treasury cannot cover everyone.
 */
export function parseTargets(text: string): Target[] {
  const entries = text.split(/[,;\n]/).map((s) => s.trim()).filter(Boolean);
  if (entries.length === 0) throw new Error("TARGETS lists no wallets");
  const targets = entries.map((entry) => {
    const parts = entry.split(":").map((s) => s.trim());
    if (parts.length !== 6) throw new Error(`target "${entry}" needs name:address:min:target:maxPerTransfer:maxPerDay`);
    const [name, address, ...amounts] = parts as [string, string, string, string, string, string];
    if (!NAME.test(name)) throw new Error(`target name "${name}" must be letters, digits, - or _`);
    if (!isAddress(address, { strict: false })) throw new Error(`target ${name} has an invalid address`);
    for (const a of amounts) if (!MON.test(a)) throw new Error(`target ${name} has an invalid MON amount "${a}"`);
    const [min, target, maxPerTransfer, maxPerDay] = amounts.map((a) => parseEther(a)) as [bigint, bigint, bigint, bigint];
    if (min <= 0n) throw new Error(`target ${name}: min must be above zero`);
    if (target <= min) throw new Error(`target ${name}: target must be above min`);
    if (maxPerTransfer <= 0n) throw new Error(`target ${name}: maxPerTransfer must be above zero`);
    if (maxPerDay < maxPerTransfer) throw new Error(`target ${name}: maxPerDay must be at least maxPerTransfer`);
    return { name, address: address.toLowerCase() as Address, min, target, maxPerTransfer, maxPerDay };
  });
  const names = new Set<string>();
  const addresses = new Set<string>();
  for (const t of targets) {
    if (names.has(t.name)) throw new Error(`target ${t.name} is listed twice`);
    if (addresses.has(t.address)) throw new Error(`address ${t.address} is listed twice`);
    names.add(t.name);
    addresses.add(t.address);
  }
  return targets;
}

const key = z.string().regex(/^0x[0-9a-fA-F]{64}$/, "expected a 0x-prefixed 32-byte private key");
/** An optional setting left empty in an env file counts as unset. */
const optional = <T extends z.ZodType>(inner: T) => z.preprocess((v) => (v === "" ? undefined : v), inner.optional());
const flag = z.preprocess((v) => v === "1" || v === "true", z.boolean());
const mon = (fallback: string) =>
  z.preprocess((v) => (v === "" || v === undefined ? fallback : v), z.string().regex(MON, "expected an amount of MON")).transform((v) => parseEther(v));

const schema = z.object({
  RPC_URL: z.string().url(),
  /** Endpoints to load-balance across, comma-separated; RPC_URL alone when unset. */
  RPC_URLS: optional(z.string()),
  CHAIN_ID: z.coerce.number().int().positive(),
  /** Required to run on Monad Mainnet (143), where transfers move real MON. */
  ALLOW_MAINNET: flag,
  RPC_MAX_RPS: z.coerce.number().positive().default(10),
  TREASURY_PRIVATE_KEY: key,
  /** name:address:min:target:maxPerTransfer:maxPerDay in MON, highest priority first. */
  TARGETS: z.string().transform((v, ctx) => {
    try {
      return parseTargets(v);
    } catch (e) {
      ctx.addIssue({ code: "custom", message: e instanceof Error ? e.message : String(e) });
      return z.NEVER;
    }
  }),
  CHECK_INTERVAL_SEC: z.coerce.number().int().min(10).default(120),
  /** The treasury never sends below this, on top of Monad's reserve balance. */
  TREASURY_RESERVE_MON: mon("2"),
  /** Monad's reserve balance; 10 MON on Monad chains, 0 elsewhere (Anvil) when unset. */
  MONAD_RESERVE_MON: optional(z.string().regex(MON, "expected an amount of MON")),
  /** No second transfer to a wallet within this many seconds of the last one. */
  COOLDOWN_SEC: z.coerce.number().int().min(0).default(600),
  /** More refills than this within an hour halts a wallet until an operator releases it. */
  MAX_REFILLS_PER_HOUR: z.coerce.number().int().positive().default(3),
  /** Smallest transfer worth sending when the treasury or a daily cap allows only part of a refill. */
  MIN_TRANSFER_MON: mon("0.1"),
  /** Warn when the treasury's runway at the observed burn drops below this many days. */
  RUNWAY_ALERT_DAYS: z.coerce.number().positive().default(3),
  /** Gas cap for a transfer to a wallet with code (an EIP-7702 delegation); plain EOAs take 21000. */
  DELEGATED_GAS_CAP: z.coerce.bigint().default(100_000n),
  /** Logs what it would send and sends nothing. */
  DRY_RUN: flag,
  /** Postgres for caps, cooldowns and alert state; a local state file when unset. */
  DATABASE_URL: optional(z.string().url()),
  STATE_FILE: z.string().default(".topup-state.json"),
  /** Bearer token for POST /targets/:name/release; the endpoint is off when unset. */
  ADMIN_TOKEN: optional(z.string().min(24, "ADMIN_TOKEN must be at least 24 characters")),
  PORT: z.coerce.number().int().positive().default(4500),
  LOG_LEVEL: z.string().default("info"),
  /** Slack or Discord compatible webhook for alerts; alerts are always logged. */
  ALERT_WEBHOOK_URL: optional(z.string().url()),
});

export type TopupConfig = Omit<z.infer<typeof schema>, "MONAD_RESERVE_MON"> & {
  rpcUrls: string[];
  treasury: Address;
  monadReserve: bigint;
  /** The treasury never sends below this: its own reserve plus Monad's. */
  floor: bigint;
};

export function loadConfig(env: Record<string, string | undefined>): TopupConfig {
  const parsed = schema.parse(env);
  if (parsed.CHAIN_ID === MAINNET_CHAIN_ID && !parsed.ALLOW_MAINNET) {
    throw new Error("CHAIN_ID=143 is Monad Mainnet, where transfers move real MON: set ALLOW_MAINNET=1 to run there");
  }
  const treasury = privateKeyToAccount(parsed.TREASURY_PRIVATE_KEY as `0x${string}`).address.toLowerCase() as Address;
  const self = parsed.TARGETS.find((t) => t.address === treasury);
  if (self) throw new Error(`target ${self.name} is the treasury itself`);
  const small = parsed.TARGETS.find((t) => t.maxPerTransfer < parsed.MIN_TRANSFER_MON);
  if (small) throw new Error(`target ${small.name}: maxPerTransfer is below MIN_TRANSFER_MON`);
  const monadReserve = parseEther(parsed.MONAD_RESERVE_MON ?? (MONAD_CHAIN_IDS.includes(parsed.CHAIN_ID) ? MONAD_RESERVE_MON : "0"));
  const rpcUrls = urlList(parsed.RPC_URLS).length > 0 ? urlList(parsed.RPC_URLS) : [parsed.RPC_URL];
  const { MONAD_RESERVE_MON: _, ...rest } = parsed;
  return { ...rest, rpcUrls, treasury, monadReserve, floor: parsed.TREASURY_RESERVE_MON + monadReserve };
}
