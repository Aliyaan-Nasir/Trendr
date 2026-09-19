import { Alerts, balancedHttp } from "@trendr/chain";
import { perplSessionMaxLeverage } from "@trendr/contracts";
import { fetchContext, type PerplContext, PerplApi, perplNetwork } from "@trendr/perpl";
import pino from "pino";
import { createPublicClient, createWalletClient, type PublicClient } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { monad, monadTestnet } from "viem/chains";
import { loadConfig } from "./config";
import { Copier } from "./copier";
import { connect, ExecutorDb } from "./db";
import { Executor } from "./executor";
import { PerplChain } from "./perpl-chain";
import { Venues } from "./resolver";
import { healthServer } from "./server";
import { ApiVenue, ChainVenue, type Venue } from "./venues";

const cfg = loadConfig(process.env);
const log = pino({ level: cfg.LOG_LEVEL, base: { service: "autopilot" } });
const chainDef = cfg.CHAIN_ID === 143 ? monad : monadTestnet;
const transport = balancedHttp(cfg.rpcUrls, { requestsPerSecond: 10 });
const client = createPublicClient({ chain: chainDef, transport, batch: { multicall: true } }) as PublicClient;
const network = perplNetwork(cfg.CHAIN_ID);
const chain = new PerplChain(client, network.exchange);
const db = new ExecutorDb(connect(cfg.DATABASE_URL));
const alerts = new Alerts("Trendr autopilot", log, cfg.ALERT_WEBHOOK_URL);

let context: { at: number; value: PerplContext } | null = null;
async function perplContext(): Promise<PerplContext> {
  if (!context || Date.now() - context.at > 600_000) context = { at: Date.now(), value: await fetchContext(network) };
  return context.value;
}

let bot: { address: `0x${string}`; venue: Venue } | null = null;
if (cfg.AUTOPILOT_BOT_ADDRESS) {
  const address = cfg.AUTOPILOT_BOT_ADDRESS as `0x${string}`;
  if (cfg.BOT_VENUE === "chain") {
    const account = privateKeyToAccount(cfg.AUTOPILOT_BOT_PRIVATE_KEY as `0x${string}`);
    if (account.address.toLowerCase() !== address.toLowerCase()) throw new Error("AUTOPILOT_BOT_PRIVATE_KEY does not belong to AUTOPILOT_BOT_ADDRESS");
    const wallet = createWalletClient({ chain: chainDef, transport, account });
    bot = { address, venue: new ChainVenue(wallet as never, chain, client, network) };
  } else if (cfg.PERPL_API_TOKEN && cfg.perplSecret) {
    bot = { address, venue: new ApiVenue(address, new PerplApi(network, { token: cfg.PERPL_API_TOKEN, secretKey: cfg.perplSecret }), chain, client) };
  }
}

const session = { orderGuard: cfg.deployment.perplOrderGuard, maxLeverage: perplSessionMaxLeverage(cfg.deployment) };
const venues = new Venues(db, chain, client, network, session, cfg.RELAYER_URL, async () => (await perplContext()).minAccountOpen, cfg.AUTOPILOT_SEAL_PRIVATE_KEY, bot);
let copier: Copier | null = null;
const executor = new Executor(
  db,
  chain,
  async () => (await perplContext()).markets.filter((m) => m.isOpen),
  venues,
  { slippageBps: cfg.SLIPPAGE_BPS, fillTimeoutSec: cfg.FILL_TIMEOUT_SEC, maxConsecutiveFailures: cfg.MAX_CONSECUTIVE_FAILURES, killEnv: cfg.KILL_SWITCH !== undefined, netflowMaxAgeSec: 12 * 3600 },
  log,
  { afterRules: async (ctx) => copier?.tick(ctx) },
);
copier = new Copier(db, chain, venues, executor, log);

const server = Bun.serve({ port: cfg.PORT, fetch: healthServer(executor, db, { chainId: cfg.CHAIN_ID, rpcUrls: cfg.rpcUrls, botVenue: bot ? bot.venue.kind : null, tickSec: cfg.TICK_SEC, alerts: () => alerts.active() }).fetch });
log.info({ port: server.port, chainId: cfg.CHAIN_ID, bot: bot ? { address: bot.address, venue: bot.venue.kind } : null, grants: Boolean(cfg.AUTOPILOT_SEAL_PRIVATE_KEY) }, "autopilot started");

let running = false;
let failures = 0;
async function loop() {
  if (running) return;
  running = true;
  try {
    await venues.refresh(Math.floor(Date.now() / 1000));
    await executor.tick();
    failures = 0;
    alerts.set("tick-failing", false, "");
    alerts.set("orders-stuck", executor.status.ordersInFlight > 5, `${executor.status.ordersInFlight} orders are in flight`);
  } catch (e) {
    failures++;
    const message = e instanceof Error ? e.message : String(e);
    log.error({ err: message, failures }, "tick failed");
    alerts.set("tick-failing", failures >= 3, `ticks are failing: ${message}`);
  } finally {
    running = false;
  }
}
const timer = setInterval(loop, cfg.TICK_SEC * 1000);
void loop();

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, async () => {
    log.info({ signal }, "stopping");
    clearInterval(timer);
    server.stop();
    await db.sql.end({ timeout: 5 });
    process.exit(0);
  });
}
