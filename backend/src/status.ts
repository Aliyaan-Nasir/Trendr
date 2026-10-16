import type { ChainReader } from "./chain";

/**
 * The public status view: each service's health endpoint, the oracle's freshness and the chain
 * head, as up or down only (the detail stays on each service and behind admin sign-in).
 */

export interface ServiceProbe {
  name: string;
  url: string;
  /** Its outage is a warning in the admin system view, not critical. */
  optional?: boolean;
  /** How long it may go without doing its work before the admin system view reads it as stalled (ms). */
  staleMs?: number;
}

/**
 * name=url entries, comma-separated, each optionally followed by |-separated flags for the admin
 * system view: `optional` and `staleMin=<minutes>` (`keeper=http://k/health|staleMin=5`). An
 * entry without a name or an http(s) URL is skipped; an unknown or malformed flag throws, so a
 * typo fails at start-up (loadConfig parses every list once).
 */
export function parseServices(value: string | undefined): ServiceProbe[] {
  return (value ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((entry) => {
      const [pair = "", ...flags] = entry.split("|").map((f) => f.trim());
      const i = pair.indexOf("=");
      const probe: ServiceProbe = { name: pair.slice(0, i).trim(), url: pair.slice(i + 1).trim() };
      for (const flag of flags.filter(Boolean)) {
        const stale = /^staleMin=(\d+(?:\.\d+)?)$/.exec(flag);
        if (flag === "optional") probe.optional = true;
        else if (stale && Number(stale[1]) > 0) probe.staleMs = Math.round(Number(stale[1]) * 60_000);
        else throw new Error(`service ${probe.name || pair}: unknown flag "${flag}" (use optional or staleMin=<minutes>)`);
      }
      return probe;
    })
    .filter((s) => s.name && /^https?:\/\//.test(s.url));
}

export async function status(
  chain: ChainReader,
  services: readonly ServiceProbe[],
  opts: { oracleStaleSec: number; fetchImpl?: typeof fetch; /** Trends rotating out: stale on purpose. */ rotating?: ReadonlySet<string> },
  nowSec = Math.floor(Date.now() / 1000),
) {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const probes = await Promise.all(
    services.map(async (s) => {
      const started = Date.now();
      try {
        const res = await fetchImpl(s.url, { signal: AbortSignal.timeout(3000) });
        return { name: s.name, ok: res.ok, latencyMs: Date.now() - started };
      } catch {
        return { name: s.name, ok: false, latencyMs: null };
      }
    }),
  );
  let oracle: { ok: boolean; lastRunAgeSec: number | null; staleTrends: number } = { ok: false, lastRunAgeSec: null, staleTrends: 0 };
  let head: { ok: boolean; ageSec: number | null; number: string | null } = { ok: false, ageSec: null, number: null };
  try {
    const [trends, lastRunId, block] = await Promise.all([chain.trends(), chain.lastRunId(), chain.client.getBlock()]);
    const live = trends.filter((t) => t.status === "Active" || t.status === "Cooling");
    const lastRunAgeSec = Number(lastRunId) > 0 ? nowSec - Number(lastRunId) : null;
    const staleTrends = live.filter((t) => !opts.rotating?.has(t.identifier) && nowSec - t.updatedAt > opts.oracleStaleSec).length;
    oracle = { ok: lastRunAgeSec !== null && lastRunAgeSec < opts.oracleStaleSec && staleTrends === 0, lastRunAgeSec, staleTrends };
    const ageSec = nowSec - Number(block.timestamp);
    head = { ok: ageSec < 30, ageSec, number: block.number.toString() };
  } catch {
    // Chain unreachable: both stay down.
  }
  const ok = probes.every((p) => p.ok) && oracle.ok && head.ok;
  return { ok, services: probes, oracle, chain: head, at: nowSec };
}

/** A wallet a service sends from, with its MON (a decimal string). */
export interface ServiceWallet {
  label: string;
  address: string;
  mon: string | null;
}

/** The top-up treasury: what it holds, what it keeps back, its burn and runway, and its targets. */
export interface TreasuryDetail {
  address: string;
  balanceMon: string;
  floorMon: string;
  spendableMon: string;
  burnPerDayMon: string | null;
  runwayDays: number | null;
  targets: Array<{
    name: string;
    address: string;
    balanceMon: string;
    minMon: string;
    targetMon: string;
    state: string;
    /** MON this wallet burned over the last day; null until the top-up service has a day of history. */
    burnPerDayMon: string | null;
    lastTransfer: { hash: string | null; amountMon: string; at: number; status: string } | null;
  }>;
}

/** One service as operators see it: reachability plus what its health endpoint reports. */
export interface ServiceDetail {
  name: string;
  ok: boolean;
  latencyMs: number | null;
  /** The health endpoint's HTTP status; null when it did not answer. */
  httpStatus: number | null;
  lastError: string | null;
  /** Alerts the service has raised and not yet cleared. */
  alerts: string[];
  wallets: ServiceWallet[];
  /** The top-up service only. */
  treasury: TreasuryDetail | null;
}

type Json = Record<string, unknown>;
const obj = (v: unknown): Json | null => (v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Json) : null);
const str = (v: unknown): string | null => (typeof v === "string" ? v : null);
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const isAddress = (v: unknown): v is string => typeof v === "string" && /^0x[0-9a-fA-F]{40}$/.test(v);
/** Wei as a decimal MON string, without float rounding. */
function weiToMon(v: unknown): string | null {
  if (typeof v !== "string" || !/^\d+$/.test(v)) return null;
  const wei = BigInt(v);
  const whole = wei / 10n ** 18n;
  const frac = (wei % 10n ** 18n).toString().padStart(18, "0").replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : whole.toString();
}
const message = (v: unknown): string | null => str(v) ?? str(obj(v)?.message) ?? str(obj(v)?.error) ?? null;

/**
 * Reads the shapes Trendr's services report on /health: the keeper and market maker name their
 * sender and its balance, the relayer its sponsor keys, and the top-up service its treasury and
 * every wallet it keeps funded. Anything else is kept to up or down.
 */
export function describeHealth(body: unknown): Omit<ServiceDetail, "name" | "ok" | "latencyMs" | "httpStatus"> {
  const b = obj(body) ?? {};
  const wallets: ServiceWallet[] = [];
  if (isAddress(b.keeper)) wallets.push({ label: "Keeper", address: b.keeper.toLowerCase(), mon: weiToMon(b.balanceWei) });
  if (isAddress(b.maker)) wallets.push({ label: "Maker", address: b.maker.toLowerCase(), mon: weiToMon(b.balanceWei) });
  if (Array.isArray(b.keys)) {
    b.keys.forEach((k, i) => {
      const key = obj(k);
      if (key && isAddress(key.address)) wallets.push({ label: `Sponsor key ${i + 1}`, address: key.address.toLowerCase(), mon: num(key.mon)?.toString() ?? null });
    });
  }
  const t = obj(b.treasury);
  let treasury: TreasuryDetail | null = null;
  if (t && isAddress(t.address) && str(t.balance) !== null) {
    treasury = {
      address: t.address.toLowerCase(),
      balanceMon: str(t.balance)!,
      floorMon: str(t.floor) ?? "0",
      spendableMon: str(t.spendable) ?? "0",
      burnPerDayMon: str(t.burnPerDay),
      runwayDays: num(t.runwayDays),
      targets: (Array.isArray(b.targets) ? b.targets : []).flatMap((x) => {
        const g = obj(x);
        if (!g || !isAddress(g.address) || str(g.name) === null) return [];
        const last = obj(g.lastTransfer);
        return [
          {
            name: str(g.name)!,
            address: g.address.toLowerCase(),
            balanceMon: str(g.balance) ?? "0",
            minMon: str(g.min) ?? "0",
            targetMon: str(g.target) ?? "0",
            state: str(g.state) ?? "unknown",
            burnPerDayMon: str(g.burnPerDay),
            lastTransfer: last && num(last.at) !== null ? { hash: str(last.hash), amountMon: str(last.amount) ?? "0", at: num(last.at)!, status: str(last.status) ?? "unknown" } : null,
          },
        ];
      }),
    };
  }
  const alerts = Object.entries(obj(b.alerts) ?? {}).map(([k, v]) => (typeof v === "string" && v ? `${k}: ${v}` : k));
  const lastError = message(b.lastError) ?? message(obj(b.lastCheck)?.error) ?? (b.ok === false ? message(b.error) : null);
  return { lastError, alerts, wallets, treasury };
}

/** Every service's health in detail, for the admin view; never throws. */
export async function serviceDetails(services: readonly ServiceProbe[], fetchImpl: (url: string, init?: RequestInit) => Promise<Response> = fetch): Promise<ServiceDetail[]> {
  return Promise.all(
    services.map(async (s): Promise<ServiceDetail> => {
      const started = Date.now();
      try {
        const res = await fetchImpl(s.url, { signal: AbortSignal.timeout(3000) });
        const latencyMs = Date.now() - started;
        const body: unknown = await res.json().catch(() => null);
        return { name: s.name, ok: res.ok, latencyMs, httpStatus: res.status, ...describeHealth(body) };
      } catch {
        return { name: s.name, ok: false, latencyMs: null, httpStatus: null, lastError: "no answer", alerts: [], wallets: [], treasury: null };
      }
    }),
  );
}
