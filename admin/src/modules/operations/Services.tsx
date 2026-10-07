"use client";
import { useQuery } from "@tanstack/react-query";
import { Activity, Bot, Coins, Database, Fuel, Landmark, Radio, Send, Server } from "lucide-react";
import type { ReactNode } from "react";
import { Badge, StatusDot, type Tone } from "@/src/components/ui/Badge";
import { Button } from "@/src/components/ui/Button";
import { ExplorerLink } from "@/src/components/ui/ExplorerLink";
import { Notice } from "@/src/components/ui/Notice";
import { api, ApiError } from "@/src/lib/api";
import { explorerAddress, explorerTx } from "@/src/lib/config";
import { formatAge, formatDate, shortAddress } from "@/src/lib/format";
import type { ServiceDetail, TopupTarget, Treasury } from "@/src/types/admin";
import { Card, Row, Rows } from "./parts";

/** Under ["admin"]: dropped on sign-out with the rest of the admin data. */
export const SERVICES_KEY = ["admin", "services"] as const;

/** Runway under these many days reads as a warning, then as urgent (the backend's system view uses the same). */
export const RUNWAY_WARN_DAYS = 7;
export const RUNWAY_BAD_DAYS = 3;

const SERVICES: Record<string, { title: string; icon: ReactNode; role: string }> = {
  backend: { title: "Backend", icon: <Server size={16} aria-hidden />, role: "The API, the radar, the collector and the database." },
  keeper: { title: "Keeper", icon: <Activity size={16} aria-hidden />, role: "Series, listing, settlement, liquidation, funding, retirement and graduation." },
  "market-maker": { title: "Market maker", icon: <Coins size={16} aria-hidden />, role: "Quotes UP and DOWN on Kuru for every listed series." },
  relayer: { title: "Relayer", icon: <Send size={16} aria-hidden />, role: "Pays the gas for passkey accounts." },
  autopilot: { title: "Autopilot executor", icon: <Bot size={16} aria-hidden />, role: "Runs Autopilot rules and copy trading on Perpl." },
  topup: { title: "Top-up", icon: <Fuel size={16} aria-hidden />, role: "Refills every sending wallet with MON from the treasury." },
  oracle: { title: "Oracle", icon: <Radio size={16} aria-hidden />, role: "The CRE workflow's attention index reports on chain." },
  indexer: { title: "Indexer", icon: <Database size={16} aria-hidden />, role: "Envio's copy of on-chain history for the app." },
};
/** Words a service name may carry that read as acronyms in a title. */
const ACRONYMS = new Set(["ai", "api", "db", "mev", "rpc", "ws"]);

/** "some-rpc-service" as "Some RPC service". */
const titleOf = (name: string) => {
  const words = name.split(/[-_\s]+/).filter(Boolean).map((w) => (ACRONYMS.has(w.toLowerCase()) ? w.toUpperCase() : w));
  const title = words.join(" ");
  return title.charAt(0).toUpperCase() + title.slice(1);
};

/** A service's title, icon and one-line role; any other service gets its name as the title, a server icon and no role. */
export const serviceMeta = (name: string) => SERVICES[name] ?? { title: titleOf(name), icon: <Server size={16} aria-hidden />, role: "" };
const meta = serviceMeta;

/** "456.67 MON", with fewer decimals as the amount grows. */
export function mon(value: string | null): string {
  if (value === null) return "-";
  const n = Number(value);
  if (!Number.isFinite(n)) return value;
  return `${n.toLocaleString("en-US", { maximumFractionDigits: n >= 100 ? 1 : n >= 1 ? 2 : 3 })} MON`;
}

function runwayTone(days: number | null): Tone {
  if (days === null) return "neutral";
  return days < RUNWAY_BAD_DAYS ? "bad" : days < RUNWAY_WARN_DAYS ? "warn" : "ok";
}

/** Every service's health in detail, with the treasury on top. */
export function ServicesSection({ now }: { now: number }) {
  const services = useQuery({ queryKey: SERVICES_KEY, queryFn: api.services, refetchInterval: 15_000 });

  if (services.isPending) {
    return (
      <div className="space-y-4" aria-busy aria-label="Loading services">
        <div className="h-56 animate-pulse rounded-xl border border-line bg-surface" />
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
          {[0, 1, 2].map((i) => (
            <div key={i} className="h-44 animate-pulse rounded-xl border border-line bg-surface" />
          ))}
        </div>
      </div>
    );
  }
  if (!services.data) {
    const older = services.error instanceof ApiError && services.error.status === 404;
    return (
      <Notice
        tone={older ? "info" : "bad"}
        title={older ? "Service detail needs a newer backend" : "Could not read the services"}
        action={
          older ? undefined : (
            <Button size="sm" onClick={() => void services.refetch()} loading={services.isFetching}>
              Try again
            </Button>
          )
        }
      >
        {older ? "This backend predates GET /v1/admin/services. Restart it on the current code to see each service's wallets and the treasury." : services.error?.message}
      </Notice>
    );
  }
  if (services.data.length === 0) {
    return <p className="rounded-xl border border-dashed border-line-strong px-4 py-8 text-center text-sm text-muted">No services are configured. Set STATUS_SERVICES on the backend to watch them here.</p>;
  }
  const treasury = services.data.find((s) => s.treasury)?.treasury ?? null;
  return (
    <div className="space-y-4">
      {services.isError && (
        <Notice tone="warn" title="Showing the last reading">
          Refreshing failed: {services.error.message}
        </Notice>
      )}
      {treasury ? <TreasuryCard treasury={treasury} now={now} /> : null}
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
        {services.data.map((s) => (
          <ServiceCard key={s.name} service={s} />
        ))}
      </div>
    </div>
  );
}

function ServiceCard({ service: s }: { service: ServiceDetail }) {
  const m = meta(s.name);
  return (
    <Card data-testid="service-card" data-name={s.name} data-ok={s.ok} icon={m.icon} title={m.title} status={<Badge tone={s.ok ? "ok" : "bad"}>{s.ok ? "Up" : s.httpStatus === null ? "No answer" : "Unhealthy"}</Badge>}>
      {m.role ? <p className="-mt-1 mb-3 text-[13px] leading-5 text-muted">{m.role}</p> : null}
      <Rows>
        <Row label="Health">
          {s.httpStatus === null ? <span className="text-bad">unreachable</span> : <span className={s.ok ? "" : "text-bad"}>HTTP {s.httpStatus}</span>}
          {s.latencyMs !== null ? <span className="text-subtle"> · {s.latencyMs} ms</span> : null}
        </Row>
        {s.wallets.map((w) => (
          <Row key={w.address} label={w.label}>
            <span className="inline-flex items-center gap-2">
              <ExplorerLink href={explorerAddress(w.address)} className="font-mono text-xs">
                {shortAddress(w.address)}
              </ExplorerLink>
              <span className="text-fg">{mon(w.mon)}</span>
            </span>
          </Row>
        ))}
      </Rows>
      {s.alerts.length > 0 ? (
        <ul className="mt-3 space-y-1.5">
          {s.alerts.map((a) => (
            <li key={a} className="flex items-start gap-2 rounded-lg bg-warn-soft px-3 py-2 text-xs leading-5 text-warn">
              <StatusDot tone="warn" />
              <span className="-mt-px min-w-0 [overflow-wrap:anywhere]">{a}</span>
            </li>
          ))}
        </ul>
      ) : null}
      {s.lastError ? <p className="mt-3 [overflow-wrap:anywhere] rounded-lg bg-bad-soft px-3 py-2 font-mono text-xs leading-5 text-bad">{s.lastError}</p> : null}
    </Card>
  );
}

function Stat({ label, value, hint, tone }: { label: string; value: ReactNode; hint?: ReactNode; tone?: Tone }) {
  const color = tone === "bad" ? "text-bad" : tone === "warn" ? "text-warn" : tone === "ok" ? "text-ok" : "text-fg";
  return (
    <div className="min-w-0 rounded-lg bg-raised px-3.5 py-3">
      <dt className="text-xs text-subtle">{label}</dt>
      <dd className={`mt-1 truncate text-lg font-semibold tabular-nums ${color}`}>{value}</dd>
      {hint ? <dd className="mt-0.5 truncate text-xs text-subtle">{hint}</dd> : null}
    </div>
  );
}

/** The treasury's balance, burn and runway, and every wallet it keeps funded. */
export function TreasuryCard({ treasury: t, now }: { treasury: Treasury; now: number }) {
  const tone = runwayTone(t.runwayDays);
  return (
    <section aria-labelledby="treasury-title" data-testid="treasury" className="rounded-xl border border-line bg-surface shadow-card">
      <div className="flex flex-col gap-1 p-4 sm:flex-row sm:items-start sm:justify-between sm:p-5">
        <div className="min-w-0">
          <h3 id="treasury-title" className="flex items-center gap-2 text-sm font-semibold text-fg">
            <Landmark size={16} className="text-subtle" aria-hidden />
            Treasury
          </h3>
          <p className="mt-0.5 text-[13px] leading-5 text-muted">MON that the top-up service sends to every wallet below when it runs low.</p>
        </div>
        <ExplorerLink href={explorerAddress(t.address)} className="shrink-0 font-mono text-xs sm:mt-0.5">
          {shortAddress(t.address)}
        </ExplorerLink>
      </div>
      <dl className="grid grid-cols-2 gap-2 px-4 sm:grid-cols-4 sm:px-5">
        <Stat label="Balance" value={mon(t.balanceMon)} hint={`floor ${mon(t.floorMon)}`} />
        <Stat label="Spendable" value={mon(t.spendableMon)} hint="above the floor" />
        <Stat label="Burn" value={t.burnPerDayMon === null ? "-" : `${mon(t.burnPerDayMon)}`} hint={t.burnPerDayMon === null ? "needs a day of history" : "per day"} />
        <Stat label="Runway" value={t.runwayDays === null ? "-" : `${t.runwayDays.toFixed(t.runwayDays < 10 ? 1 : 0)} days`} hint={t.runwayDays === null ? "after a day of burn" : "at that burn"} tone={tone} />
      </dl>
      {t.targets.length > 0 ? (
        <div className="mt-4 border-t border-line">
          <div className="hidden grid-cols-[minmax(0,1fr)_minmax(0,1.3fr)_minmax(0,1.2fr)_5.5rem] gap-4 px-5 py-2.5 text-xs font-medium text-subtle md:grid">
            <span>Wallet</span>
            <span>Balance</span>
            <span>Last refill</span>
            <span className="text-right">State</span>
          </div>
          <ul className="divide-y divide-line md:border-t md:border-line">
            {t.targets.map((g) => (
              <TargetRow key={g.name} target={g} now={now} />
            ))}
          </ul>
        </div>
      ) : (
        <div className="h-4" />
      )}
    </section>
  );
}

const STATE_TONE: Record<string, Tone> = { ok: "ok", due: "warn", capped: "warn", halted: "bad", failing: "bad" };

function TargetRow({ target: g, now }: { target: TopupTarget; now: number }) {
  const balance = Number(g.balanceMon);
  const min = Number(g.minMon);
  const target = Number(g.targetMon);
  const fill = target > 0 ? Math.min(1, Math.max(0, balance / target)) : 0;
  const low = balance < min;
  const last = g.lastTransfer;
  return (
    <li data-testid="topup-target" data-name={g.name} className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-4 gap-y-2 px-4 py-3 text-[13px] sm:px-5 md:grid-cols-[minmax(0,1fr)_minmax(0,1.3fr)_minmax(0,1.2fr)_5.5rem]">
      <div className="min-w-0">
        <p className="truncate font-medium text-fg">{g.name}</p>
        <span className="flex flex-wrap items-baseline gap-x-2">
          <ExplorerLink href={explorerAddress(g.address)} className="font-mono text-xs">
            {shortAddress(g.address)}
          </ExplorerLink>
          {g.burnPerDayMon ? <span className="text-xs tabular-nums text-subtle">burns {mon(g.burnPerDayMon)}/day</span> : null}
        </span>
      </div>
      <div className="order-last col-span-2 min-w-0 md:order-none md:col-span-1">
        <div className="flex items-baseline justify-between gap-2">
          <span className={`tabular-nums ${low ? "text-bad" : "text-fg"}`}>{mon(g.balanceMon)}</span>
          <span className="text-xs tabular-nums text-subtle">
            min {Number(g.minMon).toLocaleString("en-US")} · target {Number(g.targetMon).toLocaleString("en-US")}
          </span>
        </div>
        <div className="relative mt-1.5 h-1.5 overflow-hidden rounded-full bg-raised ring-1 ring-line ring-inset" aria-hidden>
          <span className={`block h-full rounded-full ${low ? "bg-bad" : "bg-accent"}`} style={{ width: `${fill * 100}%` }} />
          {target > 0 ? <span className="absolute inset-y-0 w-px bg-line-strong" style={{ left: `${Math.min(100, (min / target) * 100)}%` }} /> : null}
        </div>
      </div>
      <div className="order-last col-span-2 min-w-0 text-xs text-muted md:order-none md:col-span-1">
        {last ? (
          <span className="inline-flex flex-wrap items-center gap-x-1.5">
            <span className="tabular-nums text-fg">{mon(last.amountMon)}</span>
            <time dateTime={new Date(last.at).toISOString()} title={formatDate(last.at)}>
              {formatAge(last.at, now)}
            </time>
            {last.status !== "confirmed" ? <span className="text-warn">{last.status}</span> : null}
            {last.hash ? (
              <ExplorerLink href={explorerTx(last.hash)} short className="text-xs" />
            ) : null}
          </span>
        ) : (
          <span className="text-subtle">none yet</span>
        )}
      </div>
      <div className="text-right">
        <Badge tone={STATE_TONE[g.state] ?? "neutral"}>{g.state}</Badge>
      </div>
    </li>
  );
}
