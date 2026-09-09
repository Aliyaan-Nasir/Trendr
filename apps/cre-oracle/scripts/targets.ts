import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { periodSec } from "../attention-index/src/schedule";

/**
 * The networks the workflow targets, with the deployment each one reads its contract addresses
 * from. The loop broadcasts to Testnet always, and to Mainnet only while the Mainnet registry runs
 * in mock mode (it trusts one broadcaster key in place of the CRE DON).
 */
export const TARGETS = {
  testnet: { chainId: 10_143, chainSelectorName: "monad-testnet" },
  mainnet: { chainId: 143, chainSelectorName: "monad-mainnet" },
} as const;

export type Target = keyof typeof TARGETS;

/** The fields of contracts/deployments/<chainId>.json the oracle uses. */
export interface OracleDeployment {
  chainId: number;
  creMode?: string;
  trendRegistry: string;
  trendrLens: string;
}

export const ROOT = join(import.meta.dir, "..");
const REPO = join(ROOT, "..", "..");

export function isTarget(value: string): value is Target {
  return Object.hasOwn(TARGETS, value);
}

export function configPath(target: Target, root = ROOT): string {
  return join(root, "attention-index", `config.${target}.json`);
}

export function deploymentPath(target: Target, repo = REPO): string {
  return join(repo, "contracts", "deployments", `${TARGETS[target].chainId}.json`);
}

// The workflow counts its runs with the same reading of the schedule.
export { periodSec };

export interface LoopSetup {
  /** Seconds between runs, from the target's config schedule unless overridden. */
  everySec: number;
  /** Arguments that point the CRE CLI at the target's keys. */
  envArgs: string[];
  /** A problem worth logging that does not stop the loop. */
  warning?: string;
}

interface LoopInput {
  target: string;
  /** `--every`, when given. */
  everySec?: number;
  env: Record<string, string | undefined>;
  root?: string;
  repo?: string;
}

/**
 * What a loop for `target` runs with, or an error saying why it must not run. Mainnet needs
 * CONFIRM_MAINNET=yes, a registry deployed in mock mode, a config synced with that deployment
 * (`pnpm sync-config --target mainnet`), and its own keys: `.env.mainnet`, or exported variables on
 * a platform. The CLI is pointed at `.env.mainnet` explicitly, because by default it reads `.env`,
 * which holds the Testnet broadcaster key.
 */
export function loopSetup(input: LoopInput): LoopSetup {
  const { target, env } = input;
  if (!isTarget(target)) throw new Error(`unknown target "${target}" (testnet or mainnet)`);
  const root = input.root ?? ROOT;
  const config = JSON.parse(readFileSync(configPath(target, root), "utf8")) as { schedule: string; registry: string; lens: string };
  const everySec = input.everySec ?? periodSec(config.schedule);
  if (!Number.isFinite(everySec) || everySec < 15) throw new Error("--every must be at least 15 seconds");

  const file = deploymentPath(target, input.repo ?? REPO);
  const deployment = existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as OracleDeployment) : null;
  const synced =
    deployment !== null &&
    deployment.trendRegistry.toLowerCase() === config.registry.toLowerCase() &&
    deployment.trendrLens.toLowerCase() === config.lens.toLowerCase();
  const unsynced = `config.${target}.json does not match contracts/deployments/${TARGETS[target].chainId}.json; run \`pnpm sync-config --target ${target}\``;

  if (target === "testnet") return { everySec, envArgs: [], ...(synced ? {} : { warning: unsynced }) };

  if (env.CONFIRM_MAINNET !== "yes") throw new Error("the Mainnet loop broadcasts real transactions: set CONFIRM_MAINNET=yes");
  if (!deployment) throw new Error("Trendr is not deployed on Mainnet (no contracts/deployments/143.json)");
  if (deployment.creMode !== "mock") {
    throw new Error(`the Mainnet registry trusts the CRE DON (creMode ${deployment.creMode ?? "unknown"}): the DON reports, not this loop`);
  }
  if (!synced) throw new Error(unsynced);
  const envFile = ".env.mainnet";
  if (!existsSync(join(root, envFile)) && !env.CRE_ETH_PRIVATE_KEY) {
    throw new Error(`the Mainnet loop needs the broadcaster key in ${envFile} (see .env.mainnet.example) or exported as CRE_ETH_PRIVATE_KEY`);
  }
  return { everySec, envArgs: ["--env", envFile] };
}
