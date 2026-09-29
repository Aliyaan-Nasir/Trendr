"use client";
import { useQuery } from "@tanstack/react-query";
import { ArrowDown, Check, Copy, Droplets, Globe2, Loader2 } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { Badge, Button, Card, CardHeader, cn, Empty, ErrorNote, Field, Row } from "@/components/ui";
import { useAccount } from "@/lib/account/AccountProvider";
import { parseAmount } from "@/lib/amount";
import { ApiError, type DepositChain, type DepositRequest, type DepositView, deposits } from "@/lib/api";
import { DEPLOYMENT } from "@/lib/config";
import { ausd } from "@/lib/format";
import { useCopy } from "@/lib/hooks/useCopy";
import { useSheets } from "@/lib/sheets";
import { ConvertCard } from "./ConvertCard";

/**
 * Any-chain deposits through Aurora Intents: pick what you hold and where, see a live quote, then
 * (on Mainnet) send to a one-time deposit address. Aurora delivers USDC to the Trendr account on
 * Monad and refunds to the sender's own address if anything fails; ConvertCard turns it into AUSD.
 */

const SETTLED = new Set(["succeeded", "refunded", "failed", "expired"]);
const EVM = /^0x[0-9a-fA-F]{40}$/;
const EVM_CHAINS = new Set(["eth", "base", "arb", "op", "pol", "bsc", "avax", "gnosis", "bera", "monad", "abstract", "adi", "xlayer", "plasma", "aurora", "scroll", "linea", "zksync", "sonic", "unichain", "flare", "hyperevm"]);

function useDebounced<T>(value: T, ms: number): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

export default function DepositPage() {
  const account = useAccount();
  const openSheet = useSheets((s) => s.open);
  const tokens = useQuery({ queryKey: ["deposit-tokens"], queryFn: () => deposits.tokens(), staleTime: 300_000 });
  const chains = tokens.data?.chains ?? [];
  const live = tokens.data?.live ?? false;
  const [chainId, setChainId] = useState("base");
  const chain: DepositChain | undefined = chains.find((c) => c.blockchain === chainId) ?? chains[0];
  const [assetId, setAssetId] = useState<string | null>(null);
  const asset = chain?.tokens.find((t) => t.assetId === assetId) ?? chain?.tokens.find((t) => t.symbol === "USDC") ?? chain?.tokens[0];
  const [amountText, setAmountText] = useState("25");
  const [refundTo, setRefundTo] = useState("");
  const [deposit, setDeposit] = useState<DepositView | null>(null);
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);

  const raw = asset ? parseAmount(amountText, asset.decimals) : null;
  const evm = chain ? EVM_CHAINS.has(chain.blockchain) : false;
  const refundError = refundTo.trim() === "" ? null : evm && !EVM.test(refundTo.trim()) ? `Enter your ${chain?.name} address (0x...)` : null;
  const request: DepositRequest | null =
    asset && raw && refundTo.trim() && !refundError ? { originAssetId: asset.assetId, amount: raw.toString(), refundTo: refundTo.trim(), account: account.address ?? DEPLOYMENT.treasury } : null;
  const debounced = useDebounced(request, 500);
  const quote = useQuery({ queryKey: ["deposit-quote", debounced], enabled: debounced !== null, queryFn: () => deposits.quote(debounced!), staleTime: 20_000, retry: false });
  const usd = asset && raw ? (Number(raw) / 10 ** asset.decimals) * asset.price : null;

  const create = async () => {
    if (!request || !account.address) return;
    setCreating(true);
    setCreateError(null);
    try {
      setDeposit(await deposits.create({ ...request, account: account.address }));
    } catch (e) {
      setCreateError(e instanceof ApiError ? e.message : "Could not create a deposit address.");
    } finally {
      setCreating(false);
    }
  };

  return (
    <div className="mx-auto flex w-full max-w-[640px] flex-col gap-6">
      <header>
        <p className="font-strong text-[12px] uppercase tracking-[0.14em] text-primary">Aurora Intents</p>
        <h1 className="mt-2 font-display text-[32px] leading-[1.1] text-text sm:text-[38px]">Add funds from any chain</h1>
        <p className="mt-2 text-[14.5px] leading-6 text-text-2">Send USDC, USDT, ETH, SOL, BTC and more from 35 chains. Aurora delivers it to your Trendr account on Monad as USDC, and refunds to you if anything goes wrong. Then convert the USDC to AUSD, the dollar Trendr trades in, with one passkey prompt.</p>
      </header>

      {!live && tokens.data ? (
        <div className="flex flex-col gap-3 rounded-2xl border border-line bg-surface px-4 py-3.5 sm:flex-row sm:items-center sm:justify-between">
          <p className="text-[13px] leading-5 text-text-2">
            <Badge tone="warn" className="mr-1.5 align-[1px]">Testnet</Badge>
            Quotes here are live Aurora prices. Deposit addresses open on Monad Mainnet; on Testnet, use test AUSD.
          </p>
          <Button size="sm" tone="secondary" icon={<Droplets className="size-4" aria-hidden />} onClick={() => openSheet("deposit")}>
            Get test AUSD
          </Button>
        </div>
      ) : null}

      <ConvertCard />

      <Card className="flex flex-col gap-5 p-5">
        {tokens.error ? <ErrorNote message="Aurora's asset list could not load." onRetry={() => void tokens.refetch()} /> : null}
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Select label="From chain" value={chain?.blockchain ?? ""} onChange={(v) => { setChainId(v); setAssetId(null); }} disabled={!chains.length} testId="deposit-chain">
            {chains.map((c) => (
              <option key={c.blockchain} value={c.blockchain}>
                {c.name}
              </option>
            ))}
          </Select>
          <Select label="Asset" value={asset?.assetId ?? ""} onChange={setAssetId} disabled={!chain} testId="deposit-asset">
            {chain?.tokens.map((t) => (
              <option key={t.assetId} value={t.assetId}>
                {t.symbol}
              </option>
            ))}
          </Select>
        </div>
        <Field
          label="Amount"
          inputMode="decimal"
          value={amountText}
          onChange={(e) => setAmountText(e.target.value.replace(/[^\d.]/g, ""))}
          suffix={asset?.symbol}
          hint={usd !== null ? `About $${ausd(usd)}` : undefined}
          data-testid="deposit-amount"
        />
        <Field
          label={`Your address on ${chain?.name ?? "that chain"}`}
          value={refundTo}
          onChange={(e) => setRefundTo(e.target.value.trim())}
          placeholder={evm ? "0x..." : "Your wallet address"}
          autoComplete="off"
          spellCheck={false}
          error={refundError}
          hint="The wallet you send from. If the deposit cannot complete, Aurora refunds there, so not an exchange address."
          data-testid="deposit-refund"
        />

        <div className="flex flex-col gap-2 rounded-xl border border-line px-3.5 py-3" aria-live="polite">
          {quote.isFetching && !quote.data ? (
            <p className="flex items-center gap-2 text-[13px] text-text-3">
              <Loader2 className="size-3.5 animate-spin" aria-hidden /> Asking Aurora for a quote
            </p>
          ) : quote.error ? (
            <p className="text-[13px] text-down">{quote.error instanceof ApiError ? quote.error.message : "No quote right now."}</p>
          ) : quote.data ? (
            <>
              <Row label="You send" value={`${quote.data.state.amountInFormatted} ${quote.data.state.origin.symbol}`} />
              <div className="flex justify-center text-text-3">
                <ArrowDown className="size-3.5" aria-hidden />
              </div>
              <Row label="Arrives on Monad" value={`${quote.data.state.amountOutFormatted} ${quote.data.state.destination.symbol}`} tone="up" />
              <Row label="Time" value={`About ${Math.max(1, Math.round(quote.data.state.timeEstimateSeconds / 60))} min after it lands`} tone="muted" />
            </>
          ) : (
            <p className="text-[13px] text-text-3">Enter an amount and your address to see a live quote.</p>
          )}
        </div>

        {!account.authenticated ? (
          <Button block size="lg" onClick={account.login}>
            Sign in to deposit
          </Button>
        ) : (
          <Button block size="lg" disabled={!live || !quote.data || Boolean(deposit && !SETTLED.has(deposit.state.phase))} loading={creating} onClick={() => void create()} data-testid="deposit-create">
            {live ? "Get deposit address" : "Deposit addresses open on Mainnet"}
          </Button>
        )}
        {createError ? <ErrorNote message={createError} /> : null}
      </Card>

      {deposit?.id ? <Tracker initial={deposit} /> : null}
      {live && account.backendReady ? <History /> : null}
    </div>
  );
}

function Select({ label, value, onChange, children, disabled, testId }: { label: string; value: string; onChange: (v: string) => void; children: React.ReactNode; disabled?: boolean; testId?: string }) {
  return (
    <label className="flex flex-col gap-1.5">
      <span className="font-strong text-[12.5px] text-text-2">{label}</span>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        disabled={disabled}
        data-testid={testId}
        className="h-11 w-full appearance-none rounded-xl border border-line bg-surface-2 bg-[length:16px] bg-[right_12px_center] bg-no-repeat px-3 pr-9 text-[15px] text-text outline-none transition-colors focus:border-primary disabled:opacity-50"
        style={{ backgroundImage: "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='%23888' stroke-width='2'%3E%3Cpath d='m6 9 6 6 6-6'/%3E%3C/svg%3E\")" }}
      >
        {children}
      </select>
    </label>
  );
}

/** A live deposit: where to send, what to send, and its progress until it settles. */
function Tracker({ initial }: { initial: DepositView }) {
  const { copied, copy: copyText } = useCopy();
  const [tx, setTx] = useState("");
  const [sending, setSending] = useState(false);
  const q = useQuery({
    queryKey: ["deposit", initial.id],
    queryFn: () => deposits.get(initial.id!),
    initialData: initial,
    refetchInterval: (query) => (SETTLED.has(query.state.data?.state.phase ?? "") ? false : 6_000),
  });
  const d = q.data;
  const s = d.state;
  const settled = SETTLED.has(s.phase);
  const copy = async () => {
    if (!s.depositAddress) return;
    await copyText(s.depositAddress, "Deposit address copied");
  };
  const submit = async () => {
    if (!tx.trim()) return;
    setSending(true);
    try {
      await deposits.submitTx(initial.id!, tx.trim());
      setTx("");
      void q.refetch();
    } finally {
      setSending(false);
    }
  };
  return (
    <Card data-testid="deposit-tracker">
      <CardHeader title={d.message.title} subtitle={d.message.body} action={<Badge tone={s.phase === "succeeded" ? "up" : s.phase === "refunded" || s.phase === "failed" ? "down" : "primary"}>{s.phase.replace(/_/g, " ")}</Badge>} />
      <div className="flex flex-col gap-4 px-5 pb-5 pt-4">
        {s.depositAddress && !settled ? (
          <>
            <button type="button" onClick={() => void copy()} className="flex items-start justify-between gap-3 rounded-xl border border-line bg-surface-2 px-3.5 py-3 text-left transition-colors hover:border-line-strong">
              <span className="min-w-0 break-all font-mono text-[13px] leading-5 text-text">{s.depositAddress}</span>
              {copied ? <Check className="mt-0.5 size-4 shrink-0 text-up" aria-hidden /> : <Copy className="mt-0.5 size-4 shrink-0 text-text-3" aria-hidden />}
              <span className="sr-only">Copy the deposit address</span>
            </button>
            {d.message.requirements.length ? (
              <ul className="flex list-disc flex-col gap-1 pl-5 text-[12.5px] leading-[18px] text-text-2">
                {d.message.requirements.map((r) => (
                  <li key={r}>{r}</li>
                ))}
              </ul>
            ) : null}
            <div className="flex gap-2">
              <input value={tx} onChange={(e) => setTx(e.target.value.trim())} placeholder="Paste your transaction hash (optional)" className="h-10 min-w-0 flex-1 rounded-xl border border-line bg-surface-2 px-3 font-mono text-[12.5px] text-text outline-none placeholder:font-sans placeholder:text-text-3 focus:border-primary" />
              <Button tone="secondary" disabled={!tx} loading={sending} onClick={() => void submit()}>
                Send
              </Button>
            </div>
          </>
        ) : null}
        {d.message.support ? <p className="text-[12px] text-text-3">For support, share the deposit address and transaction hashes above with Aurora.</p> : null}
        {d.message.links.map((l) => (
          <a key={l} href={l} target="_blank" rel="noreferrer" className={cn("truncate text-[12.5px] text-primary hover:underline")}>
            {l}
          </a>
        ))}
      </div>
    </Card>
  );
}

function History() {
  const list = useQuery({ queryKey: ["deposits"], queryFn: () => deposits.list(), refetchInterval: 20_000 });
  const rows = useMemo(() => list.data?.deposits ?? [], [list.data]);
  if (!rows.length) return list.isLoading ? null : <Empty icon={<Globe2 className="size-6" />} title="No deposits yet" body="Your any-chain deposits show here with their status." />;
  return (
    <Card>
      <CardHeader title="Your deposits" />
      <ul className="divide-y divide-line px-5 pb-2 pt-2">
        {rows.map((r) => (
          <li key={r.id} className="flex items-center justify-between gap-3 py-3 text-[13px]">
            <span className="text-text">
              {r.state.amountInFormatted} {r.state.origin.symbol}
            </span>
            <Badge tone={r.state.phase === "succeeded" ? "up" : r.state.phase === "refunded" || r.state.phase === "failed" ? "down" : "neutral"}>{r.state.phase.replace(/_/g, " ")}</Badge>
          </li>
        ))}
      </ul>
    </Card>
  );
}
