import { type Deployment, deployments } from "@trendr/contracts";

/** Network and service settings, from the environment at build time. */

export const CHAIN_ID = Number(process.env.NEXT_PUBLIC_CHAIN_ID ?? 10143);
export const IS_MAINNET = CHAIN_ID === 143;
export const BACKEND_URL = (process.env.NEXT_PUBLIC_BACKEND_URL ?? "http://localhost:4000").replace(/\/$/, "");
export const RELAYER_URL = (process.env.NEXT_PUBLIC_RELAYER_URL ?? "http://localhost:4100").replace(/\/$/, "");
/**
 * Read endpoints, tried in order: a rate-limited or failing one hands over to the next, so one
 * provider's limit never fails a trade. NEXT_PUBLIC_RPC_URLS (comma-separated) overrides them.
 * Every default answers browsers: rpc-testnet.monadinfra.com is left out because it refuses
 * batched calls with a 403 whose Access-Control-Allow-Origin is empty, a CORS error in the console.
 */
const DEFAULT_RPC_URLS = IS_MAINNET
  ? ["https://rpc.monad.xyz"]
  : ["https://testnet-rpc.monad.xyz", "https://rpc.ankr.com/monad_testnet", "https://monad-testnet.drpc.org"];
const configuredRpcs = (process.env.NEXT_PUBLIC_RPC_URLS ?? process.env.NEXT_PUBLIC_RPC_URL ?? "")
  .split(",")
  .map((u) => u.trim())
  .filter(Boolean);
export const RPC_URLS: readonly string[] = configuredRpcs.length > 0 ? configuredRpcs : DEFAULT_RPC_URLS;
export const RPC_URL = RPC_URLS[0]!;
/**
 * Head stream endpoints, rotated when one drops: NEXT_PUBLIC_WS_URLS (comma-separated), else
 * NEXT_PUBLIC_WS_URL, else Monad's public endpoint.
 */
const configuredWs = (process.env.NEXT_PUBLIC_WS_URLS || process.env.NEXT_PUBLIC_WS_URL || "")
  .split(",")
  .map((u) => u.trim())
  .filter(Boolean);
export const WS_URLS: readonly string[] = configuredWs.length > 0 ? configuredWs : [IS_MAINNET ? "wss://rpc.monad.xyz" : "wss://testnet-rpc.monad.xyz"];
export const WS_URL = WS_URLS[0]!;
/** Monadscan, where every Trendr contract is verified. */
export const EXPLORER_URL = IS_MAINNET ? "https://monadscan.com" : "https://testnet.monadscan.com";
export const EXPLORER_NAME = "Monadscan";
/** Trendr's X account. */
export const X_HANDLE = "@trendrnow";
export const X_URL = "https://x.com/trendrnow";
export const APP_URL = (process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000").replace(/\/$/, "");

function loadDeployment(): Deployment {
  const local = process.env.NEXT_PUBLIC_DEPLOYMENT_JSON;
  const d = local ? (JSON.parse(local) as Deployment) : deployments[CHAIN_ID];
  if (!d) throw new Error(`No Trendr deployment for chain ${CHAIN_ID}`);
  return d;
}

export const DEPLOYMENT = loadDeployment();

/** AUSD carries 6 decimals on Monad. */
export const AUSD_DECIMALS = 6;

export const explorerTx = (hash: string) => `${EXPLORER_URL}/tx/${hash}`;
export const explorerAddress = (address: string) => `${EXPLORER_URL}/address/${address}`;
/** A token's page: holders, transfers and its verified contract. */
export const explorerToken = (address: string) => `${EXPLORER_URL}/token/${address}`;
