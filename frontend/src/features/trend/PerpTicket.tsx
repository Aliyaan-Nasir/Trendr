"use client";
import { useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, Fingerprint } from "lucide-react";
import { useState } from "react";
import { Badge, Button, cn, Num, Row, Segmented, TxStatus } from "@/components/ui";
import { useAccount } from "@/lib/account/AccountProvider";
import type { Trend } from "@/lib/api";
import { ausd, points, tokenAmount } from "@/lib/format";
import { useAusdBalance } from "@/lib/hooks/queries";
import { perp } from "@/lib/trade/calls";
import type { PerpPositionView } from "@/lib/trade/reads";
import { useTx } from "@/lib/trade/useTx";
import { useMyPerpPositions, usePerpMarket, useRegistryIndex } from "./data";
import { acceptableIndex, INDEX_MAX, parseAmount, PERP, perpPreview } from "./math";
import { AmountField, Note, Section, SubmitButton } from "./ticket";

/**
 * Attention perps: a position on the index itself, long or short, up to 3x, with isolated margin.
 * Everything the contract will do is shown before confirming: size, fee, liquidation index,
 * funding and the most you can lose.
 */

const DECIMALS = 6;
const SLIPPAGE_BPS = 100;
const WAD = 10n ** 18n;
const LEVERAGES = ["1", "2", "3"] as const;

const money = (raw: bigint) => ausd(Number(raw) / 1e6);
const TWO = { minimumFractionDigits: 2, maximumFractionDigits: 2 };
const SIGNED = { ...TWO, signDisplay: "exceptZero" } as const;
/** An AUSD figure that rolls as the preview changes. */
const Ausd = ({ raw, value }: { raw?: bigint; value?: number }) => (
  <>
    <Num value={raw !== undefined ? Number(raw) / 1e6 : value} /> AUSD
  </>
);
const fundingText = (pctPerHour: number) =>
  Math.abs(pctPerHour) < 0.00005 ? "None while balanced" : pctPerHour > 0 ? `You pay ${pctPerHour.toFixed(3)}% an hour` : `You earn ${(-pctPerHour).toFixed(3)}% an hour`;

export default function PerpTicket({ trend }: { trend: Trend }) {
  const account = useAccount();
  const client = useQueryClient();
  const live = useRegistryIndex(trend.id);
  const index = live.data?.index;
  const market = usePerpMarket(trend.id, index);
  const balance = useAusdBalance(account.address);
  const [side, setSide] = useState<"long" | "short">("long");
  const [lev, setLev] = useState<(typeof LEVERAGES)[number]>("2");
  const [text, setText] = useState("");
  const tx = useTx();
  const isLong = side === "long";
  const margin = parseAmount(text, DECIMALS);
  const preview = margin && index && market.data ? perpPreview({ margin, leverage: Number(lev), index, isLong, longQty: market.data.longQty, shortQty: market.data.shortQty, unit: market.data.unit }) : null;

  const closed = live.data ? live.data.status !== 1 : false;
  const stale = live.data ? !live.data.fresh : false;
  const error = (() => {
    if (text.trim() === "") return null;
    if (!margin) return "Enter an amount";
    if (account.authenticated && balance.data && margin > balance.data.raw) return "More than your AUSD balance";
    if (preview && market.data && preview.net < market.data.minMargin) return `The smallest margin is ${money(market.data.minMargin + (market.data.minMargin * BigInt(lev) * PERP.feeBps) / 10_000n)} AUSD`;
    if (preview && market.data && preview.sideNotionalAfter > market.data.cap) {
      const room = market.data.cap - (preview.sideNotionalAfter - preview.notional);
      return room > 0n ? `This side has room for ${money(room)} AUSD more notional` : "This side is at its open interest cap";
    }
    return null;
  })();

  const submit = async () => {
    if (!margin || !index) return;
    const r = await tx.run(() => account.trade(perp.open(trend.id, isLong, margin, Number(lev), acceptableIndex(index, isLong, SLIPPAGE_BPS))), { action: `Open ${side} ${lev}x`, done: `Opened ${side} ${lev}x with ${money(margin)} AUSD` });
    if (r) {
      setText("");
      void client.invalidateQueries({ queryKey: ["perp-positions"] });
      void client.invalidateQueries({ queryKey: ["perp-market"] });
      void client.invalidateQueries({ queryKey: ["ausd"] });
    }
  };

  return (
    <div className="flex flex-col gap-4">
      <Segmented
        label="Side"
        value={side}
        onChange={(v) => {
          setSide(v);
          tx.reset();
        }}
        options={[
          { value: "long", label: "Long", tone: "up" },
          { value: "short", label: "Short", tone: "down" },
        ]}
      />
      <AmountField label="Margin" unit="AUSD" value={text} onChange={setText} balance={account.authenticated ? (balance.data?.raw ?? null) : undefined} decimals={DECIMALS} error={error} testId="perp-margin" />
      <div className="flex items-center justify-between gap-3">
        <span className="font-strong text-[12.5px] text-text-2">Leverage</span>
        <Segmented label="Leverage" size="sm" value={lev} onChange={setLev} className="w-[168px]" options={LEVERAGES.map((l) => ({ value: l, label: `${l}x` }))} />
      </div>
      <div className="flex flex-col gap-2 rounded-xl border border-line px-3.5 py-3" data-testid="perp-preview">
        <Row label="Entry index" value={<Num value={index} format={TWO} />} />
        <Row label="Position size" value={preview ? <Ausd raw={preview.notional} /> : "-"} />
        <Row
          label="Each index point"
          value={
            preview ? (
              <>
                <Num value={preview.perPoint} prefix={isLong ? "+" : "-"} /> AUSD if it rises
              </>
            ) : (
              "-"
            )
          }
        />
        <Row label="Opening fee" value={preview ? <Ausd raw={preview.fee} /> : "-"} tone="muted" />
        <Row
          label="Liquidation index"
          value={preview ? (preview.liquidationIndex === null ? (isLong ? "None above 0" : `None below ${INDEX_MAX}`) : <Num value={preview.liquidationIndex} format={TWO} />) : "-"}
          tone={preview?.liquidationIndex != null ? "warn" : undefined}
        />
        <Row label="Funding" value={preview ? fundingText(preview.fundingPerHourPct) : market.data ? fundingText(0) : "-"} tone="muted" />
        <Row label="Most you can lose" value={margin ? <Ausd raw={margin} /> : "-"} tone="down" />
      </div>
      {closed ? (
        <Note tone="warn">This trend is no longer active, so new positions are closed. Open positions can still be closed, and settle at the final index if it retires.</Note>
      ) : stale ? (
        <Note tone="warn">The index is between reports. Trading resumes with the next one, usually within a minute.</Note>
      ) : null}
      <SubmitButton tone={isLong ? "up" : "down"} disabled={!preview || Boolean(error) || closed || stale} loading={tx.busy} onClick={() => void submit()} testId="perp-submit">
        Open {side} {lev}x
      </SubmitButton>
      <TxStatus tx={tx} filledLabel="Opened" testId="perp-tx" />
      <Note>
        Isolated margin: a position can lose its margin and never more. Funding moves from the crowded side to the other every block, and closing costs 0.1% of size. Positions are liquidated when equity falls below 10% of size.
      </Note>
      {account.authenticated ? <Positions trend={trend} index={index} unit={market.data?.unit} /> : null}
    </div>
  );
}

function Positions({ trend, index, unit }: { trend: Trend; index: number | undefined; unit: bigint | undefined }) {
  const account = useAccount();
  const positions = useMyPerpPositions(account.address, trend.id);
  if (!positions.data || positions.data.length === 0) return null;
  return (
    <Section title="Your positions" className="border-t border-line pt-5">
      <ul className="flex flex-col gap-3">
        {positions.data.map((p) => (
          <PositionRow key={p.id.toString()} p={p} index={index} unit={unit} />
        ))}
      </ul>
    </Section>
  );
}

function PositionRow({ p, index, unit }: { p: PerpPositionView; index: number | undefined; unit: bigint | undefined }) {
  const account = useAccount();
  const client = useQueryClient();
  const tx = useTx();
  const [adding, setAdding] = useState(false);
  const [text, setText] = useState("");
  const add = parseAmount(text, DECIMALS);
  const pnl = p.equity - p.margin;
  const pnlPct = p.margin > 0n ? (Number(pnl) / Number(p.margin)) * 100 : 0;
  // Liquidation from today's equity, which already includes funding: equity + move x perPoint = 10% of size.
  const perPoint = unit ? Number((p.qty * unit) / WAD) / 1e6 : null;
  const equity = Number(p.equity) / 1e6;
  const liq = perPoint && index !== undefined ? (p.isLong ? (perPoint * index - equity) / (0.9 * perPoint) : (equity + perPoint * index) / (1.1 * perPoint)) : null;

  const refresh = () => {
    void client.invalidateQueries({ queryKey: ["perp-positions"] });
    void client.invalidateQueries({ queryKey: ["ausd"] });
  };
  const close = async () => {
    if (index === undefined) return;
    if (await tx.run(() => account.trade(perp.close(p.id, acceptableIndex(index, !p.isLong, SLIPPAGE_BPS))), { action: `Close ${p.isLong ? "long" : "short"}`, done: `${p.isLong ? "Long" : "Short"} closed` })) refresh();
  };
  const topUp = async () => {
    if (!add) return;
    if (await tx.run(() => account.ownerExecute(perp.addMargin(p.id, add)), { action: "Add margin", done: "Margin added" })) {
      setText("");
      setAdding(false);
      refresh();
    }
  };

  return (
    <li className="flex flex-col gap-3 rounded-2xl border border-line px-3.5 py-3" data-testid="perp-position">
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="flex items-center gap-1.5">
            <Badge tone={p.isLong ? "up" : "down"}>{p.isLong ? "Long" : "Short"}</Badge>
            {p.liquidatable ? (
              <Badge tone="warn" icon={<AlertTriangle className="size-3" aria-hidden />}>
                At risk
              </Badge>
            ) : null}
          </div>
          <p className="num mt-1.5 text-[12.5px] text-text-2">
            {points(p.entryIndex)} to {points(p.index)}, margin {ausd(Number(p.margin) / 1e6)}
          </p>
        </div>
        <div className="text-right">
          <p className={cn("num font-strong text-[15px]", pnl >= 0n ? "text-up" : "text-down")}>
            <Num value={Number(pnl) / 1e6} format={SIGNED} flash={false} /> AUSD
          </p>
          <p className={cn("num text-[12px]", pnl >= 0n ? "text-up" : "text-down")}>
            <Num value={pnlPct} format={{ minimumFractionDigits: 1, maximumFractionDigits: 1, signDisplay: "exceptZero" }} suffix="%" flash={false} />
          </p>
        </div>
      </div>
      {liq !== null && liq > 0 && liq < INDEX_MAX ? <p className="num text-[12px] text-text-3">Liquidation near {points(liq)}</p> : null}
      {p.retired ? (
        <Note>The trend retired, so this position settles at its final index automatically, with no fee.</Note>
      ) : adding ? (
        <div className="flex flex-col gap-2">
          <AmountField label="Add margin" unit="AUSD" value={text} onChange={setText} decimals={DECIMALS} testId="perp-add-margin" />
          <div className="grid grid-cols-2 gap-2">
            <Button tone="ghost" onClick={() => setAdding(false)} disabled={tx.busy}>
              Cancel
            </Button>
            <Button tone="secondary" disabled={!add} loading={tx.busy} onClick={() => void topUp()} icon={<Fingerprint className="size-4" aria-hidden />}>
              Add {add ? tokenAmount(add, DECIMALS) : ""}
            </Button>
          </div>
        </div>
      ) : (
        <div className="grid grid-cols-2 gap-2">
          <Button tone="secondary" size="sm" onClick={() => setAdding(true)} disabled={tx.busy}>
            Add margin
          </Button>
          <Button tone="danger" size="sm" loading={tx.busy} disabled={index === undefined} onClick={() => void close()} data-testid="perp-close">
            Close
          </Button>
        </div>
      )}
      <TxStatus tx={tx} filledLabel="Done" testId="perp-position-tx" />
    </li>
  );
}
