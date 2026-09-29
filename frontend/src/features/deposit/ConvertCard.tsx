"use client";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { conversionMinOut, stableSwapAbi, type UsdcConversion, usdcConversion, usdcToAusdCalls } from "@trendr/contracts";
import { ArrowDown, Fingerprint } from "lucide-react";
import { erc20Abi } from "viem";
import { Button, Card, CardHeader, ErrorNote, Row, TxStatus } from "@/components/ui";
import { useAccount } from "@/lib/account/AccountProvider";
import { publicClient } from "@/lib/chain/client";
import { CHAIN_ID } from "@/lib/config";
import { ausd } from "@/lib/format";
import { type Tx, useTx } from "@/lib/trade/useTx";

/**
 * Aurora deposits land as USDC, and Trendr trades in AUSD. While the account holds USDC, this card
 * converts all of it in Monad's AUSD stable pool with one passkey prompt: approve exactly that
 * amount to the pool, then exchange it for AUSD paid to the account, at no less than the pool's
 * quote less 0.3% and never under 0.99 AUSD per USDC. Mainnet only (Aurora serves no Testnet).
 */

const CONVERSION = usdcConversion(CHAIN_ID);
const units = (raw: bigint) => Number(raw) / 1e6;

export function ConvertCard() {
  return CONVERSION ? <Convert c={CONVERSION} /> : null;
}

function Convert({ c }: { c: UsdcConversion }) {
  const account = useAccount();
  const client = useQueryClient();
  const tx = useTx();
  const address = account.authenticated ? account.address : undefined;
  const state = useQuery({
    queryKey: ["usdc-conversion", address],
    enabled: Boolean(address),
    refetchInterval: 6_000,
    queryFn: async () => {
      const balance = await publicClient.readContract({ address: c.usdc, abi: erc20Abi, functionName: "balanceOf", args: [address!] });
      const quote = balance > 0n ? await publicClient.readContract({ address: c.pool, abi: stableSwapAbi, functionName: "get_dy", args: [c.usdcIndex, c.ausdIndex, balance] }) : 0n;
      return { balance, quote };
    },
  });
  const balance = state.data?.balance ?? 0n;
  const quote = state.data?.quote ?? 0n;
  // Keep the card through the conversion so its result stays on screen once the USDC is gone.
  if (!address || (balance === 0n && tx.stage === "idle")) return null;
  const minOut = conversionMinOut(balance, quote);

  const convert = async () => {
    if (!minOut) return;
    const amount = balance;
    const r = await tx.run(() => account.ownerExecute(usdcToAusdCalls(c, address, amount, minOut)), { action: "Convert USDC", done: `Converted ${ausd(units(amount))} USDC to AUSD` });
    if (r) {
      void client.invalidateQueries({ queryKey: ["ausd"] });
      void state.refetch();
    }
  };

  return <ConvertView balance={balance} quote={quote} minOut={minOut} tx={tx} onConvert={() => void convert()} />;
}

/** The card itself: the USDC held, what it converts to, and the passkey button. */
export function ConvertView({ balance, quote, minOut, tx, onConvert }: { balance: bigint; quote: bigint; minOut: bigint | null; tx: Tx; onConvert: () => void }) {
  return (
    <Card data-testid="usdc-convert">
      <CardHeader title="Convert your USDC to AUSD" subtitle="Aurora delivers USDC. Trendr trades in AUSD, so convert it in Monad's AUSD stable pool: one passkey prompt, no MON needed." />
      <div className="flex flex-col gap-4 px-5 pb-5 pt-4">
        {balance > 0n ? (
          <div className="flex flex-col gap-2 rounded-xl border border-line px-3.5 py-3">
            <Row label="USDC in your account" value={`${ausd(units(balance))} USDC`} />
            <div className="flex justify-center text-text-3">
              <ArrowDown className="size-3.5" aria-hidden />
            </div>
            <Row label="You receive" value={`${ausd(units(quote))} AUSD`} tone={minOut ? "up" : "down"} />
            {minOut ? <Row label="At least" value={`${ausd(units(minOut))} AUSD`} tone="muted" /> : null}
          </div>
        ) : null}
        {balance > 0n && !minOut ? <ErrorNote message="The pool pays under 0.99 AUSD per USDC right now, so converting would lose too much. Try again later." /> : null}
        {balance > 0n ? (
          <Button block size="lg" icon={<Fingerprint className="size-4" aria-hidden />} onClick={onConvert} loading={tx.busy} disabled={!minOut || tx.busy} data-testid="usdc-convert-button">
            Convert with passkey
          </Button>
        ) : null}
        <TxStatus tx={tx} filledLabel="Converted" testId="usdc-convert-tx" />
      </div>
    </Card>
  );
}
