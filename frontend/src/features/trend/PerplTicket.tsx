"use client";
import { useQueryClient } from "@tanstack/react-query";
import { perplSessionMaxLeverage } from "@trendr/contracts";
import { outcomeFromLogs, type PerplMarket, worstPrice } from "@trendr/perpl";
import { useState } from "react";
import { Badge, Button, cn, ErrorNote, Row, Segmented, TxStatus } from "@/components/ui";
import { useAccount } from "@/lib/account/AccountProvider";
import { perplApi, type Trend } from "@/lib/api";
import { publicClient } from "@/lib/chain/client";
import { DEPLOYMENT } from "@/lib/config";
import { ausd, pct, price } from "@/lib/format";
import { useAusdBalance } from "@/lib/hooks/queries";
import { perpl } from "@/lib/trade/calls";
import type { PerplHolding } from "@/lib/trade/reads";
import { notify } from "@/lib/toast";
import { useTx } from "@/lib/trade/useTx";
import { usePerplAccount, usePerplMarket, usePerplTicker } from "./data";
import { parseAmount } from "./math";
import { AmountField, Note, Section, SubmitButton } from "./ticket";

/**
 * Perpl perpetuals on the asset behind a trend, traded from the account's own Perpl account in
 * the same gas-free session batches: the first trade opens the account, later ones top it up.
 * Orders are immediate-or-cancel; whether one filled is read from its transaction's events.
 * Sessions open at up to the order guard's leverage cap; above it the passkey confirms the trade.
 */

const DECIMALS = 6;
const SLIPPAGE_BPS = 50;
const TAKER_FEE = 0.0004;
const LEVERAGES = [1, 2, 3, 5, 10, 20] as const;
/** The order guard refuses session openings above this; higher leverage is a passkey trade. */
const SESSION_MAX_LEVERAGE = perplSessionMaxLeverage(DEPLOYMENT);

type Result = { kind: "filled"; size: number; price: number | null } | { kind: "missed"; reason: string } | null;

const REASONS: Record<string, string> = {
  OrderSizeExceedsAvailableSize: "the book could not fill that size",
  OrderSettlementImpliesInsolvent: "the margin was too small for that size",
  OrderPostFailed: "the order could not be placed",
  PositionDoesNotExist: "there was no position to close",
};

/** Checks a sent order's events: filled size and price, or why it did not fill. */
async function readResult(hash: `0x${string}`, accountId: bigint, requestId: bigint, market: PerplMarket): Promise<Result> {
  const receipt = await publicClient.getTransactionReceipt({ hash });
  const logs = receipt.logs.filter((l) => l.address.toLowerCase() === DEPLOYMENT.perplExchange.toLowerCase());
  const out = outcomeFromLogs(logs, accountId, requestId, market, hash, receipt.blockNumber);
  if (!out) return { kind: "missed", reason: "the order did not reach the book" };
  if (out.filled > 0) return { kind: "filled", size: out.filled, price: out.price };
  return { kind: "missed", reason: (out.failure && REASONS[out.failure]) ?? "the price moved past your limit" };
}

export default function PerplTicket({ trend }: { trend: Trend }) {
  const account = useAccount();
  const client = useQueryClient();
  const { market, minimums } = usePerplMarket(trend.ticker);
  const ticker = usePerplTicker(market);
  const perplAccount = usePerplAccount(account.address, market);
  const balance = useAusdBalance(account.address);
  const [side, setSide] = useState<"long" | "short">("long");
  const [lev, setLev] = useState("3");
  const [text, setText] = useState("");
  const [result, setResult] = useState<Result>(null);
  const tx = useTx();

  if (!market) return null;
  // The usual steps below the market's limit, then the limit itself (15x on a 15x market).
  const top = Math.max(1, Math.floor(market.maxLeverage));
  const levels = [...new Set([...LEVERAGES.filter((l) => l < top), top])].map(String);
  const leverage = Number(levels.includes(lev) ? lev : levels[levels.length - 1]);
  const viaPasskey = leverage > SESSION_MAX_LEVERAGE;
  const mark = ticker.data?.mark ?? null;
  const margin = parseAmount(text, DECIMALS);
  const marginAusd = margin === null ? null : Number(margin) / 1e6;
  const step = 10 ** -market.sizeDecimals;
  const size = marginAusd !== null && mark ? Math.floor(((marginAusd * leverage) / mark) * 10 ** market.sizeDecimals + 1e-9) / 10 ** market.sizeDecimals : null;
  const notional = size !== null && mark ? size * mark : null;
  const reference = side === "long" ? (ticker.data?.ask ?? mark) : (ticker.data?.bid ?? mark);
  const limit = reference ? worstPrice(side, reference, Math.min(SLIPPAGE_BPS, market.maxSlippageBps || SLIPPAGE_BPS)) : null;
  const liq = mark ? (side === "long" ? mark * (1 - 1 / leverage + market.maintenanceMargin) : mark * (1 + 1 / leverage - market.maintenanceMargin)) : null;
  const pa = perplAccount.data;
  const free = pa ? BigInt(Math.floor(pa.balanceAusd * 1e6)) : 0n;
  // Margin plus 1% for fees, from the Perpl balance first and the wallet for the rest.
  const need = margin === null ? 0n : (margin * 101n) / 100n;
  const shortfall = need > free ? need - free : 0n;
  const funding = !pa?.accountId ? (minimums && need < minimums.accountOpen ? minimums.accountOpen : need) : shortfall > 0n && minimums && shortfall < minimums.deposit ? minimums.deposit : shortfall;

  const error = (() => {
    if (text.trim() === "") return null;
    if (margin === null) return "Enter an amount";
    if (size !== null && size < step) return `Too small: the smallest order is ${step} ${market.symbol}`;
    if (account.authenticated && balance.data && funding > balance.data.raw) return `Needs ${ausd(Number(funding) / 1e6)} AUSD in your wallet`;
    return null;
  })();

  const submit = async () => {
    if (!size || !limit || !account.address) return;
    setResult(null);
    let requestId: bigint;
    try {
      requestId = await perplApi.requestId();
    } catch {
      setResult({ kind: "missed", reason: "Trendr could not reserve an order id; try again" });
      return;
    }
    const fundingCalls = !pa?.accountId ? perpl.openAccount(funding) : funding > 0n ? perpl.deposit(funding) : [];
    const calls = [...fundingCalls, ...perpl.open(market, requestId, side, size, limit, leverage)];
    const named = `${side === "long" ? "Long" : "Short"} ${market.symbol} ${leverage}x`;
    const r = await tx.run(() => (viaPasskey ? account.ownerExecute(calls) : account.trade(calls)), { action: named, done: `${named} order sent` });
    if (!r) return;
    const accountId = pa?.accountId ?? (await perplAccount.refetch()).data?.accountId ?? null;
    if (accountId) setResult(await readResult(r.hash, accountId, requestId, market).catch(() => null));
    setText("");
    void client.invalidateQueries({ queryKey: ["perpl-account"] });
    void client.invalidateQueries({ queryKey: ["ausd"] });
  };

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-end justify-between gap-3">
        <div>
          <p className="font-mono text-[12px] text-text-3">{market.name} on Perpl</p>
          <p className="num-display mt-0.5 font-display text-[30px] leading-none text-text" data-testid="perpl-mark">
            {mark === null ? "-" : price(mark)}
          </p>
        </div>
        <p className="num text-right text-[12px] text-text-3">
          Bid {ticker.data ? price(ticker.data.bid) : "-"}
          <br />
          Ask {ticker.data ? price(ticker.data.ask) : "-"}
        </p>
      </div>
      <Segmented
        label="Side"
        value={side}
        onChange={(v) => {
          setSide(v);
          tx.reset();
          setResult(null);
        }}
        options={[
          { value: "long", label: "Long", tone: "up" },
          { value: "short", label: "Short", tone: "down" },
        ]}
      />
      <AmountField label="Margin" unit="AUSD" value={text} onChange={setText} balance={account.authenticated ? (balance.data?.raw ?? null) : undefined} decimals={DECIMALS} error={error} testId="perpl-margin" />
      <div className="flex items-center justify-between gap-3">
        <span className="font-strong text-[12.5px] text-text-2">Leverage</span>
        <Segmented label="Leverage" size="sm" value={String(leverage)} onChange={setLev} options={levels.map((l) => ({ value: l, label: `${l}x` }))} />
      </div>
      <div className="flex flex-col gap-2 rounded-xl border border-line px-3.5 py-3">
        <Row label="Size" value={size !== null && size > 0 ? `${size.toFixed(market.sizeDecimals)} ${market.symbol}` : "-"} />
        <Row label="Notional" value={notional !== null && notional > 0 ? `${ausd(notional)} AUSD` : "-"} />
        <Row label="Worst fill price" value={limit ? price(limit) : "-"} tone="muted" />
        <Row label="Liquidation near" value={liq !== null && margin ? price(liq) : "-"} tone={margin ? "warn" : undefined} />
        <Row label="Taker fee" value={notional ? `${ausd(notional * TAKER_FEE)} AUSD` : "0.04%"} tone="muted" />
        {funding > 0n && margin ? <Row label={pa?.accountId ? "Moves to Perpl" : "Opens your Perpl account with"} value={`${ausd(Number(funding) / 1e6)} AUSD`} tone="muted" /> : null}
        <Row label="Most you can lose" value={margin ? `${ausd(Number(margin) / 1e6)} AUSD` : "-"} tone="down" />
      </div>
      {viaPasskey && !error ? (
        <Note tone="warn">
          Trading sessions open Perpl positions at up to {SESSION_MAX_LEVERAGE}x, which limits what a stolen session key could lose. Your passkey confirms this {leverage}x trade.
        </Note>
      ) : null}
      <SubmitButton tone={side === "long" ? "up" : "down"} disabled={!size || size < step || Boolean(error) || !account.backendReady} loading={tx.busy} onClick={() => void submit()} testId="perpl-submit" passkey={viaPasskey}>
        {account.authenticated && !account.backendReady ? "Connecting to Trendr" : `${side === "long" ? "Long" : "Short"} ${market.symbol} ${leverage}x`}
      </SubmitButton>
      <TxStatus tx={tx} filledLabel="Sent" testId="perpl-tx" />
      {result?.kind === "filled" ? (
        <p className="num rounded-xl bg-up-soft px-3.5 py-2.5 text-[13px] text-text" role="status">
          Filled {result.size} {market.symbol}
          {result.price ? ` at ${price(result.price)}` : ""}.
        </p>
      ) : result?.kind === "missed" ? (
        <ErrorNote message={`Nothing filled: ${result.reason}. Your AUSD stays in your Perpl account.`} />
      ) : null}
      <Note>Perpl perps track {market.symbol}&rsquo;s market price, not its attention. Funding is paid between longs and shorts on Perpl, and positions are liquidated near the price shown.</Note>
      {account.authenticated && pa?.accountId ? <Holdings market={market} holdings={pa.holdings} balanceAusd={pa.balanceAusd} mark={mark} /> : null}
    </div>
  );
}

function Holdings({ market, holdings, balanceAusd, mark }: { market: PerplMarket; holdings: PerplHolding[]; balanceAusd: number; mark: number | null }) {
  const account = useAccount();
  const client = useQueryClient();
  const tx = useTx();
  const [closing, setClosing] = useState(false);
  const refresh = () => {
    void client.invalidateQueries({ queryKey: ["perpl-account"] });
    void client.invalidateQueries({ queryKey: ["ausd"] });
  };
  const close = async (h: PerplHolding) => {
    const ref = h.markPrice ?? mark;
    if (!ref) return;
    setClosing(true);
    try {
      const requestId = await perplApi.requestId();
      // Closing a long sells, so its worst price is below the mark; a short's is above.
      const limit = worstPrice(h.side === "long" ? "short" : "long", ref, Math.min(100, market.maxSlippageBps || 100));
      if (await tx.run(() => account.trade(perpl.close(market, requestId, h.side, h.size, limit)), { action: `Close ${h.side} ${market.symbol}`, done: `${h.side === "long" ? "Long" : "Short"} ${market.symbol} closed` })) refresh();
    } catch {
      notify.error("Could not close the position", "Trendr could not reserve a Perpl order id. Try again.");
    } finally {
      setClosing(false);
    }
  };
  const withdraw = async () => {
    const amount = BigInt(Math.floor(balanceAusd * 1e6));
    if (amount > 0n && (await tx.run(() => account.ownerExecute(perpl.withdraw(amount)), { action: "Withdraw from Perpl", done: "Withdrawn from Perpl" }))) refresh();
  };
  return (
    <Section title="Your Perpl account" className="border-t border-line pt-5">
      {holdings.map((h) => {
        const m = h.markPrice ?? mark;
        const pnl = m === null ? null : (m - h.entryPrice) * h.size * (h.side === "long" ? 1 : -1);
        return (
          <div key={`${h.market.id}-${h.side}`} className="flex flex-col gap-3 rounded-2xl border border-line px-3.5 py-3" data-testid="perpl-position">
            <div className="flex items-start justify-between gap-3">
              <div>
                <Badge tone={h.side === "long" ? "up" : "down"}>
                  {h.side === "long" ? "Long" : "Short"} {h.size} {market.symbol}
                </Badge>
                <p className="num mt-1.5 text-[12.5px] text-text-2">
                  Entry {price(h.entryPrice)}, margin {ausd(h.marginAusd)}
                </p>
              </div>
              {pnl !== null ? (
                <div className="text-right">
                  <p className={cn("num font-strong text-[15px]", pnl >= 0 ? "text-up" : "text-down")}>{ausd(pnl, { sign: true })} AUSD</p>
                  <p className={cn("num text-[12px]", pnl >= 0 ? "text-up" : "text-down")}>{h.marginAusd > 0 ? pct((pnl / h.marginAusd) * 100) : ""}</p>
                </div>
              ) : null}
            </div>
            <Button tone="danger" size="sm" loading={closing || tx.busy} onClick={() => void close(h)} data-testid="perpl-close">
              Close
            </Button>
          </div>
        );
      })}
      <div className="flex items-center justify-between gap-3 text-[13px]">
        <span className="text-text-2">
          Free balance <span className="num font-strong text-text">{ausd(balanceAusd)} AUSD</span>
        </span>
        {balanceAusd > 0 ? (
          <Button tone="secondary" size="sm" loading={tx.busy} onClick={() => void withdraw()}>
            Withdraw
          </Button>
        ) : null}
      </div>
      <TxStatus tx={tx} filledLabel="Done" testId="perpl-holdings-tx" />
      {holdings.length === 0 && balanceAusd === 0 ? <p className="text-[12.5px] text-text-3">No open positions.</p> : null}
    </Section>
  );
}
