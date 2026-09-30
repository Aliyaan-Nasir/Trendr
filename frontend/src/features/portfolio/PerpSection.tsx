"use client";
import { useQuery } from "@tanstack/react-query";
import { attentionPerpAbi } from "@trendr/contracts";
import { AlertTriangle } from "lucide-react";
import Link from "next/link";
import { AnimatePresence, m } from "framer-motion";
import { useState } from "react";
import { decodeEventLog } from "viem";
import { Badge, Button, Field, listItem, Row, Sheet, TxStatus } from "@/components/ui";
import { ShareActions } from "@/features/share/ShareActions";
import { pnlSharePath } from "@/features/share/share";
import { useAccount } from "@/lib/account/AccountProvider";
import { publicClient } from "@/lib/chain/client";
import { DEPLOYMENT } from "@/lib/config";
import { ausd, points } from "@/lib/format";
import { useAusdBalance } from "@/lib/hooks/queries";
import { perp } from "@/lib/trade/calls";
import { useTx } from "@/lib/trade/useTx";
import { trendName } from "@/lib/trends";
import { useRefreshPortfolio } from "./hooks";
import { closeFee, liquidationAfterMargin, toAusd } from "./math";
import { amountText, Figure, parseAmount, SectionCard, SignedAusd, signedAusd, SignedPct, signedPct, toneOf } from "./parts";
import type { PerpHolding } from "./reads";

/** Acceptable exit: 1% worse than the index now. */
const SLIPPAGE = 0.01;
const nameOf = (p: PerpHolding) => (p.trend ? trendName(p.trend) : `${p.trendId.slice(0, 10)}...`);
const lev = (v: number) => `${v.toFixed(v >= 10 ? 0 : 1)}x`;

/** Attention perps: long or short a trend's index with isolated margin. */
export function PerpSection({ positions, total }: { positions: PerpHolding[]; total: number }) {
  const [closing, setClosing] = useState<PerpHolding | null>(null);
  const [topping, setTopping] = useState<PerpHolding | null>(null);
  return (
    <>
      {positions.length > 0 ? (
        <SectionCard id="perps-title" testId="perp-section" title="Attention perps" count={positions.length} subtitle="Long or short a trend's attention index, settled in AUSD. Each position keeps its own margin." total={ausd(total)} totalLabel="Equity">
          <ul className="relative divide-y divide-line border-t border-line">
            <AnimatePresence initial={false} mode="popLayout">
              {positions.map((p) => (
                <m.li key={p.id.toString()} {...listItem}>
                  <PerpRow p={p} onClose={() => setClosing(p)} onAddMargin={() => setTopping(p)} />
                </m.li>
              ))}
            </AnimatePresence>
          </ul>
        </SectionCard>
      ) : null}
      {/* The sheets stay mounted when the last row goes, so a finished trade keeps its result on screen. */}
      <ClosePerpSheet position={closing} onClose={() => setClosing(null)} />
      <AddMarginSheet position={topping} onClose={() => setTopping(null)} />
    </>
  );
}

function PerpRow({ p, onClose, onAddMargin }: { p: PerpHolding; onClose: () => void; onAddMargin: () => void }) {
  const move = p.entryIndex > 0 ? ((p.index - p.entryIndex) / p.entryIndex) * 100 : 0;
  const distance = p.liquidationIndex !== null && p.index > 0 ? Math.abs(p.index - p.liquidationIndex) / p.index : null;
  const near = !p.liquidatable && distance !== null && distance < 0.1;
  return (
    <div className="flex flex-col gap-3.5 px-4 py-4 sm:px-6" data-testid="perp-row" data-position={p.id.toString()}>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-1.5">
            {p.trend ? (
              <Link href={`/t/${p.trend.identifier}`} className="truncate font-strong text-[15px] leading-6 text-text underline-offset-4 hover:underline">
                {nameOf(p)}
              </Link>
            ) : (
              <span className="truncate font-strong text-[15px] leading-6 text-text">{nameOf(p)}</span>
            )}
            <Badge tone={p.isLong ? "up" : "down"}>
              {p.isLong ? "Long" : "Short"} <span className="num">{lev(p.leverage)}</span>
            </Badge>
            {p.retired ? <Badge>Trend retired</Badge> : p.liquidatable ? <Badge tone="down">Liquidatable</Badge> : near ? <Badge tone="warn">Near liquidation</Badge> : null}
          </div>
          <p className="num mt-1 text-[12.5px] leading-5 text-text-2">
            Entry {points(p.entryIndex)} <span className="text-text-3">· now</span> {points(p.index)} <span className={toneOf(move * (p.isLong ? 1 : -1))}>({signedPct(move)})</span>
          </p>
        </div>
        <div className="shrink-0 text-right">
          <p className={`num font-strong text-[15px] leading-6 ${toneOf(p.pnl)}`}>
            <SignedAusd value={p.pnl} testId="perp-pnl" />
          </p>
          <p className={`num text-[11.5px] ${toneOf(p.pnl)}`}>
            <SignedPct value={p.pnlPct} />
          </p>
        </div>
      </div>
      <div className="grid grid-cols-2 items-center gap-x-4 gap-y-3 rounded-xl bg-surface-2/70 px-3 py-2.5 sm:grid-cols-[repeat(4,minmax(0,1fr))_auto]">
        <Figure label="Margin">{ausd(toAusd(p.margin))}</Figure>
        <Figure label="Equity">{ausd(toAusd(p.equity))}</Figure>
        <Figure label="Size">{ausd(p.notional)}</Figure>
        <Figure label="Liquidation">
          <span className={p.liquidatable ? "text-down" : near ? "text-warn" : undefined}>{p.liquidationIndex === null ? "None" : points(p.liquidationIndex)}</span>
        </Figure>
        {p.retired ? null : (
          <div className="col-span-2 flex gap-2 sm:col-span-1">
            <Button size="sm" tone="secondary" onClick={onAddMargin} className="flex-1 sm:flex-none" data-testid="add-margin">
              Add margin
            </Button>
            <Button size="sm" tone="secondary" onClick={onClose} className="flex-1 sm:flex-none" data-testid="close-perp">
              Close
            </Button>
          </div>
        )}
      </div>
      {p.liquidatable ? (
        <p className="flex items-start gap-2 rounded-xl bg-down-soft px-3.5 py-2.5 text-[12.5px] leading-[18px] text-text">
          <AlertTriangle className="mt-px size-4 shrink-0 text-down" aria-hidden />
          Equity is below the 10% maintenance margin: anyone can liquidate this position now. Add margin or close it.
        </p>
      ) : null}
      {p.retired ? <p className="text-[12.5px] leading-5 text-text-3">The oracle stopped measuring this trend. The position settles at the final index, with no fee, and the payout reaches your account automatically.</p> : null}
    </div>
  );
}

/** Keeps the last value while a sheet animates out. */
function useSticky<T>(v: T | null): T | null {
  const [last, setLast] = useState(v);
  if (v !== null && v !== last) setLast(v);
  return v ?? last;
}

interface Closed {
  exitIndex: number;
  /** Net of funding and the closing fee. */
  pnl: number;
  payout: number;
}

function ClosePerpSheet({ position, onClose }: { position: PerpHolding | null; onClose: () => void }) {
  const p = useSticky(position);
  return (
    <Sheet open={position !== null} onOpenChange={(o) => !o && onClose()} title="Close position" description={p ? `${nameOf(p)} · ${p.isLong ? "long" : "short"} ${lev(p.leverage)}` : undefined} testId="close-perp-sheet">
      {p ? <ClosePerpBody key={p.id.toString()} p={p} onDone={onClose} /> : null}
    </Sheet>
  );
}

function ClosePerpBody({ p, onDone }: { p: PerpHolding; onDone: () => void }) {
  const account = useAccount();
  const refresh = useRefreshPortfolio();
  const tx = useTx();
  const fee = closeFee(p.notional);
  const equity = toAusd(p.equity);
  const expected = Math.max(0, equity - fee);
  const margin = toAusd(p.margin);
  // The opening fee left the account before the margin was booked: 0.1% of the notional at entry.
  // Counting it here matches the trade history and the shared result.
  const openFee = closeFee(((Number(p.qty) * Number(p.unit)) / 1e18 / 1e6) * p.entryIndex);
  const pnlNow = expected - margin - openFee;
  const bound = p.isLong ? p.index * (1 - SLIPPAGE) : p.index * (1 + SLIPPAGE);
  const done = tx.stage === "filled" || tx.stage === "final";
  // The fill's own numbers, read from its PositionClosed event.
  const closed = useQuery({
    queryKey: ["perp-closed", tx.hash],
    enabled: done && Boolean(tx.hash),
    staleTime: Infinity,
    retry: 5,
    queryFn: async (): Promise<Closed | null> => {
      const receipt = await publicClient.getTransactionReceipt({ hash: tx.hash! });
      for (const log of receipt.logs) {
        if (log.address.toLowerCase() !== DEPLOYMENT.attentionPerp.toLowerCase()) continue;
        try {
          const e = decodeEventLog({ abi: attentionPerpAbi, data: log.data, topics: log.topics });
          if (e.eventName !== "PositionClosed") continue;
          const a = e.args as { exitIndex: bigint; pnl: bigint; funding: bigint; fee: bigint; payout: bigint };
          return { exitIndex: Number(a.exitIndex) / 1e6, pnl: Number(a.pnl - a.funding - a.fee) / 1e6, payout: Number(a.payout) / 1e6 };
        } catch {
          // Another event.
        }
      }
      return null;
    },
  });

  const close = async () => {
    const r = await tx.run(() => account.trade(perp.close(p.id, BigInt(Math.round(bound * 1e6)))), { action: `Close ${p.isLong ? "long" : "short"}`, done: `${p.isLong ? "Long" : "Short"} closed` });
    if (r) refresh();
  };

  const c = closed.data;
  const realized = c ? c.payout - margin - openFee : null;
  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-col gap-2.5 rounded-2xl border border-line p-4">
        <Row label="Index now" value={points(p.index)} />
        <Row label="Equity" value={`${ausd(equity)} AUSD`} />
        <Row label="Closing fee (0.1%)" value={`${ausd(fee)} AUSD`} tone="muted" />
        <Row label="You receive about" value={`${ausd(expected)} AUSD`} />
        <Row label="PnL after all fees" value={`${signedAusd(pnlNow)} AUSD`} tone={pnlNow > 0.005 ? "up" : pnlNow < -0.005 ? "down" : undefined} />
        <Row label={`Exits only ${p.isLong ? "at or above" : "at or below"}`} value={points(bound)} tone="muted" />
      </div>
      {done ? (
        <Button block size="lg" tone="secondary" onClick={onDone}>
          Done
        </Button>
      ) : (
        <Button block size="lg" onClick={close} loading={tx.busy} data-testid="confirm-close-perp">
          Close position
        </Button>
      )}
      <TxStatus tx={tx} filledLabel="Closed" testId="close-perp-tx" />
      {done && c ? (
        <div className="flex flex-col gap-3 rounded-2xl bg-surface-2 p-4" data-testid="perp-closed">
          <p className="text-[13px] leading-5 text-text-2">
            Closed at <span className="num text-text">{points(c.exitIndex)}</span>: <span className={`num font-strong ${toneOf(realized)}`}>{signedAusd(realized!)} AUSD</span> after fees and funding, with {ausd(c.payout)} AUSD back in your balance.
          </p>
          <ShareActions
            size="sm"
            text={`${signedAusd(realized!)} AUSD on ${nameOf(p)} attention, ${p.isLong ? "long" : "short"} on Trendr`}
            path={pnlSharePath({ kind: "attention", market: nameOf(p), side: p.isLong ? "long" : "short", pnl: realized!, roi: margin + openFee > 0 ? (realized! / (margin + openFee)) * 100 : null, entry: p.entryIndex, exit: c.exitIndex, leverage: p.leverage, tx: tx.hash, identifier: p.trend?.identifier ?? null })}
          />
        </div>
      ) : null}
    </div>
  );
}

function AddMarginSheet({ position, onClose }: { position: PerpHolding | null; onClose: () => void }) {
  const p = useSticky(position);
  return (
    <Sheet open={position !== null} onOpenChange={(o) => !o && onClose()} title="Add margin" description={p ? `${nameOf(p)} · moves the liquidation index away from the market` : undefined} testId="add-margin-sheet">
      {p ? <AddMarginBody key={p.id.toString()} p={p} onDone={onClose} /> : null}
    </Sheet>
  );
}

function AddMarginBody({ p, onDone }: { p: PerpHolding; onDone: () => void }) {
  const account = useAccount();
  const refresh = useRefreshPortfolio();
  const cash = useAusdBalance(account.address);
  const tx = useTx();
  const [text, setText] = useState("");
  const amount = parseAmount(text, 6);
  const tooMuch = amount !== null && cash.data !== undefined && amount > cash.data.raw;
  const liqAfter = amount ? liquidationAfterMargin(p, amount) : p.liquidationIndex;
  const marginAfter = toAusd(p.margin + (amount ?? 0n));
  const done = tx.stage === "filled" || tx.stage === "final";

  const add = async () => {
    if (!amount) return;
    const r = await tx.run(() => account.ownerExecute(perp.addMargin(p.id, amount)), { action: "Add margin", done: `Added ${ausd(toAusd(amount))} AUSD of margin` });
    if (r) refresh();
  };

  return (
    <div className="flex flex-col gap-5">
      <Field
        label="Amount"
        inputMode="decimal"
        autoComplete="off"
        placeholder="0.00"
        value={text}
        onChange={(e) => setText(e.target.value.replace(/[^\d.,]/g, ""))}
        suffix="AUSD"
        error={tooMuch ? "More than your balance." : null}
        disabled={tx.busy || done}
        data-testid="margin-amount"
        action={
          cash.data ? (
            <button type="button" onClick={() => setText(amountText(cash.data!.raw, 6, 2))} disabled={tx.busy || done || cash.data.raw === 0n} className="num text-[12px] text-text-3 transition-colors enabled:hover:text-text">
              Balance {ausd(cash.data.value)} <span className="ml-1 font-strong text-primary">Max</span>
            </button>
          ) : undefined
        }
      />
      <div className="flex flex-col gap-2.5 rounded-2xl border border-line p-4">
        <Row label="Margin" value={amount ? `${ausd(toAusd(p.margin))} → ${ausd(marginAfter)}` : ausd(toAusd(p.margin))} />
        <Row label="Leverage" value={amount ? `${lev(p.leverage)} → ${lev(p.notional / marginAfter)}` : lev(p.leverage)} />
        <Row label="Liquidation index" value={amount ? `${p.liquidationIndex === null ? "None" : points(p.liquidationIndex)} → ${liqAfter === null ? "None" : points(liqAfter)}` : p.liquidationIndex === null ? "None" : points(p.liquidationIndex)} tone={amount ? "up" : undefined} />
        <Row label="Index now" value={points(p.index)} tone="muted" />
      </div>
      {done ? (
        <Button block size="lg" tone="secondary" onClick={onDone}>
          Done
        </Button>
      ) : (
        <Button block size="lg" onClick={add} loading={tx.busy} disabled={!amount || tooMuch} data-testid="confirm-add-margin">
          {amount ? `Add ${ausd(toAusd(amount))} AUSD` : "Add margin"}
        </Button>
      )}
      <TxStatus tx={tx} filledLabel="Margin added" testId="add-margin-tx" />
    </div>
  );
}
