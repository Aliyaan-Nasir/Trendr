import { endpointPool, ViemChainClient } from "@trendr/chain";
import { trendrErrorAbis } from "@trendr/contracts";
import pino from "pino";
import { parseEther } from "viem";
import { loadConfig } from "./config";
import { buildServer } from "./server";
import { RelayerService } from "./service";
import { drain } from "./shutdown";

const cfg = loadConfig(process.env);
const log = pino({ level: cfg.LOG_LEVEL, base: { service: "relayer", chainId: cfg.CHAIN_ID } });
const chain = new ViemChainClient(
  cfg.rpcUrls,
  cfg.CHAIN_ID,
  cfg.RELAYER_PRIVATE_KEYS as `0x${string}`[],
  (m) => log.warn(m),
  trendrErrorAbis,
);
const service = new RelayerService(chain, {
  deployment: cfg.deployment,
  maxSessionDailyLimit: cfg.MAX_SESSION_DAILY_LIMIT,
  maxSessionLifetime: cfg.MAX_SESSION_LIFETIME,
  activationTicketSigner: cfg.ACTIVATION_TICKET_SIGNER as `0x${string}` | undefined,
  limits: cfg.limits,
});
const app = buildServer({
  service,
  allowedOrigins: cfg.ALLOWED_ORIGINS,
  log,
  funds: () => Promise.all(chain.senders().map(async (address) => ({ address, balanceWei: await chain.client.getBalance({ address }) }))),
  minBalanceWei: parseEther(String(cfg.MIN_BALANCE_MON)),
  rpc: () => endpointPool(cfg.rpcUrls)?.report() ?? [],
  trustedProxyHops: cfg.TRUSTED_PROXY_HOPS,
  activationsPerIpPerHour: cfg.ACTIVATIONS_PER_IP_PER_HOUR,
});

const server = Bun.serve({ port: cfg.PORT, fetch: app.fetch, idleTimeout: 60 });

let stopping = false;
async function shutdown(signal: string) {
  if (stopping) return;
  stopping = true;
  log.info({ signal }, "draining relays in flight");
  const drained = await drain(server);
  log.info({ drained }, "relayer stopped");
  process.exit(0);
}
for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, () => void shutdown(signal));

log.info(
  {
    port: server.port,
    relayers: chain.senders(),
    trustedProxyHops: cfg.TRUSTED_PROXY_HOPS,
    limits: Object.fromEntries(Object.entries(cfg.limits).map(([k, v]) => [k, String(v)])),
  },
  "relayer listening",
);
