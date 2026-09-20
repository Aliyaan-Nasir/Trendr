import { balancedHttp, errorSummary, monadChain, ViemChainClient } from "@trendr/chain";
import pino from "pino";
import { createPublicClient, formatEther, type Hex } from "viem";
import { loadConfig } from "./config";
import { HOUR_MS } from "./plan";
import { buildServer } from "./server";
import { connect, FileStore, PgStore } from "./store";
import { TopUp } from "./topup";

const cfg = loadConfig(process.env);
const log = pino({ level: cfg.LOG_LEVEL, base: { service: "topup", chainId: cfg.CHAIN_ID } });
// Created before the sender so the per-endpoint rate below applies to every client in the process.
const client = createPublicClient({
  chain: monadChain(cfg.CHAIN_ID, cfg.RPC_URL),
  transport: balancedHttp(cfg.rpcUrls, { requestsPerSecond: cfg.RPC_MAX_RPS }),
});

// Never move MON on a chain other than the configured one; wait out an RPC that is down.
for (let attempt = 1; ; attempt++) {
  const id = await client.getChainId().catch((e) => {
    log.warn({ error: errorSummary(e), attempt }, "cannot read the chain id yet");
    return null;
  });
  if (id === cfg.CHAIN_ID) break;
  if (id !== null) throw new Error(`the RPC serves chain ${id}, not CHAIN_ID ${cfg.CHAIN_ID}`);
  await Bun.sleep(Math.min(attempt * 2_000, 30_000));
}

// A dry run keeps its own state, so it never delays or silences the live service's alerts.
const stateId = `${cfg.CHAIN_ID}:${cfg.treasury}${cfg.DRY_RUN ? ":dry-run" : ""}`;
const store = cfg.DATABASE_URL
  ? new PgStore(connect(cfg.DATABASE_URL), stateId)
  : new FileStore(cfg.DRY_RUN ? cfg.STATE_FILE.replace(/(\.json)?$/, ".dry-run.json") : cfg.STATE_FILE);
const sender = cfg.DRY_RUN ? null : new ViemChainClient(cfg.rpcUrls, cfg.CHAIN_ID, [cfg.TREASURY_PRIVATE_KEY as Hex], (m) => log.warn(m));
const topup = new TopUp(
  client,
  sender,
  store,
  log,
  {
    treasury: cfg.treasury,
    targets: cfg.TARGETS,
    floor: cfg.floor,
    intervalMs: cfg.CHECK_INTERVAL_SEC * 1000,
    cooldownMs: cfg.COOLDOWN_SEC * 1000,
    maxRefillsPerHour: cfg.MAX_REFILLS_PER_HOUR,
    minTransfer: cfg.MIN_TRANSFER_MON,
    runwayAlertDays: cfg.RUNWAY_ALERT_DAYS,
    delegatedGasCap: cfg.DELEGATED_GAS_CAP,
    dryRun: cfg.DRY_RUN,
    failureBackoff: { firstMs: 2 * 60_000, maxMs: HOUR_MS },
    alertRepeat: { firstMs: 15 * 60_000, maxMs: 12 * HOUR_MS },
    checkFailuresBeforeAlert: 3,
  },
  { source: cfg.DRY_RUN ? "Trendr top-up (dry run)" : "Trendr top-up", webhookUrl: cfg.ALERT_WEBHOOK_URL },
);

log.info(
  {
    treasury: cfg.treasury,
    floor: formatEther(cfg.floor),
    monadReserve: formatEther(cfg.monadReserve),
    store: store.kind,
    dryRun: cfg.DRY_RUN,
    intervalSec: cfg.CHECK_INTERVAL_SEC,
    targets: cfg.TARGETS.map((t) => `${t.name} ${t.address} min ${formatEther(t.min)} target ${formatEther(t.target)}`),
  },
  "top-up started",
);
topup.start();

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    log.info({ signal }, "top-up stopping");
    // Lets a transfer in flight settle and be recorded before exiting.
    void topup
      .stop()
      .then(() => store.close())
      .finally(() => process.exit(0));
  });
}

export default {
  port: cfg.PORT,
  fetch: buildServer(topup, { chainId: cfg.CHAIN_ID, store: store.kind, rpcUrls: cfg.rpcUrls, adminToken: cfg.ADMIN_TOKEN }).fetch,
};
