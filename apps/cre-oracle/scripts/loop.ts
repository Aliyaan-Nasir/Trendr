/**
 * Runs the workflow on a schedule with real broadcasts, standing in for the CRE DON while the
 * registry uses the MockKeystoneForwarder (Testnet, and Mainnet while its registry runs in mock
 * mode; see targets.ts for what Mainnet requires). One run at a time; a run that overlaps the next
 * tick is skipped, not queued. Each run prints one JSON line.
 *
 *   bun scripts/loop.ts [--target testnet|mainnet] [--every <seconds, default: the config's schedule>]
 */
import { join } from "node:path";
import { healthHandler } from "./health";
import { loopSetup } from "./targets";

const args = process.argv.slice(2);
const flag = (name: string, fallback: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1]! : fallback;
};
const target = flag("target", "testnet");
const every = flag("every", "");
const setup = loopSetup({ target, everySec: every ? Number(every) : undefined, env: process.env });
const everySec = setup.everySec;

const root = join(import.meta.dir, "..");
let running = false;
let failures = 0;
const startedAt = Date.now();
let lastOkAt: number | null = null;
let stopping = false;

const log = (fields: Record<string, unknown>) => console.log(JSON.stringify({ time: new Date().toISOString(), target, ...fields }));

/**
 * A run that sends a report logs its summary; a run with nothing to report returns it as the
 * simulation result instead.
 */
function summarize(output: string): string | undefined {
  const lines = output.split("\n");
  const logged = lines.filter((l) => l.includes("[USER LOG]")).map((l) => l.replace(/^.*\[USER LOG\]\s*/, ""));
  if (logged.length > 0) return logged.pop();
  const at = lines.findIndex((l) => l.includes("Workflow Simulation Result:"));
  const result = at >= 0 ? lines[at + 1]?.trim().replace(/^"|"$/g, "") : undefined;
  return result || undefined;
}

async function runOnce() {
  if (running) {
    log({ level: "warn", msg: "previous run still going; skipping this tick" });
    return;
  }
  running = true;
  const started = Date.now();
  try {
    const proc = Bun.spawn(
      ["cre", "workflow", "simulate", "attention-index", "--target", target, ...setup.envArgs, "--non-interactive", "--trigger-index", "0", "--broadcast"],
      { cwd: root, stdout: "pipe", stderr: "pipe" },
    );
    const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    const summary = summarize(`${out}\n${err}`);
    if (code !== 0 || !summary) {
      failures++;
      const tail = `${out}\n${err}`.trim().split("\n").slice(-5).join(" | ");
      log({ level: failures >= 3 ? "error" : "warn", msg: "run failed", code, failures, tail });
    } else {
      failures = 0;
      lastOkAt = Date.now();
      log({ level: "info", msg: summary, ms: Date.now() - started });
    }
  } finally {
    running = false;
  }
}

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    stopping = true;
    log({ level: "info", msg: `stopping on ${signal}` });
    process.exit(0);
  });
}

// On a platform (PORT set): /live for its deploy check, /health from recent runs.
const port = Number(process.env.PORT ?? 0);
if (port > 0) {
  Bun.serve({ port, fetch: healthHandler(() => ({ startedAt, lastOkAt, failures }), everySec) });
  log({ level: "info", msg: `serving /live and /health on port ${port}` });
}
if (setup.warning) log({ level: "warn", msg: setup.warning });
log({ level: "info", msg: `running the workflow every ${everySec}s` });
await runOnce();
const timer = setInterval(() => {
  if (!stopping) void runOnce();
}, everySec * 1000);
process.on("exit", () => clearInterval(timer));
