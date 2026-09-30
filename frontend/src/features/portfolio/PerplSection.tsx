"use client";
import { useQuery } from "@tanstack/react-query";
import { worstPrice } from "@trendr/perpl";
import { Bot, Users } from "lucide-react";
import Link from "next/link";
import { AnimatePresence, m } from "framer-motion";
import { useState } from "react";
import { Badge, Button, listItem, Row, Sheet, TxStatus } from "@/components/ui";
import { useAccount } from "@/lib/account/AccountProvider";
import { perplApi } from "@/lib/api";
import { ausd, price } from "@/lib/format";
import { perpl as perplCalls } from "@/lib/trade/calls";
import { useTx } from "@/lib/trade/useTx";
import { useRefreshPortfolio } from "./hooks";
import { Figure, SectionCard, SignedAusd, signedAusd, SignedPct, toneOf } from "./parts";
import type { PerplPosition } from "./reads";

/** Close orders accept up to 1% worse than the touch. */
const SLIPPAGE_BPS = 100;

export type PerplLabel = "autopilot" | "copy" | null;

/** Perpl perpetuals held in the account's own Perpl account, labelled when Autopilot or copy trading runs them. */
export function PerplSection({ positions, balance, labels, total }: { positions: PerplPosition[]; balance: number; labels: Map<number, PerplLabel>; total: number }) {
  const [closing, setClosing] = useState<PerplPosition | null>(null);
  return (
    <>
      {positions.length > 0 || balance >= 0.005 ? (
        <SectionCard
          id="perpl-title"
          testId="perpl-section"
          title="Perpl perps"
          count={positions.length}
          subtitle={positions.length > 0 ? `Perpetuals on the assets behind the trends.${balance > 0.005 ? ` ${ausd(balance)} AUSD is free in your Perpl account.` : ""}` : `${ausd(balance)} AUSD free in your Perpl account, no open positions.`}
          total={ausd(total)}
        >
          {positions.length > 0 ? (
            <ul className="relative divide-y divide-line border-t border-line">
              <AnimatePresence initial={false} mode="popLayout">
                {positions.map((p) => (
                  <m.li key={p.market.id} {...listItem}>
                    <PerplRow p={p} label={labels.get(p.market.id) ?? null} onClose={() => setClosing(p)} />
                  </m.li>
                ))}
              </AnimatePresence>
            </ul>
          ) : null}
        </SectionCard>
      ) : null}
      {/* The sheets stay mounted when the last row goes, so a finished trade keeps its result on screen. */}
      <ClosePerplSheet position={closing} onClose={() => setClosing(null)} />
    </>
  );
}

function PerplRow({ p, label, onClose }: { p: PerplPosition; label: PerplLabel; onClose: () => void }) {
  return (
    <div className="flex flex-col gap-3.5 px-4 py-4 sm:px-6" data-testid="perpl-row">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="font-strong text-[15px] leading-6 text-text">{p.market.symbol}</span>
            <Badge tone={p.side === "long" ? "up" : "down"}>
              {p.side === "long" ? "Long" : "Short"} <span className="num">{p.leverage.toFixed(1)}x</span>
            </Badge>
            {label === "autopilot" ? (
              <Badge tone="primary" icon={<Bot className="size-3" aria-hidden />}>
                Autopilot
              </Badge>
            ) : label === "copy" ? (
              <Badge tone="accent" icon={<Users className="size-3" aria-hidden />}>
                Copy trading
              </Badge>
            ) : null}
          </div>
          <p className="num mt-1 text-[12.5px] leading-5 text-text-2">
            {p.size} {p.market.symbol} <span className="text-text-3">· entry</span> {price(p.entryPrice)} <span className="text-text-3">· mark</span> {p.markPrice === null ? "-" : price(p.markPrice)}
          </p>
        </div>
        <div className="shrink-0 text-right">
          <p className={`num font-strong text-[15px] leading-6 ${toneOf(p.pnl)}`}>
            <SignedAusd value={p.pnl} />
          </p>
          <p className={`num text-[11.5px] ${toneOf(p.pnl)}`}>
            <SignedPct value={p.pnlPct} />
          </p>
        </div>
      </div>
      <div className="grid grid-cols-2 items-center gap-x-4 gap-y-3 rounded-xl bg-surface-2/70 px-3 py-2.5 sm:grid-cols-[repeat(4,minmax(0,1fr))_auto]">
        <Figure label="Margin">{ausd(p.marginAusd)}</Figure>
        <Figure label="Size">{ausd(p.notional)}</Figure>
        <Figure label="Entry">{price(p.entryPrice)}</Figure>
        <Figure label="Mark">{p.markPrice === null ? "-" : price(p.markPrice)}</Figure>
        {label === "autopilot" ? null : (
          <div className="col-span-2 flex sm:col-span-1">
            <Button size="sm" tone="secondary" onClick={onClose} className="flex-1 sm:flex-none" data-testid="close-perpl">
              Close
            </Button>
          </div>
        )}
      </div>
      {label === "autopilot" ? (
        <p className="text-[12.5px] leading-5 text-text-3">
          An Autopilot rule runs this position and closes it on its own exit. To step in,{" "}
          <Link href="/autopilot" className="text-text-2 underline-offset-4 hover:text-text hover:underline">
            pause the rule
          </Link>
          .
        </p>
      ) : null}
    </div>
  );
}

function ClosePerplSheet({ position, onClose }: { position: PerplPosition | null; onClose: () => void }) {
  const [last, setLast] = useState(position);
  if (position !== null && position !== last) setLast(position);
  const p = position ?? last;
  return (
    <Sheet open={position !== null} onOpenChange={(o) => !o && onClose()} title="Close on Perpl" description={p ? `${p.market.symbol} ${p.side}, ${p.size} ${p.market.symbol}` : undefined} testId="close-perpl-sheet">
      {p ? <ClosePerplBody key={p.market.id} p={p} onDone={onClose} /> : null}
    </Sheet>
  );
}

function ClosePerplBody({ p, onDone }: { p: PerplPosition; onDone: () => void }) {
  const account = useAccount();
  const refresh = useRefreshPortfolio();
  const tx = useTx();
  const ticker = useQuery({ queryKey: ["perpl-ticker", p.market.id], refetchInterval: 2_000, queryFn: async () => (await perplApi.ticker(p.market.id)).ticker });
  // A long closes by selling into the bid, a short by buying the ask.
  const touch = ticker.data ? (p.side === "long" ? ticker.data.bid : ticker.data.ask) : null;
  const worst = touch ? worstPrice(p.side === "long" ? "short" : "long", touch, SLIPPAGE_BPS) : null;
  const pnlAtTouch = touch ? (touch - p.entryPrice) * p.size * (p.side === "long" ? 1 : -1) : null;
  const done = tx.stage === "filled" || tx.stage === "final";

  const close = async () => {
    if (!worst) return;
    const r = await tx.run(async () => {
      // Perpl order ids are small and sequential per account; the backend hands out the next one.
      const requestId = await perplApi.requestId();
      return account.trade(perplCalls.close(p.market, requestId, p.side, p.size, worst));
    }, { action: `Close ${p.side} ${p.market.symbol}`, done: `${p.side === "long" ? "Long" : "Short"} ${p.market.symbol} closed` });
    if (r) refresh();
  };

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-col gap-2.5 rounded-2xl border border-line p-4">
        <Row label={p.side === "long" ? "Best bid" : "Best ask"} value={touch ? price(touch) : ticker.isError ? "Unavailable" : "..."} />
        <Row label="Entry" value={price(p.entryPrice)} tone="muted" />
        <Row label="PnL at this price" value={pnlAtTouch === null ? "-" : `${signedAusd(pnlAtTouch)} AUSD`} tone={pnlAtTouch === null ? undefined : pnlAtTouch > 0.005 ? "up" : pnlAtTouch < -0.005 ? "down" : undefined} />
        <Row label={`Fills only ${p.side === "long" ? "at or above" : "at or below"}`} value={worst ? price(worst) : "-"} tone="muted" />
      </div>
      {!account.backendReady ? <p className="rounded-xl bg-surface-2 px-3.5 py-2.5 text-[12.5px] leading-[18px] text-text-2">Connecting to Trendr to number the order. This takes a second after signing in.</p> : null}
      {done ? (
        <Button block size="lg" tone="secondary" onClick={onDone}>
          Done
        </Button>
      ) : (
        <Button block size="lg" onClick={close} loading={tx.busy} disabled={!worst || !account.backendReady} data-testid="confirm-close-perpl">
          Close {p.size} {p.market.symbol}
        </Button>
      )}
      <TxStatus tx={tx} filledLabel="Closed" testId="close-perpl-tx" />
    </div>
  );
}
