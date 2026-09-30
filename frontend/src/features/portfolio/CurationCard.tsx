"use client";
import { useQuery } from "@tanstack/react-query";
import { curationFeesAbi } from "@trendr/contracts";
import { Fingerprint, Sparkles } from "lucide-react";
import Link from "next/link";
import { Button, TxStatus } from "@/components/ui";
import { useAccount } from "@/lib/account/AccountProvider";
import type { Trend } from "@/lib/api";
import { publicClient } from "@/lib/chain/client";
import { DEPLOYMENT } from "@/lib/config";
import { ausd } from "@/lib/format";
import { useSheets } from "@/lib/sheets";
import { curation } from "@/lib/trade/calls";
import { useTx } from "@/lib/trade/useTx";
import { trendName } from "@/lib/trends";
import { useRefreshPortfolio } from "./hooks";
import { toAusd } from "./math";
import { SectionCard } from "./parts";

/**
 * Curation fees: whoever first proposed a trend earns a share of its trading fees for as long as
 * it trades. Claiming moves funds out of the fee contract, so it takes one passkey prompt.
 */
export function CurationCard({ claimable, earned, trends }: { claimable: bigint; earned: bigint; trends: Trend[] }) {
  const account = useAccount();
  const refresh = useRefreshPortfolio();
  const open = useSheets((s) => s.open);
  const tx = useTx();
  const mine = trends.filter((t) => account.address && t.surfacer.toLowerCase() === account.address.toLowerCase());
  const perTrend = useQuery({
    queryKey: ["curation-by-trend", mine.map((t) => t.id).join(",")],
    enabled: mine.length > 0,
    refetchInterval: 30_000,
    queryFn: async () => {
      const r = await publicClient.multicall({ allowFailure: true, contracts: mine.map((t) => ({ address: DEPLOYMENT.curationFees, abi: curationFeesAbi, functionName: "earnedByTrend" as const, args: [t.id] as const })) });
      return new Map(mine.map((t, i) => [t.id, r[i]?.status === "success" ? (r[i]!.result as bigint) : 0n]));
    },
  });
  const done = tx.stage === "filled" || tx.stage === "final";

  const claim = async () => {
    const amount = claimable;
    const r = await tx.run(() => account.ownerExecute(curation.claim(account.address!)), { action: "Claim curation fees", done: `Claimed ${ausd(toAusd(amount))} AUSD of curation fees` });
    if (r) refresh();
  };

  return (
    <SectionCard id="curation-title" testId="curation-section" title="Curation earnings" subtitle="Propose a trend first and you earn 15% of its attention perp fees and 10% of its trend coin fees, for as long as it trades." total={ausd(toAusd(earned))} totalLabel="Earned">
      <div className="flex flex-col gap-4 border-t border-line px-4 py-4 sm:px-6">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <p className="text-[11px] uppercase tracking-[0.08em] text-text-3">Ready to claim</p>
            <p className="num-display mt-1 font-display text-[32px] leading-none text-text" data-testid="curation-claimable">
              {ausd(toAusd(claimable))} <span className="font-sans text-[14px] text-text-3">AUSD</span>
            </p>
          </div>
          <Button tone={claimable === 0n ? "secondary" : "primary"} icon={claimable === 0n ? undefined : <Fingerprint className="size-4" aria-hidden />} onClick={claim} loading={tx.busy} disabled={claimable === 0n || done} data-testid="claim-curation" className="sm:min-w-[160px]">
            {claimable === 0n ? "Nothing to claim" : "Claim with passkey"}
          </Button>
        </div>
        <TxStatus tx={tx} filledLabel="Claimed" testId="claim-tx" />
        {mine.length > 0 ? (
          <ul className="flex flex-col divide-y divide-line rounded-xl border border-line">
            {mine.map((t) => (
              <li key={t.id} className="flex items-center justify-between gap-3 px-3.5 py-2.5">
                <Link href={`/t/${t.identifier}`} className="min-w-0 truncate text-[13.5px] text-text underline-offset-4 hover:underline">
                  {trendName(t)}
                </Link>
                <span className="num shrink-0 text-[13px] text-text-2">{perTrend.data ? `${ausd(toAusd(perTrend.data.get(t.id) ?? 0n))} AUSD` : "..."}</span>
              </li>
            ))}
          </ul>
        ) : (
          <div className="flex flex-col gap-3 rounded-xl bg-surface-2 px-4 py-3.5 sm:flex-row sm:items-center sm:justify-between">
            <p className="flex items-start gap-2.5 text-[13px] leading-5 text-text-2">
              <Sparkles className="mt-0.5 size-4 shrink-0 text-primary" aria-hidden />
              None of the live trends came from you yet. Paste a link to what everyone is talking about; if it lists, its fees start paying you.
            </p>
            <Button size="sm" tone="secondary" onClick={() => open("propose")} className="shrink-0">
              Propose a trend
            </Button>
          </div>
        )}
      </div>
    </SectionCard>
  );
}
