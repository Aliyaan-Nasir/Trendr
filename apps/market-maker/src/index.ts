import { existsSync } from "node:fs";
import { Alerts, balancedHttp, monadChain, ViemChainClient } from "@trendr/chain";
import { trendrErrorAbis } from "@trendr/contracts";
import pino from "pino";
import { createPublicClient, parseAbi, parseEther } from "viem";
import { loadConfig } from "./config";
import { MarketMaker } from "./engine";
import { buildServer } from "./server";
import { StateStore } from "./store";

const cfg = loadConfig(process.env);
const log = pino({ level: cfg.LOG_LEVEL, base: { service: "market-maker", chainId: cfg.CHAIN_ID } });
// Created before the sender so the per-endpoint rate below applies to every client in the process.
const client = createPublicClient({
  chain: monadChain(cfg.CHAIN_ID, cfg.RPC_URL),
  transport: balancedHttp(cfg.rpcUrls, { requestsPerSecond: cfg.RPC_MAX_RPS }),
});
// Kuru's order book errors, so a refused batch says why instead of "unknown reason".
const kuruErrors = parseAbi(["error PostOnlyError()"]);
const chain = new ViemChainClient(cfg.rpcUrls, cfg.CHAIN_ID, [cfg.MM_PRIVATE_KEY as `0x${string}`], (m) => log.warn(m), [...trendrErrorAbis, kuruErrors]);
const alerts = new Alerts("Trendr market maker", log, cfg.ALERT_WEBHOOK_URL);
const mm = new MarketMaker(client, chain, cfg.deployment, new StateStore(cfg.STATE_FILE), alerts, log, {
  quote: {
    halfSpread: cfg.HALF_SPREAD,
    levelStep: cfg.LEVEL_STEP,
    levels: cfg.LEVELS,
    levelTokens: cfg.LEVEL_TOKENS,
    maxSkew: cfg.MAX_SKEW,
    inventoryLimit: cfg.INVENTORY_LIMIT,
  },
  windows: cfg.QUOTE_WINDOWS,
  setsPerSeries: cfg.SETS_PER_SERIES,
  marginAusd: cfg.MARGIN_AUSD,
  requoteTicks: cfg.REQUOTE_TICKS,
  stopBeforeExpirySec: cfg.STOP_BEFORE_EXPIRY_SEC,
  arbMinEdge: cfg.ARB_MIN_EDGE,
  arbMaxTokens: cfg.ARB_MAX_TOKENS,
  quoteEveryBlocks: cfg.QUOTE_EVERY_BLOCKS,
  pollMs: cfg.POLL_MS,
  wsUrls: cfg.wsUrls,
  killed: () => Boolean(cfg.KILL_SWITCH) || (cfg.KILL_SWITCH_FILE !== undefined && existsSync(cfg.KILL_SWITCH_FILE)),
  minBalanceWei: parseEther(String(cfg.MIN_BALANCE_MON)),
  maxSeries: cfg.MAX_SERIES,
  minRequoteSec: cfg.MIN_REQUOTE_SEC,
});
await mm.start();

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    log.info({ signal }, "market maker stopping; resting orders stay until the next start or the kill switch");
    mm.stop();
    process.exit(0);
  });
}

export default { port: cfg.PORT, fetch: buildServer(mm, alerts, cfg.CHAIN_ID, cfg.rpcUrls).fetch };
