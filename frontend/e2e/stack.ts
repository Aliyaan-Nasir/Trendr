// Runs under Bun (see playwright.config.ts), so it is excluded from the app type-check.
/**
 * The local stack for browser end-to-end tests, run by Playwright as its web server:
 * Anvil (Osaka: EIP-7702 and the P256 precompile), the real contracts from script/Deploy.s.sol,
 * the relayer, a stand-in API, and the Next.js dev server wired to them. Run with bun.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "..", "..");
const ANVIL_PORT = 8645;
const RELAYER_PORT = 4199;
const API_PORT = 4198;
const APP_PORT = 3100;
const rpc = `http://127.0.0.1:${ANVIL_PORT}`;
const DEPLOYER = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
const RELAYER = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";
const children: Array<ReturnType<typeof Bun.spawn>> = [];

function stop() {
  for (const c of children) c.kill();
}
process.on("SIGINT", () => (stop(), process.exit(0)));
process.on("SIGTERM", () => (stop(), process.exit(0)));

async function waitFor(url: string, init?: RequestInit) {
  for (let i = 0; i < 300; i++) {
    try {
      const res = await fetch(url, init);
      if (res.status < 500) return;
    } catch {
      // not up yet
    }
    await Bun.sleep(200);
  }
  throw new Error(`timed out waiting for ${url}`);
}

children.push(Bun.spawn(["anvil", "--hardfork", "osaka", "--port", String(ANVIL_PORT), "--silent"], { stdout: "ignore", stderr: "inherit" }));
await waitFor(rpc, { method: "POST", headers: { "content-type": "application/json" }, body: '{"jsonrpc":"2.0","id":1,"method":"eth_chainId","params":[]}' });

const deploy = Bun.spawnSync(["forge", "script", "script/Deploy.s.sol", "--rpc-url", rpc, "--private-key", DEPLOYER, "--broadcast", "--non-interactive"], {
  cwd: join(root, "contracts"),
  env: { ...process.env, CRE_MODE: "mock" },
});
if (deploy.exitCode !== 0) throw new Error(`deploy failed: ${deploy.stderr.toString()}`);
const deployment = await Bun.file(join(root, "contracts", "deployments", "31337.json")).text();
mkdirSync(join(import.meta.dir, ".state"), { recursive: true });
writeFileSync(join(import.meta.dir, ".state", "deployment.json"), deployment);
const compact = JSON.stringify(JSON.parse(deployment));

children.push(
  Bun.spawn(["bun", "src/index.ts"], {
    cwd: join(root, "apps", "relayer"),
    env: {
      ...process.env,
      RPC_URL: rpc,
      CHAIN_ID: "31337",
      RELAYER_PRIVATE_KEYS: RELAYER,
      PORT: String(RELAYER_PORT),
      ALLOWED_ORIGINS: `http://localhost:${APP_PORT}`,
      DEPLOYMENT_JSON: compact,
      // Empty values keep a local apps/relayer/.env (which Bun loads) out of the stack: no RPC pool,
      // and no activation tickets, which the stand-in API never issues.
      RPC_URLS: "",
      ACTIVATION_TICKET_SIGNER: "",
      LOG_LEVEL: "warn",
    },
    stdout: "inherit",
    stderr: "inherit",
  }),
);
await waitFor(`http://127.0.0.1:${RELAYER_PORT}/v1/health`);

// A stand-in for the API that answers every route as a backend without an activation ticket key
// would (404), so sign-up leaves activation to the relayer instead of stopping at an unreachable API.
const cors = {
  "access-control-allow-origin": `http://localhost:${APP_PORT}`,
  "access-control-allow-headers": "content-type, authorization",
  "access-control-allow-methods": "GET, POST, PUT, PATCH, DELETE, OPTIONS",
};
const api = Bun.serve({
  port: API_PORT,
  fetch: (req) =>
    req.method === "OPTIONS"
      ? new Response(null, { status: 204, headers: cors })
      : Response.json({ error: "not found" }, { status: 404, headers: cors }),
});
process.on("exit", () => api.stop(true));

children.push(
  Bun.spawn(["npx", "next", "dev", "--port", String(APP_PORT)], {
    cwd: join(import.meta.dir, ".."),
    env: {
      ...process.env,
      NEXT_PUBLIC_CHAIN_ID: "31337",
      NEXT_PUBLIC_RPC_URL: rpc,
      NEXT_PUBLIC_RELAYER_URL: `http://localhost:${RELAYER_PORT}`,
      NEXT_PUBLIC_BACKEND_URL: `http://localhost:${API_PORT}`,
      NEXT_PUBLIC_DEPLOYMENT_JSON: compact,
      NEXT_PUBLIC_PASSKEY_RP_ID: "localhost",
    },
    stdout: "inherit",
    stderr: "inherit",
  }),
);
await Promise.race(children.map((c) => c.exited));
stop();
