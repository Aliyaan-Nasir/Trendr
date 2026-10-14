"use client";
import { useQueryClient } from "@tanstack/react-query";
import { minimumOut, type OrderBook, OUTCOME_MARKET, type Quote, quoteBuy, quoteSell } from "@trendr/contracts";
import { ChevronDown, Clock } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { AnimateHeight, Button, cn, Empty, Num, Row, Segmented, TxStatus } from "@/components/ui";
import { useAccount } from "@/lib/account/AccountProvider";
import type { Trend } from "@/lib/api";
import { ausd, cents, countdown, points, tokenAmount, tokenNumber } from "@/lib/format";
import { useAusdBalance } from "@/lib/hooks/queries";
import { outcome as outcomeCalls, spot } from "@/lib/trade/calls";
import { mid, type SeriesView } from "@/lib/trade/reads";
import { type TxLabels, useTx } from "@/lib/trade/useTx";
import { type ChosenBook, recordFill, unrealized, useCostBooks } from "@/features/portfolio/cost-basis";
import { rememberSeries } from "@/features/portfolio/ledger";
import { pulse, revealInPanel } from "@/lib/scroll";
import { needsPasskey, passkeyReason } from "./band";
import { useBook, usePriceBand, useRegistryIndex, useSeries, useTokenBalances } from "./data";
import { parseAmount } from "./math";
import { AmountField, Note, Section, SubmitButton, useNow } from "./ticket";

/**
 * Up or down on a trend's attention: each series asks whether the index closes above where it
 * opened. Up and Down trade on Kuru; a pair of one Up and one Down always mints and redeems for
 * exactly 1 AUSD, and each winning token pays 1 AUSD at settlement.
 */

const DECIMALS = 6;
const SLIPPAGE_BPS = 100;
/** Outcome tokens trade in whole 0.01 units. */
const SIZE_UNIT = 1_000_000n / BigInt(OUTCOME_MARKET.sizePrecision);
const WINDOW_LABEL: Record<number, string> = { 900: "15M", 86_400: "24H", 604_800: "7D" };
const label = (w: number) => WINDOW_LABEL[w] ?? `${Math.round(w / 60)}M`;

export type Side = "up" | "down";
type Mode = "buy" | "sell";

/** The series a ticket offers, the 24 hour one first. */
export const orderSeries = (list: readonly SeriesView[]) => [...list].sort((a, b) => (a.window === 86_400 ? -1 : b.window === 86_400 ? 1 : a.window - b.window));

/** Cents, as the ticket shows a price: one decimal and a "c". */
export const CENTS = { format: { minimumFractionDigits: 1, maximumFractionDigits: 1 }, suffix: "c" } as const;

export default function OutcomeTicket({ trend, initialSide = "up" }: { trend: Trend; initialSide?: Side }) {
  const series = useSeries(trend.id);
  const list = useMemo(() => orderSeries(series.data ?? []), [series.data]);
  const [picked, setPicked] = useState<number | null>(null);
  const current = list.find((s) => s.window === picked) ?? list[0];

  if (series.isLoading) return <div className="skeleton h-[420px]" />;
  if (!current) {
    return <Empty className="py-10" icon={<Clock className="size-6" />} title="No series yet" body="The first Up or down series opens within a minute of a trend listing. Check back shortly." />;
  }
  return (
    <div className="flex flex-col gap-5">
      {list.length > 1 ? (
        <Segmented label="Series window" size="sm" value={String(current.window)} onChange={(v) => setPicked(Number(v))} options={list.map((s) => ({ value: String(s.window), label: label(s.window) }))} />
      ) : null}
      <SeriesBody key={current.seriesId} trend={trend} series={current} initialSide={initialSide} />
    </div>
  );
}

function SeriesBody({ trend, series: s, initialSide }: { trend: Trend; series: SeriesView; initialSide: Side }) {
  const account = useAccount();
  const position = useRef<HTMLElement>(null);
  // Bumped when a trade turns final: the position it changed pulses once.
  const [settled, setSettled] = useState(0);
  const now = useNow();
  const live = useRegistryIndex(trend.id);
  const holdings = useTokenBalances(account.address, [s.up, s.down]);
  const [up = 0n, down = 0n] = holdings.data ?? [];
  const expired = now / 1000 >= s.expiry;
  const index = live.data?.index ?? trend.index;
  const above = index > s.openingIndex;

  return (
    <div className="flex flex-col gap-5">
      <div className="rounded-2xl bg-surface-2 px-4 py-3.5">
        <p className="font-strong text-[15px] leading-6 text-text">
          Will attention close above <span className="num">{points(s.openingIndex)}</span>?
        </p>
        <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[12.5px] text-text-2">
          <span className="flex items-center gap-1.5">
            <Clock className="size-3.5 text-text-3" aria-hidden />
            {expired ? "Closed" : <span className="num">Closes in {countdown(s.expiry, now)}</span>}
          </span>
          <span className="num">
            Now {points(index)}{" "}
            <span className={above ? "text-up" : "text-down"}>
              ({above ? "above" : "at or below"})
            </span>
          </span>
        </div>
      </div>
      {s.outcome !== 0 ? (
        <Settled series={s} up={up} down={down} />
      ) : expired ? (
        <Closing series={s} up={up} down={down} />
      ) : (
        <Trade trend={trend} series={s} up={up} down={down} initialSide={initialSide} onFilled={() => revealInPanel(position.current)} onFinal={() => setSettled((n) => n + 1)} />
      )}
      {account.authenticated && s.outcome === 0 && !expired ? <Pairs series={s} up={up} down={down} sectionRef={position} settled={settled} /> : null}
    </div>
  );
}

const REDEEM: TxLabels = { action: "Redeem", done: "Redeemed" };

export const best = (book: OrderBook | null | undefined, side: "bid" | "ask") => {
  const level = side === "bid" ? book?.bids[0] : book?.asks[0];
  return level ? level.price / OUTCOME_MARKET.pricePrecision : null;
};

/** Calls `fn` once each time the transaction reaches `stage`. */
function useOnStage(stage: string, at: string, fn: () => void) {
  const latest = useRef(fn);
  useEffect(() => {
    latest.current = fn;
  });
  useEffect(() => {
    if (stage === at) latest.current();
  }, [stage, at]);
}

function Trade({ trend, series: s, up, down, initialSide, onFilled, onFinal }: { trend: Trend; series: SeriesView; up: bigint; down: bigint; initialSide: Side; onFilled: () => void; onFinal: () => void }) {
  const account = useAccount();
  const client = useQueryClient();
  const balance = useAusdBalance(account.address);
  const upBook = useBook(s.listed ? s.upMarket : undefined);
  const downBook = useBook(s.listed ? s.downMarket : undefined);
  const [mode, setMode] = useState<Mode>("buy");
  const [side, setSide] = useState<Side>(initialSide);
  const [text, setText] = useState("");
  const tx = useTx();
  useOnStage(tx.stage, "filled", onFilled);
  useOnStage(tx.stage, "final", onFinal);

  const book = side === "up" ? upBook.data : downBook.data;
  const held = side === "up" ? up : down;
  const raw = parseAmount(text, DECIMALS);
  const amount = raw === null ? null : mode === "sell" ? raw - (raw % SIZE_UNIT) : raw;
  const quote: Quote | null = amount && book ? (mode === "buy" ? quoteBuy(book, amount) : quoteSell(book, amount)) : null;
  const spendable = mode === "buy" ? (balance.data?.raw ?? null) : held;
  const token = side === "up" ? s.up : s.down;
  const band = usePriceBand(s.listed ? token : undefined);
  const viaPasskey = needsPasskey(quote, band.data, mode === "buy");

  const error = (() => {
    if (text.trim() === "") return null;
    if (amount === null || amount === 0n) return mode === "sell" ? "Sell at least 0.01" : "Enter an amount";
    if (account.authenticated && spendable !== null && amount > spendable) return mode === "buy" ? "More than your AUSD balance" : `You hold ${tokenAmount(held, DECIMALS)}`;
    if (quote && !quote.complete) return `The book only fills ${mode === "buy" ? `${ausd(Number(quote.filled) / 1e6)} AUSD` : tokenAmount(quote.filled, DECIMALS)} right now`;
    if (quote && quote.out === 0n) return "Too small to fill at the best price";
    return null;
  })();

  const submit = async () => {
    if (!amount || !quote || !account.address) return;
    const minOut = minimumOut(quote, SLIPPAGE_BPS);
    const name = side === "up" ? "Up" : "Down";
    const labels = mode === "buy" ? { action: `Buy ${name}`, done: `Bought ${name} for ${ausd(Number(amount) / 1e6)} AUSD` } : { action: `Sell ${name}`, done: `Sold ${tokenAmount(amount, DECIMALS)} ${name}` };
    const r = viaPasskey
      ? await tx.run(() => account.ownerExecute(mode === "buy" ? spot.buyWithLimit(token, amount, minOut, account.address!) : spot.sellWithLimit(token, amount, minOut, account.address!)), labels)
      : await tx.run(() => account.trade(mode === "buy" ? spot.buy(token, amount, minOut, account.address!) : spot.sell(token, amount, minOut, account.address!)), labels);
    if (r) {
      rememberSeries(account.address, s.seriesId);
      void recordFill(account.address, r.hash, s);
      setText("");
      void client.invalidateQueries({ queryKey: ["balances"] });
      void client.invalidateQueries({ queryKey: ["ausd"] });
      void client.invalidateQueries({ queryKey: ["book"] });
    }
  };

  if (!s.listed) {
    return <Note>Kuru markets for this series are opening. Trading starts within a minute or two; meanwhile you can mint pairs below.</Note>;
  }

  const sidePrice = (x: Side) => best(x === "up" ? upBook.data : downBook.data, mode === "buy" ? "ask" : "bid");
  const payout = quote && mode === "buy" ? Number(quote.out) / 1e6 : null;
  const spent = amount !== null ? Number(amount) / 1e6 : null;
  const sideName = side === "up" ? "Up" : "Down";

  return (
    <div className="flex flex-col gap-4">
      <Segmented
        label="Buy or sell"
        value={mode}
        onChange={(m) => {
          setMode(m);
          setText("");
          tx.reset();
        }}
        options={[
          { value: "buy", label: "Buy" },
          { value: "sell", label: "Sell" },
        ]}
      />
      <div className="grid grid-cols-2 gap-2" role="radiogroup" aria-label="Side">
        {(["up", "down"] as const).map((x) => {
          const p = sidePrice(x);
          const active = side === x;
          return (
            <button
              key={x}
              type="button"
              role="radio"
              aria-checked={active}
              data-testid={`outcome-side-${x}`}
              onClick={() => {
                setSide(x);
                tx.reset();
              }}
              className={cn(
                "flex flex-col items-start rounded-2xl border px-4 py-3 text-left transition-colors",
                active ? (x === "up" ? "border-up bg-up-soft" : "border-down bg-down-soft") : "border-line bg-surface-2 hover:border-line-strong",
              )}
            >
              <span className={cn("font-strong text-[13px]", x === "up" ? "text-up" : "text-down")}>{x === "up" ? "Up" : "Down"}</span>
              <span className="num-display mt-0.5 font-display text-[26px] leading-tight text-text">
                <Num value={p === null ? null : p * 100} {...CENTS} />
              </span>
              <span className="text-[11.5px] text-text-3">{mode === "buy" ? "to buy" : "to sell"}</span>
            </button>
          );
        })}
      </div>
      <AmountField
        label={mode === "buy" ? "You pay" : `${sideName} to sell`}
        unit={mode === "buy" ? "AUSD" : sideName}
        value={text}
        onChange={(v) => {
          setText(v);
          if (tx.stage !== "pending") tx.reset();
        }}
        balance={account.authenticated ? spendable : undefined}
        decimals={DECIMALS}
        error={error}
        testId="outcome-amount"
      />
      <div className="flex flex-col gap-2 rounded-xl border border-line px-3.5 py-3">
        {mode === "buy" ? (
          <>
            <Row label={`${sideName} you get`} value={quote ? tokenAmount(quote.out, DECIMALS) : "-"} />
            <Row label="Average price" value={quote && quote.out > 0n ? cents(quote.averagePrice) : "-"} />
            <Row
              label={`Pays if ${sideName} wins`}
              value={payout !== null && spent ? `${ausd(payout)} AUSD (${payout >= spent ? "+" : ""}${(((payout - spent) / spent) * 100).toFixed(0)}%)` : "-"}
              tone={payout !== null ? "up" : undefined}
            />
            <Row label="Most you can lose" value={spent !== null ? `${ausd(spent)} AUSD` : "-"} tone="muted" />
          </>
        ) : (
          <>
            <Row label="You receive" value={quote ? `${ausd(Number(quote.out) / 1e6)} AUSD` : "-"} />
            <Row label="Average price" value={quote && quote.filled > 0n ? cents(quote.averagePrice) : "-"} />
          </>
        )}
        <Row label="Slippage limit" value="1%" tone="muted" />
      </div>
      {viaPasskey && !error ? <Note tone="warn">{passkeyReason(band.data ?? null)}</Note> : null}
      <SubmitButton tone={side === "up" ? "up" : "down"} disabled={!quote || Boolean(error) || quote.out === 0n} loading={tx.busy} onClick={() => void submit()} testId="outcome-submit" passkey={viaPasskey}>
        {mode === "buy" ? `Buy ${sideName}` : `Sell ${sideName}`}
        {amount && mode === "buy" ? ` for ${ausd(Number(amount) / 1e6)} AUSD` : ""}
      </SubmitButton>
      <TxStatus tx={tx} filledLabel={mode === "buy" ? "Bought" : "Sold"} testId="outcome-tx" />
      <Note>
        Each {sideName} token pays 1 AUSD if attention closes {side === "up" ? "above" : "at or below"} {points(s.openingIndex)}, and nothing otherwise. Prices come from the Kuru order book and settle on Monad.
      </Note>
      {trend.status !== "active" ? <Note tone="warn">This trend is {trend.status}: new pairs cannot be minted, but the books stay open until the series closes.</Note> : null}
    </div>
  );
}

/** Complete sets: mint a pair for 1 AUSD, or redeem a pair back for 1 AUSD. */
function Pairs({ series: s, up, down, sectionRef, settled }: { series: SeriesView; up: bigint; down: bigint; sectionRef: React.RefObject<HTMLElement | null>; settled: number }) {
  const account = useAccount();
  const client = useQueryClient();
  const balance = useAusdBalance(account.address);
  const costs = useCostBooks(account.address);
  const upBook = useBook(s.listed ? s.upMarket : undefined);
  const downBook = useBook(s.listed ? s.downMarket : undefined);
  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");
  const tx = useTx();
  const mintForm = useRef<HTMLDivElement>(null);
  const pairs = up < down ? up : down;
  const amount = parseAmount(text, DECIMALS);
  const tooMuch = amount !== null && balance.data !== undefined && amount > balance.data.raw;

  const run = async (calls: Parameters<typeof account.trade>[0], labels: TxLabels) => {
    const r = await tx.run(() => account.trade(calls), labels);
    if (r) {
      if (account.address) {
        rememberSeries(account.address, s.seriesId);
        void recordFill(account.address, r.hash, s);
      }
      setText("");
      void client.invalidateQueries({ queryKey: ["balances"] });
      void client.invalidateQueries({ queryKey: ["ausd"] });
    }
  };

  return (
    <Section
      ref={sectionRef}
      title="Your position"
      action={
        <button
          type="button"
          onClick={() => {
            // Opening: once it has eased open, bring the mint form into the panel's view.
            if (!open) setTimeout(() => revealInPanel(mintForm.current), 280);
            setOpen((o) => !o);
          }}
          aria-expanded={open}
          className="flex items-center gap-1 text-[12.5px] text-text-3 transition-colors hover:text-text"
        >
          Pairs
          <ChevronDown className={cn("size-3.5 transition-transform", open && "rotate-180")} aria-hidden />
        </button>
      }
      className="border-t border-line pt-5"
    >
      <div className="grid grid-cols-2 gap-2">
        <Holding label="Up" amount={up} tone="up" chosen={costs.pick(s.up, up)} price={mid(upBook.data ?? null)} settled={settled} />
        <Holding label="Down" amount={down} tone="down" chosen={costs.pick(s.down, down)} price={mid(downBook.data ?? null)} settled={settled} />
      </div>
      {pairs > 0n ? (
        <Button tone="secondary" block loading={tx.busy} onClick={() => void run(outcomeCalls.redeemSets(s.seriesId, pairs, account.address!), { action: "Redeem pairs", done: `Redeemed ${tokenAmount(pairs, DECIMALS)} pairs for ${ausd(Number(pairs) / 1e6)} AUSD` })} data-testid="redeem-pairs">
          Redeem {tokenAmount(pairs, DECIMALS)} pairs for {ausd(Number(pairs) / 1e6)} AUSD
        </Button>
      ) : null}
      {/* Closed, it takes no room: the margin cancels the section's gap. */}
      <AnimateHeight className="-mt-3">
        {open ? (
          <div ref={mintForm} className="flex flex-col gap-3 pt-3">
            <AmountField label="Mint pairs" unit="AUSD" value={text} onChange={setText} balance={balance.data?.raw ?? null} decimals={DECIMALS} error={tooMuch ? "More than your AUSD balance" : null} hint="Each AUSD mints one Up and one Down. A pair always redeems for 1 AUSD." testId="mint-amount" />
            <Button block tone="secondary" disabled={!amount || tooMuch} loading={tx.busy} onClick={() => amount && void run(outcomeCalls.mint(s.seriesId, amount, account.address!), { action: "Mint pairs", done: `Minted ${tokenAmount(amount, DECIMALS)} pairs` })} data-testid="mint-pairs">
              {amount ? `Mint ${tokenAmount(amount, DECIMALS)} pairs` : "Mint pairs"}
            </Button>
          </div>
        ) : null}
      </AnimateHeight>
      <TxStatus tx={tx} filledLabel="Done" testId="pairs-tx" />
    </Section>
  );
}

function Holding({ label, amount, tone, chosen, price, settled }: { label: string; amount: bigint; tone: "up" | "down"; chosen: ChosenBook | null; price: number | null; settled: number }) {
  const tile = useRef<HTMLDivElement>(null);
  const entry = unrealized(chosen?.book ?? null, amount, price);
  useEffect(() => {
    if (settled > 0) pulse(tile.current);
  }, [settled]);
  return (
    <div ref={tile} className="rounded-xl bg-surface-2 px-3.5 py-2.5">
      <p className={cn("text-[12px] font-strong", tone === "up" ? "text-up" : "text-down")}>{label}</p>
      <p className="num mt-0.5 font-strong text-[16px] text-text">
        <Num value={tokenNumber(amount, DECIMALS)} testId={`holding-${label.toLowerCase()}`} />
      </p>
      {/* Entry and PnL when the indexer's book or this device's record covers the holding; its value otherwise. */}
      <p className="num mt-0.5 truncate text-[11.5px] leading-4 text-text-3" data-testid={`entry-${label.toLowerCase()}`} data-source={entry ? chosen?.source : undefined}>
        {amount === 0n ? (
          "None held"
        ) : entry ? (
          <>
            Avg {cents(entry.average)} · <span className={entry.pnl > 0.005 ? "text-up" : entry.pnl < -0.005 ? "text-down" : undefined}>{ausd(entry.pnl, { sign: true })}</span>
          </>
        ) : price !== null ? (
          `Worth ${ausd((Number(amount) / 1e6) * price)}`
        ) : (
          "No price yet"
        )}
      </p>
    </div>
  );
}

function Settled({ series: s, up, down }: { series: SeriesView; up: bigint; down: bigint }) {
  const account = useAccount();
  const client = useQueryClient();
  const tx = useTx();
  const won = s.outcome === 1 ? "up" : s.outcome === 2 ? "down" : "void";
  const payout = won === "up" ? up : won === "down" ? down : up / 2n + down / 2n;
  const redeem = async () => {
    const r = await tx.run(() => account.trade(outcomeCalls.redeemWinnings(s.seriesId, up, down, account.address!)), REDEEM);
    if (r) void client.invalidateQueries({ queryKey: ["balances"] });
  };
  return (
    <div className="flex flex-col gap-3">
      <div className={cn("rounded-xl px-4 py-3 text-[13.5px] leading-5", won === "up" ? "bg-up-soft" : won === "down" ? "bg-down-soft" : "bg-surface-2")}>
        <p className="font-strong text-text">{won === "up" ? "Up won." : won === "down" ? "Down won." : "Void."}</p>
        <p className="text-text-2">
          {won === "void" ? "No closing reading arrived in time, so every token redeems for 0.50 AUSD." : `Attention closed ${won === "up" ? "above" : "at or below"} ${points(s.openingIndex)}. The next series opens shortly.`}
        </p>
      </div>
      {account.authenticated && (up > 0n || down > 0n) ? (
        <>
          <SubmitButton tone="primary" disabled={payout === 0n} loading={tx.busy} onClick={() => void redeem()} testId="redeem-winnings">
            {payout > 0n ? `Redeem ${ausd(Number(payout) / 1e6)} AUSD` : "Nothing to redeem"}
          </SubmitButton>
          <TxStatus tx={tx} filledLabel="Redeemed" testId="redeem-tx" />
        </>
      ) : null}
    </div>
  );
}

function Closing({ series: s, up, down }: { series: SeriesView; up: bigint; down: bigint }) {
  const account = useAccount();
  const client = useQueryClient();
  const tx = useTx();
  const redeem = async () => {
    const r = await tx.run(() => account.trade(outcomeCalls.redeemWinnings(s.seriesId, up, down, account.address!)), REDEEM);
    if (r) void client.invalidateQueries({ queryKey: ["balances"] });
  };
  return (
    <div className="flex flex-col gap-3">
      <Note>{s.settleable ? "This series has closed and its closing reading is in. Redeeming settles it." : "This series has closed. It settles as soon as the oracle records the closing reading, usually within a minute or two."}</Note>
      {s.settleable && account.authenticated && (up > 0n || down > 0n) ? (
        <>
          <SubmitButton loading={tx.busy} onClick={() => void redeem()} testId="redeem-winnings">
            Settle and redeem
          </SubmitButton>
          <TxStatus tx={tx} filledLabel="Redeemed" testId="redeem-tx" />
        </>
      ) : null}
    </div>
  );
}
