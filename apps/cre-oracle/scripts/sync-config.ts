/**
 * Writes the deployed TrendRegistry and TrendrLens addresses from contracts/deployments/<chainId>.json
 * into attention-index/config.<target>.json after a deploy, and optionally the backend collector and
 * candidate URLs. Only those values change; the rest of the file stays as it is. `--check` writes
 * nothing and fails when the config is out of date.
 *
 *   bun scripts/sync-config.ts --target mainnet [--backend https://api.example.com] [--check]
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { configSchema } from "../attention-index/src/config";
import { configPath, deploymentPath, isTarget, type OracleDeployment, type Target, TARGETS } from "./targets";

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const ZERO = /^0x0{40}$/;

export interface SyncOptions {
  target: Target;
  /** Base URL of the backend whose collector and candidate queue the workflow reads. */
  backendUrl?: string;
}

/** The config text with the deployment's addresses (and backend URLs) in place. */
export function syncConfig(text: string, deployment: OracleDeployment, opts: SyncOptions): string {
  const want = TARGETS[opts.target];
  if (deployment.chainId !== want.chainId) throw new Error(`the deployment is for chain ${deployment.chainId}, not ${opts.target} (${want.chainId})`);
  for (const key of ["trendRegistry", "trendrLens"] as const) {
    const a = deployment[key];
    if (typeof a !== "string" || !ADDRESS.test(a) || ZERO.test(a)) throw new Error(`the deployment has no ${key}`);
  }
  const current = configSchema.parse(JSON.parse(text));
  if (current.chainSelectorName !== want.chainSelectorName) {
    throw new Error(`the config is for ${current.chainSelectorName}, not ${want.chainSelectorName}`);
  }

  let out = text;
  const set = (key: string, value: string) => {
    const pattern = new RegExp(`("${key}"\\s*:\\s*)"[^"]*"`);
    if (!pattern.test(out)) throw new Error(`the config has no "${key}"`);
    out = out.replace(pattern, (_m, head: string) => `${head}${JSON.stringify(value)}`);
  };
  set("registry", deployment.trendRegistry);
  set("lens", deployment.trendrLens);
  if (opts.backendUrl !== undefined) {
    const base = opts.backendUrl.replace(/\/+$/, "");
    set("measurementsUrl", `${base}/v1/oracle/measurements`);
    set("candidatesUrl", `${base}/v1/oracle/candidates`);
  }
  // The result must still be a valid config (the backend URL must be https off this machine).
  const next = configSchema.parse(JSON.parse(out));
  if (next.registry !== deployment.trendRegistry || next.lens !== deployment.trendrLens) throw new Error("the addresses did not land");
  return out;
}

function main(argv: string[]) {
  const flag = (name: string) => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const target = flag("target") ?? "";
  if (!isTarget(target)) throw new Error("usage: bun scripts/sync-config.ts --target testnet|mainnet [--backend <https url>] [--check]");
  const file = configPath(target);
  const source = deploymentPath(target);
  if (!existsSync(source)) throw new Error(`no ${source}: deploy the contracts to ${target} first`);
  const deployment = JSON.parse(readFileSync(source, "utf8")) as OracleDeployment;
  const before = readFileSync(file, "utf8");
  const after = syncConfig(before, deployment, { target, backendUrl: flag("backend") });
  const loop = target === "mainnet" ? "pnpm cre:loop:mainnet" : "pnpm cre:loop";
  const mode = deployment.creMode === "mock" ? `mock mode, so \`${loop}\` broadcasts` : "production, so the CRE DON reports";
  if (argv.includes("--check")) {
    if (after !== before) {
      console.error(`config.${target}.json is out of date with deployments/${deployment.chainId}.json; run without --check`);
      process.exit(1);
    }
    console.log(`config.${target}.json matches deployments/${deployment.chainId}.json`);
    return;
  }
  if (after !== before) writeFileSync(file, after);
  console.log(`config.${target}.json: registry ${deployment.trendRegistry}, lens ${deployment.trendrLens} (${after === before ? "unchanged" : "updated"}; registry in ${mode})`);
}

if (import.meta.main) main(process.argv.slice(2));
