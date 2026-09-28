"use client";
import { useQueryClient } from "@tanstack/react-query";
import { bondingCurveAbi, minimumOut } from "@trendr/contracts";
import { Rocket, TrendingUp } from "lucide-react";
import { useState } from "react";
import { encodeFunctionData } from "viem";
import { Badge, Button, ExplorerLink, Row, Segmented, TxStatus } from "@/components/ui";
import { useAccount } from "@/lib/account/AccountProvider";
import type { Trend } from "@/lib/api";
import { DEPLOYMENT, explorerToken } from "@/lib/config";
import { ausd, price, tokenAmount } from "@/lib/format";
import { useAusdBalance } from "@/lib/hooks/queries";
import { curve as curveCalls, spot } from "@/lib/trade/calls";
import { useTx } from "@/lib/trade/useTx";
import { useBook, useCurve, useCurveQuote, useKuruParams, useRegistryIndex, useSymbol, useTokenBalances } from "./data";
import { kuruQuoteBuy, kuruQuoteSell, parseAmount } from "./math";
import { AmountField, Note, SubmitButton } from "./ticket";

/**
 * Trend coins, the launch layer: one coin per trend on a bonding curve in AUSD whose floor rises
 * with the trend's peak attention. When the curve fills it graduates to its own Kuru market.
 *
 * Every coin trade is a passkey action. A coin has no oracle price to hold a trade to, so a stolen
 * session key could otherwise sell the account's coins into its holder's bid, or buy from its
 * holder's ask with whatever the same batch raised.
 */

const COIN_DECIMALS = 18;
const AUSD_DECIMALS = 6;
const SLIPPAGE_BPS = 100;
const FEE = 0.01;
/** The curve refuses a trade that moves its price more than 20%. */
const MAX_IMPACT = 0.2;

export default function CoinTicket({ trend }: { trend: Trend }) {
  const curve = useCurve(trend.id);
  if (curve.isLoading) return <div className="skeleton h-[360px]" />;
  if (!curve.data) return <Launch trend={trend} />;
  if (curve.data.state === 3) return <Graduated trend={trend} />;
  return <OnCurve trend={trend} />;
}

function Launch({ trend }: { trend: Trend }) {
  const account = useAccount();
  const client = useQueryClient();
  const live = useRegistryIndex(trend.id);
  const tx = useTx();
  const active = live.data ? live.data.status === 1 : trend.status === "active";
  const launch = async () => {
    const data = encodeFunctionData({ abi: bondingCurveAbi, functionName: "createCurve", args: [trend.identifier] });
    if (await tx.run(() => account.ownerExecute([{ target: DEPLOYMENT.bondingCurve, value: 0n, data }]), { action: "Launch the coin", done: "Coin launched" })) void client.invalidateQueries({ queryKey: ["curve", trend.id] });
  };
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col items-center gap-2 rounded-2xl bg-surface-2 px-5 py-7 text-center">
        <span className="flex size-11 items-center justify-center rounded-full bg-primary-soft text-primary">
          <Rocket className="size-5" aria-hidden />
        </span>
        <p className="mt-1 font-strong text-[15px] text-text">No coin for this trend yet</p>
        <p className="max-w-[300px] text-[13px] leading-5 text-text-2">Launch it on a bonding curve in AUSD. Its floor rises with the trend&rsquo;s peak attention, and it graduates to its own Kuru market when the curve fills.</p>
      </div>
      {!active ? <Note tone="warn">Coins launch only while a trend is active.</Note> : null}
      <SubmitButton disabled={!active} loading={tx.busy} onClick={() => void launch()} testId="coin-launch">
        Launch the coin
      </SubmitButton>
      <TxStatus tx={tx} filledLabel="Launched" testId="coin-launch-tx" />
      <Note>Launching costs nothing but one passkey confirmation; Trendr pays the gas. Whoever surfaced the trend earns 10% of the curve&rsquo;s fees, not the launcher.</Note>
    </div>
  );
}

function OnCurve({ trend }: { trend: Trend }) {
  const account = useAccount();
  const client = useQueryClient();
  const curve = useCurve(trend.id);
  const c = curve.data!;
  const symbol = useSymbol(c.coin);
  const balance = useAusdBalance(account.address);
  const coins = useTokenBalances(account.address, [c.coin]);
  const held = coins.data?.[0] ?? 0n;
  const [mode, setMode] = useState<"buy" | "sell">("buy");
  const [text, setText] = useState("");
  const tx = useTx();
  const amount = parseAmount(text, mode === "buy" ? AUSD_DECIMALS : COIN_DECIMALS);
  const quote = useCurveQuote(trend.id, mode, amount);

  const spot = Number(c.spotPrice) / 1e18 / 1e6;
  const progress = c.graduationReserve > 0n ? Math.min(1, Number(c.reserve) / Number(c.graduationReserve)) : 0;
  const ready = c.state === 2;
  // Constant product: price moves by (1 + net / Q)^2 on a buy and by (T / (T + coins))^2 on a sell.
  const Q = Number(c.virtualQuote + c.reserve) / 1e6;
  const T = 1e9 - Number(c.sold) / 1e18;
  const impact = amount === null ? 0 : mode === "buy" ? (1 + (Number(amount) / 1e6) * (1 - FEE) / Q) ** 2 - 1 : 1 - (T / (T + Number(amount) / 1e18)) ** 2;
  const out = quote.data?.out;

  const error = (() => {
    if (text.trim() === "") return null;
    if (amount === null) return "Enter an amount";
    if (account.authenticated && mode === "buy" && balance.data && amount > balance.data.raw) return "More than your AUSD balance";
    if (account.authenticated && mode === "sell" && amount > held) return "More coins than you hold";
    if (impact > MAX_IMPACT) return mode === "buy" ? `Too large for one trade: at most about ${ausd(((Math.sqrt(1 + MAX_IMPACT) - 1) * Q) / (1 - FEE))} AUSD` : "Too large for one trade: sell in smaller parts";
    return null;
  })();

  const submit = async () => {
    if (!amount || out === undefined || !account.address) return;
    const min = minimumOut({ out, filled: amount, complete: true, averagePrice: 0 }, SLIPPAGE_BPS);
    const calls = mode === "buy" ? curveCalls.buy(trend.id, amount, min, account.address) : curveCalls.sell(trend.id, amount, min, account.address);
    if (await tx.run(() => account.ownerExecute(calls), coinLabels(mode, symbol.data, amount))) {
      setText("");
      void client.invalidateQueries({ queryKey: ["curve", trend.id] });
      void client.invalidateQueries({ queryKey: ["balances"] });
      void client.invalidateQueries({ queryKey: ["ausd"] });
    }
  };

  return (
    <div className="flex flex-col gap-4">
      <CoinHeader symbol={symbol.data} coin={c.coin} priceAusd={spot} floorBoost={c.ratchetBps / 10_000} />
      <div>
        <div className="flex items-baseline justify-between text-[12.5px]">
          <span className="text-text-2">Graduation</span>
          <span className="num text-text-2">
            {ausd(Number(c.reserve) / 1e6)} of {ausd(Number(c.graduationReserve) / 1e6)} AUSD
          </span>
        </div>
        <div className="mt-2 h-2 overflow-hidden rounded-full bg-surface-3" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(progress * 100)} aria-label="Graduation progress">
          <div className="h-full rounded-full bg-primary transition-[width] duration-500" style={{ width: `${Math.max(progress * 100, progress > 0 ? 2 : 0)}%` }} />
        </div>
      </div>
      {ready ? (
        <Note>The curve is full. It graduates to its own Kuru market within a block or two, and trading continues there.</Note>
      ) : (
        <>
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
          <AmountField
            label={mode === "buy" ? "You pay" : "Coins to sell"}
            unit={mode === "buy" ? "AUSD" : "coins"}
            value={text}
            onChange={setText}
            balance={account.authenticated ? (mode === "buy" ? (balance.data?.raw ?? null) : held) : undefined}
            decimals={mode === "buy" ? AUSD_DECIMALS : COIN_DECIMALS}
            error={error}
            testId="coin-amount"
          />
          <div className="flex flex-col gap-2 rounded-xl border border-line px-3.5 py-3">
            <Row label={mode === "buy" ? "Coins you get" : "You receive"} value={out === undefined ? "-" : mode === "buy" ? tokenAmount(out, COIN_DECIMALS) : `${ausd(Number(out) / 1e6)} AUSD`} />
            <Row label="Fee" value={quote.data ? `${ausd(Number(quote.data.fee) / 1e6)} AUSD (1%)` : "1%"} tone="muted" />
            <Row label="Price impact" value={amount ? `${(impact * 100).toFixed(2)}%` : "-"} tone={impact > 0.05 ? "warn" : "muted"} />
            <Row label="Slippage limit" value="1%" tone="muted" />
          </div>
          <SubmitButton tone={mode === "buy" ? "primary" : "secondary"} disabled={!amount || out === undefined || out === 0n || Boolean(error)} loading={tx.busy} onClick={() => void submit()} testId="coin-submit" passkey>
            {mode === "buy" ? "Buy coins" : "Sell coins"}
          </SubmitButton>
          <TxStatus tx={tx} filledLabel={mode === "buy" ? "Bought" : "Sold"} testId="coin-tx" />
        </>
      )}
      {account.authenticated && held > 0n ? (
        <p className="num text-[12.5px] text-text-2">
          You hold {tokenAmount(held, COIN_DECIMALS)} coins, about {ausd((Number(held) / 1e18) * spot)} AUSD at the curve price.
        </p>
      ) : null}
      <Note>Trend coins are the riskiest thing on Trendr: their price is set only by buyers and sellers on the curve, so your passkey confirms every coin trade. The attention floor limits how low the curve can price them, not what you get back.</Note>
    </div>
  );
}

/** Buys spend AUSD (6 decimals); sales spend coins (18). */
const coinLabels = (mode: "buy" | "sell", symbol: string | undefined, amount: bigint) => {
  const coin = symbol ? `$${symbol}` : "coins";
  return mode === "buy" ? { action: `Buy ${coin}`, done: `Bought ${coin} for ${ausd(Number(amount) / 1e6)} AUSD` } : { action: `Sell ${coin}`, done: `Sold ${tokenAmount(amount, COIN_DECIMALS)} ${coin}` };
};

function CoinHeader({ symbol, coin, priceAusd, floorBoost }: { symbol: string | undefined; coin: `0x${string}`; priceAusd: number | null; floorBoost: number | null }) {
  return (
    <div className="flex items-end justify-between gap-3">
      <div className="min-w-0">
        <ExplorerLink href={explorerToken(coin)} className="max-w-full font-mono text-[12px]">
          <span className="truncate">{symbol ? `$${symbol}` : "Trend coin"}</span>
        </ExplorerLink>
        <p className="num-display mt-0.5 font-display text-[30px] leading-none text-text">
          {priceAusd === null ? "-" : price(priceAusd)} <span className="font-sans text-[13px] text-text-3">AUSD</span>
        </p>
      </div>
      {floorBoost !== null && floorBoost > 1.0001 ? (
        <Badge tone="up" icon={<TrendingUp className="size-3" aria-hidden />}>
          Floor {floorBoost.toFixed(2)}x
        </Badge>
      ) : null}
    </div>
  );
}

/** After graduation the coin trades on its own Kuru market through TrendrSpot. */
function Graduated({ trend }: { trend: Trend }) {
  const account = useAccount();
  const client = useQueryClient();
  const curve = useCurve(trend.id);
  const c = curve.data!;
  const symbol = useSymbol(c.coin);
  const params = useKuruParams(c.market);
  const book = useBook(c.market);
  const balance = useAusdBalance(account.address);
  const coins = useTokenBalances(account.address, [c.coin]);
  const held = coins.data?.[0] ?? 0n;
  const [mode, setMode] = useState<"buy" | "sell">("buy");
  const [text, setText] = useState("");
  const tx = useTx();
  const amount = parseAmount(text, mode === "buy" ? AUSD_DECIMALS : COIN_DECIMALS);
  const quote = amount && book.data && params.data ? (mode === "buy" ? kuruQuoteBuy(book.data, params.data, amount) : kuruQuoteSell(book.data, params.data, amount)) : null;
  const ask = book.data?.asks[0] && params.data ? book.data.asks[0].price / Number(params.data.pricePrecision) : null;
  const bid = book.data?.bids[0] && params.data ? book.data.bids[0].price / Number(params.data.pricePrecision) : null;
  const mid = ask !== null && bid !== null ? (ask + bid) / 2 : (ask ?? bid);

  const error = (() => {
    if (text.trim() === "" || amount === null) return null;
    if (account.authenticated && mode === "buy" && balance.data && amount > balance.data.raw) return "More than your AUSD balance";
    if (account.authenticated && mode === "sell" && amount > held) return "More coins than you hold";
    if (quote && !quote.complete) return "The book cannot fill all of that right now";
    return null;
  })();

  const submit = async () => {
    if (!amount || !quote || !account.address) return;
    const min = minimumOut(quote, SLIPPAGE_BPS);
    const calls = mode === "buy" ? spot.buyWithLimit(c.coin, amount, min, account.address) : spot.sellWithLimit(c.coin, amount, min, account.address);
    if (await tx.run(() => account.ownerExecute(calls), coinLabels(mode, symbol.data, amount))) {
      setText("");
      void client.invalidateQueries({ queryKey: ["balances"] });
      void client.invalidateQueries({ queryKey: ["ausd"] });
      void client.invalidateQueries({ queryKey: ["book"] });
    }
  };

  return (
    <div className="flex flex-col gap-4">
      <CoinHeader symbol={symbol.data} coin={c.coin} priceAusd={mid} floorBoost={null} />
      <Note>Graduated: the curve closed and its reserves seeded this coin&rsquo;s own Kuru market, where it trades now. Your passkey confirms every coin trade.</Note>
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
      <AmountField label={mode === "buy" ? "You pay" : "Coins to sell"} unit={mode === "buy" ? "AUSD" : "coins"} value={text} onChange={setText} balance={account.authenticated ? (mode === "buy" ? (balance.data?.raw ?? null) : held) : undefined} decimals={mode === "buy" ? AUSD_DECIMALS : COIN_DECIMALS} error={error} />
      <div className="flex flex-col gap-2 rounded-xl border border-line px-3.5 py-3">
        <Row label={mode === "buy" ? "Coins you get" : "You receive"} value={quote ? (mode === "buy" ? tokenAmount(quote.out, COIN_DECIMALS) : `${ausd(Number(quote.out) / 1e6)} AUSD`) : "-"} />
        <Row label="Average price" value={quote && quote.averagePrice > 0 ? `${price(quote.averagePrice)} AUSD` : "-"} />
        <Row label="Slippage limit" value="1%" tone="muted" />
      </div>
      <SubmitButton disabled={!quote || quote.out === 0n || Boolean(error)} loading={tx.busy} onClick={() => void submit()} passkey>
        {mode === "buy" ? "Buy on Kuru" : "Sell on Kuru"}
      </SubmitButton>
      <TxStatus tx={tx} filledLabel={mode === "buy" ? "Bought" : "Sold"} testId="coin-tx" />
      {params.isError ? (
        <Button tone="ghost" size="sm" onClick={() => void params.refetch()}>
          Retry loading the market
        </Button>
      ) : null}
    </div>
  );
}
