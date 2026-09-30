"use client";
import { useQuery } from "@tanstack/react-query";
import { bondingCurveAbi } from "@trendr/contracts";
import { Fingerprint } from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import { Badge, Button, Field, Row, Sheet, TxStatus } from "@/components/ui";
import { useAccount } from "@/lib/account/AccountProvider";
import { publicClient } from "@/lib/chain/client";
import { DEPLOYMENT } from "@/lib/config";
import { ausd } from "@/lib/format";
import { curve, spot } from "@/lib/trade/calls";
import { readBook } from "@/lib/trade/reads";
import { useTx } from "@/lib/trade/useTx";
import { trendName } from "@/lib/trends";
import { useRefreshPortfolio } from "./hooks";
import { coinPrice } from "./format";
import { kuruSellQuote, toAusd } from "./math";
import { amountText, Figure, parseAmount, SectionCard, tokens } from "./parts";
import type { CoinHolding } from "./reads";

const COIN_DECIMALS = 18;
const SLIPPAGE_BPS = 100n;
const nameOf = (c: CoinHolding) => (c.trend ? trendName(c.trend) : "Trend coin");

/** Trend coins: bought on each trend's bonding curve, traded on Kuru once the curve graduates. */
export function CoinSection({ coins, total }: { coins: CoinHolding[]; total: number | null }) {
  const [selling, setSelling] = useState<CoinHolding | null>(null);
  return (
    <>
      {coins.length > 0 ? (
        <SectionCard id="coins-title" testId="coin-section" title="Trend coins" count={coins.length} subtitle="Each trend's coin trades on its bonding curve until the curve fills, then on its own Kuru market." total={total === null ? "-" : ausd(total)}>
          <ul className="divide-y divide-line border-t border-line">
            {coins.map((c) => (
              <li key={c.coin} className="flex flex-col gap-3.5 px-4 py-4 sm:px-6" data-testid="coin-row">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-1.5">
                      {c.trend ? (
                        <Link href={`/t/${c.trend.identifier}`} className="truncate font-strong text-[15px] leading-6 text-text underline-offset-4 hover:underline">
                          {nameOf(c)}
                        </Link>
                      ) : (
                        <span className="font-strong text-[15px] leading-6 text-text">{nameOf(c)}</span>
                      )}
                      {c.state === 3 ? <Badge tone="primary">On Kuru</Badge> : c.state === 2 ? <Badge tone="warn">Graduating</Badge> : <Badge>On the curve</Badge>}
                    </div>
                    <p className="num mt-1 text-[12.5px] leading-5 text-text-2">{c.state === 1 ? `${Math.round(c.progress * 100)}% of the way to graduation` : c.state === 2 ? "The curve is full; its Kuru market opens next" : "Graduated: priced by its Kuru market"}</p>
                  </div>
                  <div className="shrink-0 text-right">
                    <p className="num font-strong text-[15px] leading-6 text-text">{c.value === null ? "-" : ausd(c.value)}</p>
                    <p className="text-[11.5px] text-text-3">AUSD</p>
                  </div>
                </div>
                <div className="grid grid-cols-[1fr_1fr_auto] items-center gap-3 rounded-xl bg-surface-2/70 px-3 py-2">
                  <Figure label="Coins">{tokens(c.balance, COIN_DECIMALS)}</Figure>
                  <Figure label="Price">{coinPrice(c.price)}</Figure>
                  <Button size="sm" tone="secondary" disabled={c.state === 2 || (c.state === 3 && !c.kuru)} onClick={() => setSelling(c)} data-testid="sell-coin">
                    Sell
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        </SectionCard>
      ) : null}
      {/* The sheets stay mounted when the last row goes, so a finished trade keeps its result on screen. */}
      <SellCoinSheet coin={selling} onClose={() => setSelling(null)} />
    </>
  );
}

function SellCoinSheet({ coin, onClose }: { coin: CoinHolding | null; onClose: () => void }) {
  const [last, setLast] = useState(coin);
  if (coin !== null && coin !== last) setLast(coin);
  const c = coin ?? last;
  return (
    <Sheet open={coin !== null} onOpenChange={(o) => !o && onClose()} title={c ? `Sell ${nameOf(c)}` : "Sell"} description={c ? (c.state === 3 ? "On its Kuru market" : "Back to the bonding curve, less its 1% fee") : undefined} testId="sell-coin-sheet">
      {c ? <SellCoinBody key={c.coin} c={c} onDone={onClose} /> : null}
    </Sheet>
  );
}

function SellCoinBody({ c, onDone }: { c: CoinHolding; onDone: () => void }) {
  const account = useAccount();
  const refresh = useRefreshPortfolio();
  const tx = useTx();
  const [text, setText] = useState(() => amountText(c.balance, COIN_DECIMALS, 6));
  // Coins carry 18 decimals but the field shows 6: Max sells every last unit, not the rounded text.
  const [max, setMax] = useState(true);
  const amount = max ? c.balance : parseAmount(text, COIN_DECIMALS);
  const tooMuch = amount !== null && amount > c.balance;
  const graduated = c.state === 3;
  const quote = useQuery({
    queryKey: ["coin-sell-quote", c.coin, amount?.toString(), graduated],
    enabled: amount !== null && !tooMuch,
    refetchInterval: 3_000,
    queryFn: async (): Promise<{ out: bigint; complete: boolean }> => {
      if (graduated && c.kuru) return kuruSellQuote((await readBook(c.market, 10))!, c.kuru, amount!);
      const [out] = (await publicClient.readContract({ address: DEPLOYMENT.bondingCurve, abi: bondingCurveAbi, functionName: "quoteSell", args: [c.trendId, amount!] })) as readonly [bigint, bigint];
      return { out, complete: true };
    },
  });
  const minOut = quote.data ? (quote.data.out * (10_000n - SLIPPAGE_BPS)) / 10_000n : 0n;
  const done = tx.stage === "filled" || tx.stage === "final";

  const sell = async () => {
    if (!amount || minOut === 0n) return;
    // A coin has no oracle price to hold a session's sale to, so selling it is a passkey action.
    const calls = graduated ? spot.sellWithLimit(c.coin, amount, minOut, account.address!) : curve.sell(c.trendId, amount, minOut, account.address!);
    const r = await tx.run(() => account.ownerExecute(calls), { action: "Sell coins", done: "Coins sold" });
    if (r) refresh();
  };

  return (
    <div className="flex flex-col gap-5">
      <Field
        label="Amount"
        inputMode="decimal"
        autoComplete="off"
        value={text}
        onChange={(e) => {
          setMax(false);
          setText(e.target.value.replace(/[^\d.,]/g, ""));
        }}
        suffix="coins"
        error={tooMuch ? "More than you hold." : null}
        disabled={tx.busy || done}
        data-testid="sell-coin-amount"
        action={
          <button
            type="button"
            onClick={() => {
              setMax(true);
              setText(amountText(c.balance, COIN_DECIMALS, 6));
            }}
            disabled={tx.busy || done} className="num text-[12px] text-text-3 transition-colors enabled:hover:text-text">
            Holding {tokens(c.balance, COIN_DECIMALS)} <span className="ml-1 font-strong text-primary">Max</span>
          </button>
        }
      />
      <div className="flex flex-col gap-2.5 rounded-2xl border border-line p-4">
        <Row label="You receive about" value={quote.data ? `${ausd(toAusd(quote.data.out))} AUSD` : quote.isFetching ? "..." : "-"} />
        <Row label="Least you accept (1% slippage)" value={quote.data ? `${ausd(toAusd(minOut))} AUSD` : "-"} tone="muted" />
      </div>
      {quote.isError ? <p className="rounded-xl bg-warn-soft px-3.5 py-2.5 text-[12.5px] leading-[18px] text-text">This sale could not be quoted right now. Try again in a moment.</p> : null}
      {!graduated ? <p className="rounded-xl bg-surface-2 px-3.5 py-2.5 text-[12.5px] leading-[18px] text-text-2">One sale may move the curve&rsquo;s price by at most 20%; split a larger sale into smaller ones.</p> : null}
      {quote.data && !quote.data.complete ? <p className="rounded-xl bg-warn-soft px-3.5 py-2.5 text-[12.5px] leading-[18px] text-text">The Kuru book cannot take this much right now. Sell less at a time.</p> : null}
      {done ? (
        <Button block size="lg" tone="secondary" onClick={onDone}>
          Done
        </Button>
      ) : (
        <Button block size="lg" onClick={sell} loading={tx.busy} disabled={!amount || tooMuch || minOut === 0n || (quote.data ? !quote.data.complete : true)} data-testid="confirm-sell-coin" icon={<Fingerprint className="size-[18px]" aria-hidden />}>
          {amount ? `Sell ${tokens(amount, COIN_DECIMALS)} coins` : "Sell"}
        </Button>
      )}
      <TxStatus tx={tx} filledLabel="Sold" testId="sell-coin-tx" />
    </div>
  );
}
