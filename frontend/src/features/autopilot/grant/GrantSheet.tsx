"use client";
import { perplSessionMaxLeverage } from "@trendr/contracts";
import { Check, Fingerprint, KeyRound, X } from "lucide-react";
import { useState } from "react";
import { Button, ErrorNote, Segmented, Sheet, TxStatus } from "@/components/ui";
import { DEPLOYMENT } from "@/lib/config";
import { useTx } from "@/lib/trade/useTx";
import { type GrantView, useGrant } from "../shared/data";
import { DAILY_CAPS, useGrantActions, VALID_DAYS } from "./grant";

type Cap = `${(typeof DAILY_CAPS)[number]}`;
type Days = `${(typeof VALID_DAYS)[number]}`;

/**
 * Grants Autopilot a Perpl-only session key with one passkey prompt, after saying plainly what it
 * can and can never do. `onGranted` continues whatever needed the access (enabling a rule,
 * following a leader).
 */
export function GrantSheet({ open, onOpenChange, onGranted, reason }: { open: boolean; onOpenChange: (o: boolean) => void; onGranted?: () => void; reason?: string }) {
  const grant = useGrant();
  const actions = useGrantActions();
  const tx = useTx();
  // Renewing keeps the current cap when it is one of the choices.
  const [cap, setCap] = useState<Cap>(() => {
    const now = String(Math.round(grant.data?.dailyLimit ?? 0));
    return grant.data?.state === "active" && (DAILY_CAPS as readonly number[]).includes(Number(now)) ? (now as Cap) : "500";
  });
  const [days, setDays] = useState<Days>("30");
  const [done, setDone] = useState(false);
  const current = grant.data;
  const renewing = current?.state === "active";

  // Closing clears the outcome, after the panel has slid away, so the next opening starts clean.
  const change = (o: boolean) => {
    onOpenChange(o);
    if (!o)
      setTimeout(() => {
        setDone(false);
        tx.reset();
        actions.clearError();
      }, 250);
  };

  const busy = actions.working || tx.busy;
  const submit = async () => {
    const ok = await actions.grant(tx, Number(cap), Number(days), current?.state === "active" ? current.sessionKey : null);
    if (!ok) return;
    setDone(true);
    onGranted?.();
  };

  return (
    <Sheet
      open={open}
      onOpenChange={change}
      busy={busy}
      testId="grant-sheet"
      title={renewing ? "Renew Autopilot access" : "Give Autopilot access"}
      description={reason ?? "One passkey prompt lets Autopilot trade Perpl from your account, inside limits you set here."}
      footer={
        done ? (
          <Button block size="lg" tone="secondary" onClick={() => change(false)}>
            Done
          </Button>
        ) : (
          <div className="flex flex-col gap-3">
            <TxStatus tx={tx} filledLabel={renewing ? "Renewed" : "Granted"} />
            {actions.error ? <ErrorNote message={actions.error} /> : null}
            <Button block size="lg" loading={busy} data-testid="grant-approve" icon={<Fingerprint className="size-[18px]" aria-hidden />} onClick={() => void submit()}>
              {renewing ? "Renew with passkey" : "Approve with passkey"}
            </Button>
          </div>
        )
      }
    >
      <div className="flex flex-col gap-5">
        {done ? (
          <div className="flex flex-col items-center gap-3 rounded-2xl border border-line bg-surface-2 px-4 py-6 text-center" data-testid="grant-done">
            <span className="flex size-11 items-center justify-center rounded-full bg-up-soft text-up">
              <Check className="size-5" aria-hidden />
            </span>
            <p className="font-strong text-[15px] text-text">Autopilot can trade for you</p>
            <p className="max-w-xs text-[13px] leading-5 text-text-2">
              Up to {Number(cap).toLocaleString("en-US")} AUSD a day, for {days} days. Revoke it any time from Autopilot.
            </p>
            <TxStatus tx={tx} filledLabel={renewing ? "Renewed" : "Granted"} className="w-full text-left" />
          </div>
        ) : (
          <>
            <Scope />
            <div className="flex flex-col gap-2">
              <p className="font-strong text-[12.5px] text-text-2" id="cap-label">
                Daily cap
              </p>
              <Segmented label="Daily cap in AUSD" value={cap} onChange={setCap} options={DAILY_CAPS.map((c) => ({ value: `${c}` as Cap, label: c.toLocaleString("en-US") }))} />
              <p className="text-[12px] leading-4 text-text-3">AUSD Autopilot may move into Perpl per UTC day, across every rule and copy.</p>
            </div>
            <div className="flex flex-col gap-2">
              <p className="font-strong text-[12.5px] text-text-2">Ends after</p>
              <Segmented label="Access lasts" value={days} onChange={setDays} options={VALID_DAYS.map((d) => ({ value: `${d}` as Days, label: `${d} days` }))} />
            </div>
            <div className="flex gap-3 rounded-2xl border border-line p-4">
              <KeyRound className="mt-0.5 size-[18px] shrink-0 text-primary" aria-hidden />
              <p className="text-[12.5px] leading-5 text-text-2">
                Your device creates a separate key for Autopilot and seals it so only the Autopilot executor can open it: Trendr&rsquo;s servers never see it. Your passkey never leaves your device.
                {renewing ? " Renewing replaces the current key in the same prompt." : ""}
              </p>
            </div>
          </>
        )}
      </div>
    </Sheet>
  );
}

/** What the grant allows and what it never allows. */
export function Scope({ compact }: { compact?: boolean }) {
  // Compact: side by side only when the card itself is wide enough (a container query), whatever the window.
  return (
    <div className="@container">
      <div className={compact ? "grid gap-4 @lg:grid-cols-2" : "flex flex-col gap-4"}>
        <div className="flex flex-col gap-2">
          <p className="font-strong text-[12.5px] text-text-2">Autopilot can</p>
          <ul className="flex flex-col gap-2 text-[13.5px] leading-5 text-text">
            <Item ok>Open and close Perpl perpetual positions on your account, at up to {perplSessionMaxLeverage(DEPLOYMENT)}x leverage</Item>
            <Item ok>Post AUSD from your account as Perpl margin, up to the daily cap</Item>
          </ul>
        </div>
        <div className="flex flex-col gap-2">
          <p className="font-strong text-[12.5px] text-text-2">Autopilot can never</p>
          <ul className="flex flex-col gap-2 text-[13.5px] leading-5 text-text">
            <Item>Withdraw from Perpl or send AUSD anywhere else</Item>
            <Item>Touch your outcome, attention or spot positions</Item>
            <Item>Act after the access ends or once you revoke it</Item>
          </ul>
        </div>
      </div>
    </div>
  );
}

function Item({ ok, children }: { ok?: boolean; children: React.ReactNode }) {
  return (
    <li className="flex gap-2.5">
      <span className={`mt-0.5 flex size-[18px] shrink-0 items-center justify-center rounded-full ${ok ? "bg-up-soft text-up" : "bg-down-soft text-down"}`}>
        {ok ? <Check className="size-3" strokeWidth={3} aria-hidden /> : <X className="size-3" strokeWidth={3} aria-hidden />}
      </span>
      <span>{children}</span>
    </li>
  );
}

export const grantLabel = (g: GrantView | undefined) =>
  g?.state === "active" ? (g.outdated ? "Renew" : "Active") : g?.state === "expired" ? "Expired" : g?.state === "revoked" ? "Revoked" : "Not granted";
