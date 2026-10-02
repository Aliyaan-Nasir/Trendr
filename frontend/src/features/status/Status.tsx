"use client";
import { Activity, Blocks, Radio } from "lucide-react";
import type { ReactNode } from "react";
import { Badge, Card, cn, ErrorNote, RefreshIcon, Skeleton, XLink } from "@/components/ui";
import type { SystemStatus } from "@/lib/api";
import { useHead } from "@/lib/chain/client";
import { IS_MAINNET } from "@/lib/config";
import { integer } from "@/lib/format";
import { useTrends } from "@/lib/hooks/queries";
import { useNow } from "@/features/portfolio/parts";
import { serviceInfo, useStatusPage } from "./data";

/** Seconds as "8s", "4m 12s" or "3h 5m". */
function age(sec: number): string {
  const s = Math.max(0, Math.round(sec));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${s % 60}s`;
  return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
}

/** Public system status: every service, the oracle and the chain, refreshed every ten seconds. */
export default function Status() {
  const status = useStatusPage();
  const now = useNow();
  const s = status.data;
  // Ages are as of the check; keep them ticking until the next one.
  const since = s ? Math.max(0, now / 1000 - s.at) : 0;
  return (
    <div className="flex flex-col gap-6 lg:gap-8">
      <header className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div className="min-w-0">
          <h1 className="font-display text-[30px] leading-[1.1] text-text sm:text-[36px]">System status</h1>
          <p className="mt-2 max-w-2xl text-[14px] leading-[22px] text-text-2">The live health of everything behind Trendr, checked every ten seconds.</p>
        </div>
        <div className="flex items-center gap-2 self-start sm:self-auto">
          <button
            type="button"
            onClick={() => void status.refetch()}
            disabled={status.isFetching}
            className="flex h-8 items-center gap-2 rounded-full border border-line bg-surface px-3 text-[12.5px] text-text-2 transition-colors hover:border-line-strong hover:text-text disabled:cursor-default"
            data-testid="status-refresh"
          >
            <RefreshIcon spinning={status.isFetching} className="size-3.5" />
            {s ? <span className="num">Checked {age(since)} ago</span> : "Checking"}
          </button>
          {/* Trendr on X. Phones have no sidebar, and their status pill leads here. */}
          <XLink className="flex size-8 items-center justify-center rounded-full border border-line bg-surface text-text-2 transition-colors hover:border-line-strong hover:text-text" iconClassName="size-3" testId="status-x" />
        </div>
      </header>

      {status.isLoading ? <StatusSkeleton /> : null}
      {status.error && !s ? <ErrorNote message={`${status.error.message} The status of the services cannot be checked right now.`} onRetry={() => void status.refetch()} /> : null}
      {s ? (
        <>
          <Overall s={s} since={since} stale={status.isError} />
          <div className="grid gap-4 lg:grid-cols-2">
            <OracleCard s={s} since={since} />
            <ChainCard s={s} since={since} />
          </div>
          <ServicesCard s={s} />
        </>
      ) : null}
    </div>
  );
}

function Dot({ ok, pulse }: { ok: boolean; pulse?: boolean }) {
  return <span className={cn("inline-block size-2.5 shrink-0 rounded-full", ok ? "bg-up" : "bg-down", pulse && ok && "live-dot")} aria-hidden />;
}

function StateBadge({ ok, testId }: { ok: boolean; testId?: string }) {
  return (
    <Badge tone={ok ? "up" : "down"} className="min-w-[52px] justify-center">
      <span data-testid={testId} data-ok={ok}>
        {ok ? "Up" : "Down"}
      </span>
    </Badge>
  );
}

function Overall({ s, since, stale }: { s: SystemStatus; since: number; stale: boolean }) {
  const down = [...s.services.filter((x) => !x.ok).map((x) => serviceInfo(x.name).label), ...(s.oracle.ok ? [] : ["the attention oracle"]), ...(s.chain.ok ? [] : ["the chain head"])];
  const lastRun = s.oracle.lastRunAgeSec === null ? null : s.oracle.lastRunAgeSec + since;
  return (
    <section aria-label="Overall status" className="relative overflow-hidden rounded-[24px] border border-line bg-surface px-5 py-6 sm:px-8 sm:py-7" data-testid="status-overall" data-ok={s.ok}>
      <div aria-hidden className={cn("pointer-events-none absolute -right-24 -top-28 size-72 rounded-full blur-3xl", s.ok ? "bg-up-soft" : "bg-warn-soft")} />
      <div className="relative flex items-center gap-3">
        <span className={cn("flex size-10 items-center justify-center rounded-full", s.ok ? "bg-up-soft text-up" : "bg-warn-soft text-warn")}>
          <Activity className="size-5" aria-hidden />
        </span>
        <p className="font-display text-[28px] leading-tight text-text sm:text-[34px]">{s.ok ? "All systems live" : "Some systems need attention"}</p>
      </div>
      <p className="relative mt-3 max-w-2xl text-[14px] leading-[22px] text-text-2">
        {s.ok
          ? `Every service answered, the oracle measured attention ${lastRun === null ? "recently" : `${age(lastRun)} ago`} and Monad is producing blocks.`
          : `${down.length === 1 ? "One part is" : `${down.length} parts are`} not answering: ${down.join(", ")}. Positions and funds stay safe on chain; actions that need ${down.length === 1 ? "it" : "them"} wait until ${down.length === 1 ? "it is" : "they are"} back.`}
      </p>
      {stale ? <p className="relative mt-2 text-[12.5px] text-warn">The last check failed; showing the previous result.</p> : null}
    </section>
  );
}

function Fact({ label, value, tone, testId }: { label: string; value: ReactNode; tone?: "up" | "down" | "warn"; testId?: string }) {
  return (
    <div className="flex items-center justify-between gap-3 text-[13.5px]">
      <span className="text-text-2">{label}</span>
      <span className={cn("num text-right font-strong", tone === "up" ? "text-up" : tone === "down" ? "text-down" : tone === "warn" ? "text-warn" : "text-text")} data-testid={testId}>
        {value}
      </span>
    </div>
  );
}

function OracleCard({ s, since }: { s: SystemStatus; since: number }) {
  const trends = useTrends();
  const lastRun = s.oracle.lastRunAgeSec === null ? null : s.oracle.lastRunAgeSec + since;
  const live = trends.data?.trends.length;
  return (
    <Card className="flex flex-col gap-4 p-5 sm:p-6" data-testid="status-oracle">
      <div className="flex items-start justify-between gap-3">
        <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1.5">
          <span className="flex items-center gap-2.5">
            <Radio className="size-[18px] text-primary" aria-hidden />
            <h2 className="whitespace-nowrap font-strong text-[15px] text-text">Attention oracle</h2>
          </span>
          <Badge tone="primary">Chainlink CRE</Badge>
        </div>
        <StateBadge ok={s.oracle.ok} testId="oracle-state" />
      </div>
      <div>
        <p className="text-[11.5px] uppercase tracking-[0.08em] text-text-3">Last measurement</p>
        <p className="num-display mt-1 font-display text-[40px] leading-none text-text" data-testid="oracle-age">
          {lastRun === null ? "Never" : `${age(lastRun)} ago`}
        </p>
      </div>
      <div className="flex flex-col gap-2 border-t border-line pt-4">
        <Fact label="Live trends" value={live === undefined ? "..." : integer(live)} testId="live-trends" />
        <Fact label="Trends behind on measurements" value={integer(s.oracle.staleTrends)} tone={s.oracle.staleTrends > 0 ? "warn" : undefined} testId="stale-trends" />
      </div>
      <p className="text-[13px] leading-5 text-text-2">A Chainlink CRE workflow measures attention on X, Telegram, Bluesky, news, Wikipedia, Hacker News and smart-money flows every minute and writes each trend&rsquo;s index on chain. Perps trade at it, and every Up or down series settles on it.</p>
    </Card>
  );
}

function ChainCard({ s, since }: { s: SystemStatus; since: number }) {
  const head = useHead();
  const checked = s.chain.number === null ? null : Number(s.chain.number);
  const shown = head ? Number(head.number) : checked;
  return (
    <Card className="flex flex-col gap-4 p-5 sm:p-6" data-testid="status-chain">
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-center gap-2.5">
          <Blocks className="size-[18px] text-primary" aria-hidden />
          <h2 className="font-strong text-[15px] text-text">{IS_MAINNET ? "Monad" : "Monad Testnet"}</h2>
        </div>
        <StateBadge ok={s.chain.ok} testId="chain-state" />
      </div>
      <div>
        <p className="flex items-center gap-2 text-[11.5px] uppercase tracking-[0.08em] text-text-3">
          {head ? <Dot ok pulse /> : null}
          {head ? "Head, live" : "Head at the last check"}
        </p>
        <p className="num-display mt-1 font-display text-[40px] leading-none text-text" data-testid="chain-head">
          {shown === null ? "-" : integer(shown)}
        </p>
      </div>
      <div className="flex flex-col gap-2 border-t border-line pt-4">
        <Fact label="Head age at the check" value={s.chain.ageSec === null ? "-" : age(s.chain.ageSec + since)} tone={s.chain.ok ? undefined : "down"} />
        <Fact label="Your browser's view" value={head ? `${head.stage} block` : "Connecting"} tone={head ? undefined : "warn"} />
      </div>
      <p className="text-[13px] leading-5 text-text-2">Monad makes a block every 400 ms and finalizes it about a second later. The app shows a trade as filled at the first stage and final once its block is two blocks behind the head.</p>
    </Card>
  );
}

function ServicesCard({ s }: { s: SystemStatus }) {
  return (
    <Card className="overflow-hidden" data-testid="status-services">
      <div className="px-5 pb-4 pt-5 sm:px-6">
        <h2 className="font-strong text-[15px] text-text">Services</h2>
        <p className="mt-0.5 text-[13px] text-text-2">Each one&rsquo;s health endpoint, as Trendr&rsquo;s API reaches it.</p>
      </div>
      <ul className="divide-y divide-line border-t border-line">
        {s.services.map((x) => {
          const info = serviceInfo(x.name);
          return (
            <li key={x.name} className="flex flex-col gap-2 px-5 py-4 sm:flex-row sm:items-start sm:gap-6 sm:px-6" data-testid="status-service" data-name={x.name} data-ok={x.ok}>
              <div className="flex items-center justify-between gap-3 sm:w-[180px] sm:shrink-0 sm:justify-start">
                <span className="flex items-center gap-2.5 font-strong text-[14px] text-text">
                  <Dot ok={x.ok} />
                  {info.label}
                </span>
                <span className="num text-[12.5px] text-text-3 sm:hidden">{x.ok && x.latencyMs !== null ? `${x.latencyMs} ms` : x.ok ? "" : "no answer"}</span>
              </div>
              <p className="min-w-0 flex-1 text-[13px] leading-5 text-text-2">{info.body}</p>
              <div className="hidden shrink-0 items-center gap-3 sm:flex">
                <span className="num w-[64px] text-right text-[12.5px] text-text-3">{x.ok && x.latencyMs !== null ? `${x.latencyMs} ms` : x.ok ? "" : "no answer"}</span>
                <StateBadge ok={x.ok} />
              </div>
            </li>
          );
        })}
      </ul>
    </Card>
  );
}

function StatusSkeleton() {
  return (
    <div className="flex flex-col gap-6" aria-hidden>
      <Skeleton className="h-[148px] rounded-[24px]" />
      <div className="grid gap-4 lg:grid-cols-2">
        <Skeleton className="h-[300px] rounded-[18px]" />
        <Skeleton className="h-[300px] rounded-[18px]" />
      </div>
      <Skeleton className="h-[320px] rounded-[18px]" />
    </div>
  );
}
