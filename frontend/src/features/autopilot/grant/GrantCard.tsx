"use client";
import { perplSessionMaxLeverage } from "@trendr/contracts";
import { Fingerprint, ShieldCheck, ShieldOff } from "lucide-react";
import { useState } from "react";
import { Badge, Button, Card, ErrorNote, Skeleton, TxStatus, cn } from "@/components/ui";
import { DEPLOYMENT } from "@/lib/config";
import { ausd, countdown } from "@/lib/format";
import { useTx } from "@/lib/trade/useTx";
import { Meter, useConfirm } from "../shared/kit";
import { useFollows, useGrant, useRules } from "../shared/data";
import { useGrantActions } from "./grant";
import { GrantSheet, grantLabel, Scope } from "./GrantSheet";

/** The order guard's leverage cap, which an outdated key does not carry. */
const SESSION_MAX_LEVERAGE = perplSessionMaxLeverage(DEPLOYMENT);

const day = (sec: number) => new Date(sec * 1000).toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });

/**
 * Autopilot's access to the account at a glance: what it may spend today, when it ends, and the
 * controls to renew or revoke it. `compact` is the one-line version for the Copy screen.
 */
export function GrantCard({ compact, className }: { compact?: boolean; className?: string }) {
  const grant = useGrant();
  const rules = useRules();
  const follows = useFollows();
  const actions = useGrantActions();
  const tx = useTx();
  const confirm = useConfirm(6000);
  const [sheet, setSheet] = useState(false);
  const g = grant.data;

  if (grant.isLoading || !g) {
    return (
      <Card className={cn("p-5", className)}>
        {grant.error ? (
          <ErrorNote message="Autopilot access could not be checked." onRetry={() => void grant.refetch()} />
        ) : (
          <div className="flex flex-col gap-3" aria-busy>
            <Skeleton className="h-5 w-40" />
            <Skeleton className="h-4 w-full max-w-sm" />
            {compact ? null : <Skeleton className="h-9 w-32" />}
          </div>
        )}
      </Card>
    );
  }

  const running = (rules.data?.rules ?? []).filter((r) => r.status === "enabled").length;
  const copying = (follows.data?.follows ?? []).filter((f) => f.status === "active").length;
  const active = g.state === "active";
  const tone = active && !g.outdated ? "up" : g.state === "none" ? "neutral" : "warn";
  const revoke = async () => {
    if (!g.sessionKey || !confirm.confirm("revoke")) return;
    await actions.revoke(tx, g.sessionKey);
  };

  return (
    <Card className={cn("p-5", className)} data-testid="grant-card" data-state={g.state}>
      <div className={cn("flex gap-4", compact ? "flex-col sm:flex-row sm:items-center" : "flex-col")}>
        <div className="flex min-w-0 flex-1 gap-3">
          <span className={cn("flex size-10 shrink-0 items-center justify-center rounded-xl", active ? "bg-up-soft text-up" : "bg-surface-2 text-text-2")}>
            {active ? <ShieldCheck className="size-5" aria-hidden /> : <ShieldOff className="size-5" aria-hidden />}
          </span>
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="font-strong text-[15px] leading-6 text-text">Autopilot access</h2>
              <Badge tone={tone}>{grantLabel(g)}</Badge>
            </div>
            <p className="mt-0.5 text-[13px] leading-5 text-text-2">
              {active && g.outdated
                ? `Trendr now caps the leverage Autopilot opens at ${SESSION_MAX_LEVERAGE}x. Rules and copies keep running; renew with one passkey prompt to move its key to the new limits.`
                : active
                  ? `Perpl orders and margin only, up to ${ausd(g.dailyLimit)} AUSD a day. Ends ${day(g.validUntil)}, in ${countdown(g.validUntil)}.`
                  : g.state === "none"
                    ? "Rules and copies trade through a Perpl-only key with a daily cap. One passkey prompt grants it."
                    : g.state === "revoked"
                      ? "You revoked Autopilot's key. Rules and copies cannot trade until you grant access again."
                      : "Autopilot's key has expired. Rules and copies cannot trade until you renew it."}
            </p>
          </div>
        </div>
        {active && !compact ? (
          <div className="flex flex-col gap-2">
            <div className="flex items-baseline justify-between gap-3 text-[12.5px]">
              <span className="text-text-2">Used today</span>
              <span className="num font-strong text-text">
                {ausd(g.spentToday)} <span className="font-sans text-text-3">of {ausd(g.dailyLimit)} AUSD</span>
              </span>
            </div>
            <Meter value={g.spentToday} max={g.dailyLimit} label="AUSD used today" tone={g.spentToday >= g.dailyLimit * 0.9 ? "warn" : "primary"} />
          </div>
        ) : null}
        {g.state === "none" && !compact ? (
          <div className="rounded-2xl border border-line p-4">
            <Scope compact />
          </div>
        ) : null}
        <div className={cn("flex flex-wrap gap-2", compact ? "sm:shrink-0" : "")}>
          {active ? (
            <>
              <Button
                tone={g.outdated ? "primary" : "secondary"}
                size="sm"
                icon={g.outdated ? <Fingerprint className="size-4" aria-hidden /> : undefined}
                onClick={() => setSheet(true)}
                disabled={actions.working || tx.busy}
                data-testid="grant-renew"
              >
                Renew
              </Button>
              <Button tone={confirm.armed === "revoke" ? "danger" : "ghost"} size="sm" loading={actions.working || tx.busy} onClick={() => void revoke()} onBlur={confirm.disarm} data-testid="grant-revoke">
                {confirm.armed === "revoke" ? "Confirm with passkey" : "Revoke"}
              </Button>
            </>
          ) : (
            <Button size={compact ? "sm" : "md"} icon={<Fingerprint className="size-4" aria-hidden />} onClick={() => setSheet(true)} data-testid="grant-open">
              {g.state === "none" ? "Grant access" : "Grant again"}
            </Button>
          )}
        </div>
      </div>
      {confirm.armed === "revoke" ? (
        <p className="mt-3 text-[12.5px] leading-5 text-warn" role="status">
          Revoking removes the key from your account
          {running + copying > 0 ? ` and pauses ${[running ? `${running} running rule${running === 1 ? "" : "s"}` : "", copying ? `${copying} cop${copying === 1 ? "y" : "ies"}` : ""].filter(Boolean).join(" and ")}` : ""}. Open positions stay on Perpl until you close them there.
        </p>
      ) : null}
      {tx.stage !== "idle" || actions.error ? (
        <div className="mt-3 flex flex-col gap-2">
          <TxStatus tx={tx} filledLabel="Revoked" />
          {actions.error ? <ErrorNote message={actions.error} /> : null}
        </div>
      ) : null}
      <GrantSheet open={sheet} onOpenChange={setSheet} />
    </Card>
  );
}
