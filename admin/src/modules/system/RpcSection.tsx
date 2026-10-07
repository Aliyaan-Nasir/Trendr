import { formatNumber } from "@/src/lib/format";
import type { GatewayProvider, RpcEndpoint, SystemReport } from "@/src/types/admin";
import { serviceMeta } from "@/src/modules/operations/Services";
import { Age, compact, ErrorText, Meter, StateChip } from "./parts";
import { Line, SortableTable } from "./Table";

const health = (p: GatewayProvider) => (p.reserve && p.healthy ? "reserve" : p.healthy ? "healthy" : "unhealthy");
const failures = (p: GatewayProvider) => p.errors + p.rateLimited + p.timeouts + p.refused;

/** The gateway labels a keyed endpoint "host..abcd": the host, then its key's last four characters. */
function Name({ p }: { p: GatewayProvider }) {
  const at = p.provider.lastIndexOf("..");
  const host = at > 0 ? p.provider.slice(0, at) : p.provider;
  const key = at > 0 ? p.provider.slice(at + 2) : null;
  return (
    <div className="min-w-0 font-mono text-xs" title={p.provider}>
      <p className="text-fg [overflow-wrap:anywhere]">{host}</p>
      {key ? <p className="mt-0.5 text-subtle">key ...{key}</p> : null}
    </div>
  );
}

function Failures({ p }: { p: GatewayProvider }) {
  const parts = [
    [p.errors, "errors"],
    [p.rateLimited, "429s"],
    [p.timeouts, "timeouts"],
    [p.refused, "refused"],
  ].filter(([n]) => (n as number) > 0) as Array<[number, string]>;
  if (parts.length === 0) return <span className="text-subtle">none</span>;
  // A 429 is the provider pacing us, not a failure of the provider: amber, the rest red.
  return (
    <span>
      {parts.map(([n, what], i) => (
        <span key={what} className={what === "429s" ? "text-warn" : "text-bad"}>
          {i > 0 ? ", " : ""}
          {formatNumber(n)} {what}
        </span>
      ))}
    </span>
  );
}

function Budget({ p }: { p: GatewayProvider }) {
  if (p.monthlyUnits === null) return <span className="text-subtle">no monthly cap</span>;
  if (p.budgetPct === null) return <span className="text-subtle">projection after 10 min</span>;
  const tone = p.budgetPct > 100 ? "bad" : p.budgetPct > 80 ? "warn" : "ok";
  return (
    <div className="ml-auto w-full max-w-48">
      <p className="tabular-nums">
        <span className={tone === "bad" ? "text-bad" : tone === "warn" ? "text-warn" : "text-fg"}>{p.budgetPct.toLocaleString("en-US", { maximumFractionDigits: 1 })}%</span>
        <span className="text-subtle">
          {" "}
          of {compact(p.monthlyUnits)}/mo
        </span>
      </p>
      <div className="mt-1">
        <Meter pct={p.budgetPct} tone={tone} label={`${p.provider} projected share of its monthly units`} />
      </div>
      <p className="mt-1 whitespace-nowrap text-xs tabular-nums text-subtle">
        {compact(p.units)} so far · {compact(p.projectedMonthUnits ?? 0)}/mo pace
      </p>
    </div>
  );
}

function LastError({ p, now }: { p: GatewayProvider; now: number }) {
  if (!p.lastError) return <span className="text-subtle">none</span>;
  return (
    <ErrorText current={!p.healthy}>
      {p.lastError} <span className="font-sans text-subtle">(<Age at={p.lastErrorAt} now={now} />)</span>
    </ErrorText>
  );
}

/** Each service's own RPC endpoints, by provider. */
function ServiceEndpoints({ services }: { services: Array<{ service: string; endpoints: RpcEndpoint[] }> }) {
  if (services.length === 0) return null;
  return (
    <div className="mt-4 overflow-hidden rounded-xl border border-line bg-surface shadow-card" data-testid="service-rpc">
      <p className="border-b border-line px-4 py-2.5 text-xs font-medium text-subtle sm:px-5">Each service&rsquo;s own endpoints (since it started)</p>
      <ul className="divide-y divide-line">
        {services.map((s) => (
          <li key={s.service} className="flex flex-col gap-2 px-4 py-3 text-[13px] sm:flex-row sm:items-start sm:gap-4 sm:px-5" data-testid="service-rpc-row" data-service={s.service}>
            <p className="w-40 shrink-0 font-medium text-fg">{serviceMeta(s.service).title}</p>
            <ul className="flex min-w-0 flex-wrap gap-1.5">
              {s.endpoints.map((e, i) => (
                <li key={`${e.provider}-${i}`} className={`inline-flex items-center gap-1.5 rounded-md border px-2 py-0.5 text-xs ${e.healthy ? "border-line bg-raised text-muted" : "border-transparent bg-bad-soft text-bad"}`}>
                  <span className="font-mono text-fg">{e.provider}</span>
                  <span className="tabular-nums">{compact(e.requests)} req</span>
                  {e.failures > 0 ? <span className="tabular-nums text-bad">{compact(e.failures)} failed</span> : null}
                  <span className={e.healthy ? "text-ok" : "text-bad"}>{e.healthy ? "healthy" : "failing"}</span>
                </li>
              ))}
            </ul>
          </li>
        ))}
      </ul>
    </div>
  );
}

export function RpcSection({ rpc, now }: { rpc: SystemReport["rpc"]; now: number }) {
  const gateway = rpc.gateway;
  return (
    <div>
      {gateway ? (
        <>
          <p className="mb-3 text-[13px] text-muted">
            The gateway has run for {gateway.uptimeSec !== null ? formatUptime(gateway.uptimeSec) : "?"}, at {gateway.receivedPerSec?.toFixed(1) ?? "?"} requests a second from its clients and {gateway.upstreamPerSec?.toFixed(1) ?? "?"} upstream
            {Object.keys(gateway.clients).length > 0 ? ` (${Object.entries(gateway.clients).sort((a, b) => b[1] - a[1]).map(([c, n]) => `${c} ${compact(n)}`).join(", ")})` : ""}.
          </p>
          <SortableTable
            label="RPC gateway providers"
            testId="rpc-providers"
            rowTestId="rpc-provider"
            rows={gateway.providers}
            rowKey={(p) => p.provider}
            initialSort={{ key: "health", dir: "asc" }}
            columns={[
              { key: "provider", label: "Provider", className: "w-[26%]", sort: (p) => p.provider, render: (p) => <Name p={p} /> },
              { key: "health", label: "Health", className: "w-[10%]", sort: (p) => (p.healthy ? (p.reserve ? 2 : 1) : 0), render: (p) => <StateChip state={health(p)} /> },
              {
                key: "requests",
                label: "Requests",
                align: "right",
                className: "w-[10%]",
                sort: (p) => p.requests,
                render: (p) => (
                  <>
                    {formatNumber(p.requests)}
                    <p className="text-xs text-subtle">{p.avgLatencyMs !== null ? `${p.avgLatencyMs} ms avg` : ""}</p>
                  </>
                ),
              },
              { key: "failures", label: "Failures", align: "right", className: "w-[11%]", sort: failures, render: (p) => <Failures p={p} /> },
              { key: "budget", label: "Monthly units", align: "right", className: "w-[21%]", sort: (p) => p.budgetPct, render: (p) => <Budget p={p} /> },
              { key: "error", label: "Last error", sort: (p) => (p.lastErrorAt === null ? null : -p.lastErrorAt), render: (p) => <LastError p={p} now={now} /> },
            ]}
            mobile={(p) => (
              <div>
                <div className="flex items-start justify-between gap-3">
                  <Name p={p} />
                  <StateChip state={health(p)} />
                </div>
                <div className="mt-2">
                  <Line label="Requests">{formatNumber(p.requests)}</Line>
                  <Line label="Failures">
                    <Failures p={p} />
                  </Line>
                  <Line label="Monthly units">{p.budgetPct === null ? <span className="text-subtle">{p.monthlyUnits === null ? "no cap" : "later"}</span> : `${p.budgetPct}% at this pace`}</Line>
                </div>
                {p.lastError ? <LastError p={p} now={now} /> : null}
              </div>
            )}
          />
        </>
      ) : (
        <p className="rounded-xl border border-dashed border-line-strong px-4 py-8 text-center text-sm text-muted">No RPC gateway answered. A service whose health lists its RPC providers shows them here.</p>
      )}
      <ServiceEndpoints services={rpc.services} />
    </div>
  );
}

function formatUptime(sec: number): string {
  if (sec < 3600) return `${Math.round(sec / 60)} minutes`;
  if (sec < 172_800) return `${(sec / 3600).toFixed(1)} hours`;
  return `${Math.round(sec / 86_400)} days`;
}
