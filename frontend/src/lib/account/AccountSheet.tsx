"use client";
import { Check, Copy, Fingerprint, KeyRound, Loader2, LogOut, Settings, ShieldCheck, Sparkles, Timer } from "lucide-react";
import { Badge, Button, ButtonLink, cn, DrawnCheck, ErrorNote, ExplorerLink, Sheet } from "@/components/ui";
import { explorerAddress } from "@/lib/config";
import { shortAddress } from "@/lib/format";
import { useCopy } from "@/lib/hooks/useCopy";
import { WaitlistEntry } from "@/features/waitlist/WaitlistEntry";
import type { SignUpStep } from "./account-service";
import { useAccount } from "./AccountProvider";

function formatUntil(seconds: number) {
  return new Date(seconds * 1000).toLocaleString(undefined, { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

const STEPS: Array<{ step: SignUpStep; title: string; note: string }> = [
  { step: "passkey", title: "Create your passkey", note: "Confirm with Face ID, Touch ID or your device's PIN." },
  { step: "account", title: "Deploy your account on Monad", note: "Trendr pays the gas." },
  { step: "session", title: "Start your trading session", note: "A week of trades without prompts, up to 500 AUSD a day." },
  { step: "sync", title: "Sync with Trendr", note: "So Autopilot, follows and alerts know your account." },
];

/** Account creation as it happens: each real stage checks off as it completes. */
function SignUpChecklist({ step }: { step: SignUpStep | "done" }) {
  const at = step === "done" ? STEPS.length : STEPS.findIndex((s) => s.step === step);
  return (
    <ol className="flex flex-col gap-1 rounded-2xl border border-line bg-surface-2 p-2" aria-label="Creating your account" data-testid="signup-steps" data-step={step}>
      {STEPS.map((s, i) => {
        const state = i < at ? "done" : i === at ? "active" : "waiting";
        return (
          <li key={s.step} className="flex items-start gap-3 rounded-xl px-2.5 py-2.5" aria-current={state === "active" ? "step" : undefined}>
            <span
              className={cn(
                "mt-px flex size-6 shrink-0 items-center justify-center rounded-full transition-colors duration-300",
                state === "done" ? "bg-up-soft text-up" : state === "active" ? "bg-primary-soft text-primary" : "border border-line text-text-3",
              )}
            >
              {state === "done" ? <DrawnCheck className="size-3.5" /> : state === "active" ? <Loader2 className="size-3.5 animate-spin" aria-hidden /> : <span className="num text-[11px]">{i + 1}</span>}
            </span>
            <span className="min-w-0">
              <span className={cn("block font-strong text-[14px] leading-6 transition-colors duration-300", state === "waiting" ? "text-text-3" : "text-text")}>{s.title}</span>
              <span className={cn("block text-[12.5px] leading-[18px] transition-colors duration-300", state === "waiting" ? "text-text-3" : "text-text-2")}>{s.note}</span>
            </span>
            <span className="sr-only">{state === "done" ? "done" : state === "active" ? "in progress" : "waiting"}</span>
          </li>
        );
      })}
    </ol>
  );
}

/** Create, sign in, renew and inspect the passkey account. */
export default function AccountSheet({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const { status, sessionOutdated, upgradeRequired, session, error, signUp, signIn, renewSession, upgrade, logout, privateIdentity, backendReady, signUpStep } = useAccount();
  const { copied, copy } = useCopy();
  const working = status === "working";

  const active = status === "active" && session && !signUpStep;
  return (
    <Sheet
      open={open}
      onOpenChange={onOpenChange}
      busy={working}
      testId="account-sheet"
      title={active ? "Your Trendr account" : signUpStep ? (signUpStep === "done" ? "You are in" : "Creating your account") : status === "session-expired" ? (upgradeRequired ? "Upgrade your account" : "Renew your session") : "Trade attention with a passkey"}
      description={
        active
          ? "A smart account on Monad, owned by your passkey."
          : signUpStep
            ? "One passkey prompt, then Trendr does the rest. No gas, no seed phrase."
          : upgradeRequired && status === "session-expired"
            ? "One passkey prompt, no gas. Same address, funds and positions."
            : "No seed phrase, no extension, no gas. Your passkey is the account."
      }
    >
      <div className="flex flex-col gap-5">
        {signUpStep ? (
          <SignUpChecklist step={signUpStep} />
        ) : active ? (
          <>
            <div className="flex flex-col items-center gap-3 rounded-2xl border border-line bg-surface-2 px-4 py-5 text-center">
              <div className="flex size-12 items-center justify-center rounded-full bg-primary-soft text-primary">
                <ShieldCheck className="size-6" aria-hidden />
              </div>
              <button
                type="button"
                onClick={() => void copy(session.address, "Address copied")}
                data-testid="account-address"
                data-address={session.address}
                className="num flex items-center gap-2 rounded-lg border border-line bg-surface px-3 py-1.5 font-mono text-[13px] text-text-2 transition-colors hover:text-text"
              >
                {shortAddress(session.address)}
                {copied ? <Check className="size-3.5 text-up" aria-hidden /> : <Copy className="size-3.5" aria-hidden />}
                <span className="sr-only">Copy address</span>
              </button>
              <div className="flex flex-wrap justify-center gap-1.5">
                <Badge tone="up">Gas-free</Badge>
                <Badge tone={backendReady ? "primary" : "neutral"}>{backendReady ? "Synced" : "Connecting"}</Badge>
                <Badge tone={privateIdentity ? "primary" : "neutral"}>{privateIdentity ? "Private keys on this device" : "Private keys locked"}</Badge>
              </div>
            </div>
            <div className="flex items-start gap-3 rounded-2xl border border-line p-4">
              <Timer className="mt-0.5 size-[18px] shrink-0 text-primary" aria-hidden />
              <p className="text-[13.5px] leading-5 text-text-2">
                Trading works without prompts until <span className="text-text">{formatUntil(session.validUntil)}</span>, opening up to 500 AUSD of trades a day. Withdrawals, new permissions, follows, enabling rules and identity links always ask for your passkey.
              </p>
            </div>
            <WaitlistEntry account={session.address} onOpen={() => onOpenChange(false)} />
            <div className="flex flex-col gap-2">
              <ButtonLink href="/settings" tone="secondary" block onClick={() => onOpenChange(false)}>
                <Settings className="size-4" aria-hidden />
                Settings
              </ButtonLink>
              <ExplorerLink href={explorerAddress(session.address)} className="justify-center self-center py-1 text-[13px] text-text-2" testId="account-explorer" />
              <Button tone="secondary" block icon={<LogOut className="size-4" aria-hidden />} onClick={() => void logout()}>
                Sign out on this device
              </Button>
            </div>
          </>
        ) : status === "session-expired" && upgradeRequired ? (
          <>
            <p className="text-[14px] leading-6 text-text-2">Trendr moved its accounts to a safer version. Upgrade once to keep trading without prompts.</p>
            <ul className="flex flex-col gap-3 text-[13.5px] leading-5 text-text-2">
              <li className="flex gap-3">
                <ShieldCheck className="mt-0.5 size-[18px] shrink-0 text-primary" aria-hidden />
                A trading session&rsquo;s daily allowance counts every trade it opens, and its Perpl orders stay within 2% of Perpl&rsquo;s price.
              </li>
              <li className="flex gap-3">
                <KeyRound className="mt-0.5 size-[18px] shrink-0 text-primary" aria-hidden />
                Your passkey, address, funds and positions stay exactly as they are.
              </li>
              <li className="flex gap-3">
                <Sparkles className="mt-0.5 size-[18px] shrink-0 text-primary" aria-hidden />
                If Autopilot trades for you, grant it access again once you have upgraded.
              </li>
            </ul>
            <Button size="lg" block loading={working} data-testid="upgrade-account" icon={<Fingerprint className="size-[18px]" aria-hidden />} onClick={() => void upgrade()}>
              Upgrade with passkey
            </Button>
          </>
        ) : status === "session-expired" ? (
          <>
            <p className="text-[14px] leading-6 text-text-2">
              {sessionOutdated ? "Trendr tightened what a trading session may do. One passkey prompt renews yours with the new limits, for another week." : "Your trading session ended. One passkey prompt renews it for another week."}
            </p>
            <Button size="lg" block loading={working} icon={<Fingerprint className="size-[18px]" aria-hidden />} onClick={() => void renewSession()}>
              Renew with passkey
            </Button>
          </>
        ) : (
          <>
            <ul className="flex flex-col gap-3 text-[13.5px] leading-5 text-text-2">
              <li className="flex gap-3">
                <Fingerprint className="mt-0.5 size-[18px] shrink-0 text-primary" aria-hidden />
                One passkey prompt creates your account and a week-long trading session.
              </li>
              <li className="flex gap-3">
                <KeyRound className="mt-0.5 size-[18px] shrink-0 text-primary" aria-hidden />
                Clear this browser or switch devices: your passkey rebuilds everything.
              </li>
              <li className="flex gap-3">
                <ShieldCheck className="mt-0.5 size-[18px] shrink-0 text-primary" aria-hidden />
                Trendr pays the gas. Nothing moves your funds without your passkey or a capped session.
              </li>
            </ul>
            <div className="flex flex-col gap-2">
              <Button size="lg" block loading={working} data-testid="create-account" icon={<Fingerprint className="size-[18px]" aria-hidden />} onClick={() => void signUp()}>
                Create account
              </Button>
              <Button size="lg" tone="secondary" block disabled={working} data-testid="sign-in" onClick={() => void signIn()}>
                I already have a passkey
              </Button>
            </div>
          </>
        )}
        {error ? <ErrorNote message={error} className="[&_p]:text-[13px]" /> : null}
        {error ? <span data-testid="account-error" className="sr-only">{error}</span> : null}
      </div>
    </Sheet>
  );
}
