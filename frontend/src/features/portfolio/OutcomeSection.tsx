"use client";
import { useQuery } from "@tanstack/react-query";
import { minimumOut, quoteSell } from "@trendr/contracts";
import { ArrowDown, ArrowUp, Clock, Fingerprint } from "lucide-react";
import Link from "next/link";
import { AnimatePresence, m } from "framer-motion";
import { useState } from "react";
import { Badge, Button, Delta, Field, listItem, Row, Sheet, TxStatus } from "@/components/ui";
import { useAccount } from "@/lib/account/AccountProvider";
import { ausd, cents, countdown, points } from "@/lib/format";
import { outcome as outcomeCalls, spot } from "@/lib/trade/calls";
import { mid, readBook } from "@/lib/trade/reads";
import { useTx } from "@/lib/trade/useTx";
import { needsPasskey, passkeyReason } from "@/features/trend/band";
import { usePriceBand } from "@/features/trend/data";
import { trendName } from "@/lib/trends";
import { useRefreshPortfolio } from "./hooks";
import { recordFill, unrealized, useCostBooks } from "./cost-basis";
import { forgetSeries } from "./ledger";
import { toAusd, winningsRaw } from "./math";
import { amountText, Figure, parseAmount, SectionCard, SignedAusd, signedPct, toneOf, tokens, useNow, windowShort } from "./parts";
import type { OutcomeHolding } from "./reads";

const SLIPPAGE_BPS = 100;
const DECIMALS = 6;

/** UP and DOWN tokens, one block per series: what is held, what it is worth, and what can be done. */
export function OutcomeSection({ holdings, total }: { holdings: OutcomeHolding[]; total: number | null }) {
  const [selling, setSelling] = useState<{ holding: OutcomeHolding; side: "up" | "down" } | null>(null);
  const sorted = [...holdings].sort((a, b) => (a.phase === "settled" ? 0 : 1) - (b.phase === "settled" ? 0 : 1) || a.expiry - b.expiry);
  return (
    <>
      {holdings.length > 0 ? (
        <SectionCard id="outcomes-title" testId="outcome-section" title="Up or down" count={holdings.length} subtitle="Outcome tokens on each trend's attention. A pair of UP and DOWN always redeems for 1 AUSD; the winning side pays 1 AUSD at settlement." total={total === null ? "-" : ausd(total)}>
          <ul className="relative divide-y divide-line border-t border-line">
            <AnimatePresence initial={false} mode="popLayout">
              {sorted.map((h) => (
                <m.li key={h.seriesId} {...listItem}>
                  <OutcomeRow h={h} onSell={(side) => setSelling({ holding: h, side })} />
                </m.li>
              ))}
            </AnimatePresence>
          </ul>
        </SectionCard>
      ) : null}
      {/* The sheets stay mounted when the last row goes, so a finished trade keeps its result on screen. */}
      <SellOutcomeSheet target={selling} onClose={() => setSelling(null)} />
    </>
  );
}

function PhaseBadge({ h, now }: { h: OutcomeHolding; now: number }) {
  if (h.phase === "open") {
    return (
      <Badge icon={<Clock className="size-3" aria-hidden />}>
        <span className="num">{countdown(h.expiry, now)}</span>
      </Badge>
    );
  }
  if (h.phase === "settling") return <Badge tone="warn">Settling</Badge>;
  if (h.outcome === 3) return <Badge>Void</Badge>;
  return <Badge tone={h.outcome === 1 ? "up" : "down"}>{h.outcome === 1 ? "UP won" : "DOWN won"}</Badge>;
}

function OutcomeRow({ h, onSell }: { h: OutcomeHolding; onSell: (side: "up" | "down") => void }) {
  const account = useAccount();
  const now = useNow();
  const refresh = useRefreshPortfolio();
  const redeem = useTx();
  const costs = useCostBooks(account.address);
  const name = h.trend ? trendName(h.trend) : `${h.trendId.slice(0, 10)}...`;
  const current = h.trend?.index ?? null;
  const shownIndex = h.settlementIndex ?? current;
  const move = shownIndex !== null && h.openingIndex > 0 ? ((shownIndex - h.openingIndex) / h.openingIndex) * 100 : null;
  const payout = h.outcome !== null ? winningsRaw(h.outcome, h.upBalance, h.downBalance) : 0n;
  const settled = h.phase === "settled";
  const tradable = h.phase === "open";
  // Sessions trade on this deployment only; a replaced one redeems with one passkey prompt.
  const send = h.legacy ? account.ownerExecute : account.trade;
  const withPasskey = h.legacy ? " with passkey" : "";

  // The row can disappear once nothing is left in the series; the transaction's toast confirms it.
  const runRedeemSets = async () => {
    const sets = h.sets;
    const r = await redeem.run(() => send(outcomeCalls.redeemSets(h.seriesId, sets, account.address!, h.outcomeMarkets)), {
      action: "Redeem sets",
      done: `Redeemed ${tokens(sets)} ${sets === 1_000_000n ? "set" : "sets"} for ${ausd(toAusd(sets))} AUSD`,
    });
    if (r) {
      void recordFill(account.address!, r.hash, h);
      refresh();
    }
  };
  const runRedeemWinnings = async () => {
    const paid = payout;
    const r = await redeem.run(() => send(outcomeCalls.redeemWinnings(h.seriesId, h.upBalance, h.downBalance, account.address!, h.outcomeMarkets)), {
      action: "Redeem winnings",
      done: paid > 0n ? `Redeemed ${ausd(toAusd(paid))} AUSD of winnings` : "Cleared the losing tokens",
    });
    if (r) {
      forgetSeries(account.address!, [h.seriesId]);
      void recordFill(account.address!, r.hash, h);
      refresh();
    }
  };

  return (
    <div className="flex flex-col gap-3.5 px-4 py-4 sm:px-6" data-testid="outcome-row" data-series={h.seriesId}>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-1.5">
            {h.trend ? (
              <Link href={`/t/${h.trend.identifier}`} className="truncate font-strong text-[15px] leading-6 text-text underline-offset-4 hover:underline">
                {name}
              </Link>
            ) : (
              <span className="truncate font-strong text-[15px] leading-6 text-text">{name}</span>
            )}
            <Badge tone="primary">{windowShort(h.window)}</Badge>
            <PhaseBadge h={h} now={now} />
            {h.legacy ? <Badge>Earlier contract</Badge> : null}
          </div>
          <p className="num mt-1 text-[12.5px] leading-5 text-text-2">
            Opened at {points(h.openingIndex)}
            {shownIndex !== null ? (
              <>
                <span className="text-text-3"> · {h.settlementIndex !== null ? "settled at" : "now"} </span>
                {points(shownIndex)} <Delta value={move} className="text-[12px]" digits={1} />
              </>
            ) : null}
          </p>
        </div>
        <div className="shrink-0 text-right">
          <p className="num font-strong text-[15px] leading-6 text-text">{h.value === null ? "-" : ausd(h.value)}</p>
          <p className="text-[11.5px] text-text-3">{h.value === null ? "no price yet" : "AUSD"}</p>
        </div>
      </div>

      <div className="flex flex-col gap-2">
        {(["up", "down"] as const).map((side) => {
          const bal = side === "up" ? h.upBalance : h.downBalance;
          if (bal === 0n) return null;
          const m = side === "up" ? h.upMid : h.downMid;
          const book = side === "up" ? h.upBook : h.downBook;
          const won = h.outcome === null ? null : h.outcome === 3 ? 0.5 : (h.outcome === 1) === (side === "up") ? 1 : 0;
          // A one-sided book prices at the side it has; say which.
          const priceLabel = won !== null ? "Pays" : book && book.bids.length > 0 && book.asks.length > 0 ? "Mid" : book && book.asks.length > 0 ? "Ask" : book && book.bids.length > 0 ? "Bid" : "Price";
          const priceText = won !== null ? ausd(won) : m === null ? "-" : cents(m);
          const chosen = costs.pick(side === "up" ? h.up : h.down, bal);
          const entry = unrealized(chosen?.book ?? null, bal, won ?? m);
          return (
            <div key={side} className="grid grid-cols-[72px_minmax(0,1fr)_minmax(0,1fr)_auto] items-center gap-x-3 gap-y-2 rounded-xl bg-surface-2/70 px-3 py-2 sm:grid-cols-[84px_150px_150px_minmax(0,1fr)_auto]" data-testid={`holding-${side}`}>
              <Badge tone={side === "up" ? "up" : "down"} icon={side === "up" ? <ArrowUp className="size-3" aria-hidden /> : <ArrowDown className="size-3" aria-hidden />} className="justify-self-start">
                {side === "up" ? "UP" : "DOWN"}
              </Badge>
              <Figure label="Tokens">
                <span data-testid={`balance-${side}`}>{tokens(bal)}</span>
              </Figure>
              <Figure label={priceLabel}>{priceText}</Figure>
              {/* Phones: its own line under the row. Wider: the fourth column. */}
              <EntryFigure entry={entry} source={chosen?.source ?? null} indexed={costs.indexed} className="order-last col-span-full sm:order-none sm:col-span-1" />
              {tradable && (side === "up" ? h.upMarket : h.downMarket) ? (
                <Button size="sm" tone="secondary" onClick={() => onSell(side)} disabled={redeem.busy} data-testid={`sell-${side}`}>
                  Sell
                </Button>
              ) : (
                <span />
              )}
            </div>
          );
        })}
      </div>

      {h.sets > 0n || settled ? (
        <div className="flex flex-col gap-2.5 sm:flex-row sm:items-center sm:justify-between">
          <p className="text-[12.5px] leading-5 text-text-2">
            {settled
              ? payout > 0n
                ? `Redeem ${tokens(h.upBalance + h.downBalance)} tokens for ${ausd(toAusd(payout))} AUSD.`
                : "These tokens lost. Clearing them tidies the portfolio and pays nothing."
              : `${tokens(h.sets)} complete ${h.sets === 1_000_000n ? "set" : "sets"} (one UP and one DOWN) redeem for ${ausd(toAusd(h.sets))} AUSD at any time.`}
          </p>
          {settled ? (
            <Button size="sm" tone={payout > 0n ? "primary" : "ghost"} onClick={runRedeemWinnings} loading={redeem.busy} disabled={redeem.stage === "filled" || redeem.stage === "final"} data-testid="redeem-winnings" className="shrink-0">
              {payout > 0n ? `Redeem ${ausd(toAusd(payout))}${withPasskey}` : `Clear${withPasskey}`}
            </Button>
          ) : (
            <Button size="sm" tone="secondary" onClick={runRedeemSets} loading={redeem.busy} data-testid="redeem-sets" className="shrink-0">
              Redeem {tokens(h.sets)} {h.sets === 1_000_000n ? "set" : "sets"}
              {withPasskey}
            </Button>
          )}
        </div>
      ) : null}
      {h.phase === "settling" ? <p className="text-[12.5px] leading-5 text-text-3">The series ended. The oracle confirms the closing index within a few minutes, then winnings redeem here.</p> : null}
      <TxStatus tx={redeem} filledLabel={settled ? "Redeemed" : "Sets redeemed"} testId="redeem-tx" />
    </div>
  );
}

/**
 * What the tokens cost and their gain at the price beside them, from the indexer's book or this
 * device's record, whichever accounts for the holding (see cost-basis.ts); otherwise a plain note,
 * never a guessed number.
 */
function EntryFigure({ entry, source, indexed, className }: { entry: ReturnType<typeof unrealized>; source: "server" | "device" | null; indexed: boolean; className?: string }) {
  if (!entry) {
    return (
      <Figure label="Entry" className={className}>
        <span className="font-sans text-[12.5px] font-normal text-text-3" data-testid="outcome-entry-missing">
          {indexed ? "Not indexed yet" : "Not on this device"}
        </span>
      </Figure>
    );
  }
  return (
    <Figure label="Entry and PnL" className={className}>
      {cents(entry.average)}{" "}
      <span className={toneOf(entry.pnl)} data-testid="outcome-pnl" data-source={source ?? undefined}>
        <SignedAusd value={entry.pnl} /> <span className="font-sans text-[12px]">({signedPct(entry.pct)})</span>
      </span>
    </Figure>
  );
}

function SellOutcomeSheet({ target, onClose }: { target: { holding: OutcomeHolding; side: "up" | "down" } | null; onClose: () => void }) {
  // Keep the last target while the sheet animates out.
  const [last, setLast] = useState(target);
  if (target && target !== last) setLast(target);
  const t = target ?? last;
  return (
    <Sheet open={target !== null} onOpenChange={(o) => !o && onClose()} title={t ? `Sell ${t.side === "up" ? "UP" : "DOWN"}` : "Sell"} description={t ? `${t.holding.trend ? trendName(t.holding.trend) : "Trend"} · ${windowShort(t.holding.window)} series on Kuru` : undefined} testId="sell-outcome-sheet">
      {t ? <SellOutcomeBody key={`${t.holding.seriesId}-${t.side}`} h={t.holding} side={t.side} onDone={onClose} /> : null}
    </Sheet>
  );
}

function SellOutcomeBody({ h, side, onDone }: { h: OutcomeHolding; side: "up" | "down"; onDone: () => void }) {
  const account = useAccount();
  const refresh = useRefreshPortfolio();
  const tx = useTx();
  const balance = side === "up" ? h.upBalance : h.downBalance;
  const token = side === "up" ? h.up : h.down;
  const market = side === "up" ? h.upMarket : h.downMarket;
  const [text, setText] = useState(() => amountText(balance, DECIMALS));
  const amount = parseAmount(text, DECIMALS);
  const book = useQuery({ queryKey: ["book", market, 10], enabled: Boolean(market), refetchInterval: 2_000, queryFn: () => readBook(market!, 10) });
  const quote = book.data && amount ? quoteSell(book.data, amount) : null;
  const tooMuch = amount !== null && amount > balance;
  const done = tx.stage === "filled" || tx.stage === "final";
  const error = tooMuch ? "More than you hold." : quote && quote.filled === 0n ? "No bids on the book right now." : null;
  const minOut = quote ? minimumOut(quote, SLIPPAGE_BPS) : 0n;
  const midNow = mid(book.data ?? null);
  // Earlier-contract tokens have no band (TrendrSpot lists the current deployment's only), and a
  // price outside the band needs the passkey too.
  const band = usePriceBand(token);
  const viaPasskey = needsPasskey(quote, band.data, false);

  const sell = async () => {
    if (!amount || !quote || minOut === 0n) return;
    const labels = side === "up" ? { action: "Sell Up", done: "Sold Up" } : { action: "Sell Down", done: "Sold Down" };
    const r = viaPasskey
      ? await tx.run(() => account.ownerExecute(spot.sellWithLimit(token, amount, minOut, account.address!)), labels)
      : await tx.run(() => account.trade(spot.sell(token, amount, minOut, account.address!)), labels);
    if (r) {
      void recordFill(account.address!, r.hash, h);
      refresh();
    }
  };

  return (
    <div className="flex flex-col gap-5">
      <Field
        label="Amount"
        inputMode="decimal"
        autoComplete="off"
        value={text}
        onChange={(e) => setText(e.target.value.replace(/[^\d.,]/g, ""))}
        suffix={side === "up" ? "UP" : "DOWN"}
        error={error}
        disabled={tx.busy || done}
        data-testid="sell-amount"
        action={
          <button type="button" onClick={() => setText(amountText(balance, DECIMALS))} disabled={tx.busy || done} className="num text-[12px] text-text-3 transition-colors enabled:hover:text-text">
            Holding {tokens(balance)} <span className="ml-1 font-strong text-primary">Max</span>
          </button>
        }
      />
      <div className="flex flex-col gap-2.5 rounded-2xl border border-line p-4">
        <Row label="You receive about" value={quote ? `${ausd(toAusd(quote.out))} AUSD` : book.isLoading ? "..." : "-"} />
        <Row label="Average price" value={quote && quote.filled > 0n ? cents(quote.averagePrice) : "-"} />
        <Row label="Mid now" value={midNow === null ? "-" : cents(midNow)} tone="muted" />
        <Row label="Least you accept (1% slippage)" value={quote ? `${ausd(toAusd(minOut))} AUSD` : "-"} tone="muted" />
      </div>
      {quote && !quote.complete && quote.filled > 0n ? <p className="rounded-xl bg-warn-soft px-3.5 py-2.5 text-[12.5px] leading-[18px] text-text">The book can take only {tokens(quote.filled)} now; selling more would fail. Lower the amount or wait for the market maker to refill.</p> : null}
      {viaPasskey && quote?.complete && !done ? <p className="rounded-xl bg-warn-soft px-3.5 py-2.5 text-[12.5px] leading-[18px] text-text">{passkeyReason(band.data ?? null)}</p> : null}
      {done ? (
        <Button block size="lg" tone="secondary" onClick={onDone}>
          Done
        </Button>
      ) : (
        <Button block size="lg" onClick={sell} loading={tx.busy} disabled={!amount || tooMuch || !quote || !quote.complete || minOut === 0n} data-testid="confirm-sell" icon={viaPasskey ? <Fingerprint className="size-[18px]" aria-hidden /> : undefined}>
          {amount ? `Sell ${tokens(amount)} ${side === "up" ? "UP" : "DOWN"}` : "Sell"}
        </Button>
      )}
      <TxStatus tx={tx} filledLabel="Sold" testId="sell-tx" />
    </div>
  );
}
