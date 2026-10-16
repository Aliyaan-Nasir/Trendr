import { Alerts, balancedHttp, monadChain, ViemChainClient } from "@trendr/chain";
import { trendrErrorAbis } from "@trendr/contracts";
import pino from "pino";
import { createPublicClient, parseEther } from "viem";
import { loadConfig } from "./config";
import { Executor } from "./executor";
import { Keeper } from "./keeper";
import { buildServer } from "./server";
import { rotationReader } from "./rotation";

const cfg = loadConfig(process.env);
const log = pino({ level: cfg.LOG_LEVEL, base: { service: "keeper", chainId: cfg.CHAIN_ID } });
// Created before the sender so the per-endpoint rate below applies to every client in the process.
const client = createPublicClient({
  chain: monadChain(cfg.CHAIN_ID, cfg.RPC_URL),
  transport: balancedHttp(cfg.rpcUrls, { requestsPerSecond: cfg.RPC_MAX_RPS }),
});
const chain = new ViemChainClient(cfg.rpcUrls, cfg.CHAIN_ID, [cfg.KEEPER_PRIVATE_KEY as `0x${string}`], (m) => log.warn(m), trendrErrorAbis);
const alerts = new Alerts("Trendr keeper", log, cfg.ALERT_WEBHOOK_URL);
const executor = new Executor(chain, log);
const keeper = new Keeper(client, chain, cfg.deployment, executor, alerts, log, {
  seriesWindows: cfg.SERIES_WINDOWS,
  listWindows: cfg.LIST_WINDOWS,
  scanEveryBlocks: cfg.SCAN_EVERY_BLOCKS,
  maxActionsPerScan: cfg.MAX_ACTIONS_PER_SCAN,
  pollMs: cfg.POLL_MS,
  headLagAlertSec: cfg.HEAD_LAG_ALERT_SEC,
  minBalanceWei: parseEther("1"),
  wsUrls: cfg.wsUrls,
  rotating: cfg.ROTATION_URL ? rotationReader(cfg.ROTATION_URL) : undefined,
});
await keeper.start();

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    log.info({ signal }, "keeper stopping");
    keeper.stop();
    process.exit(0);
  });
}

export default { port: cfg.PORT, fetch: buildServer(keeper, executor, alerts, cfg.CHAIN_ID, cfg.rpcUrls).fetch };
