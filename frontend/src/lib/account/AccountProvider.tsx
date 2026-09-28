"use client";
import { isMeraError } from "@category-labs/mera";
import type { Call } from "@trendr/contracts";
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { getAddress } from "viem";
import { activation, ApiError, type Approve, auth, ownerApprovals, setReauth, setUserToken } from "@/lib/api";
import { disablePush } from "@/lib/push";
import { CHAIN_ID, DEPLOYMENT, explorerAddress, RELAYER_URL, RPC_URLS } from "@/lib/config";
import { rateLimitMessage, waitText } from "@/lib/rate-limit";
import { notify } from "@/lib/toast";
import {
  AccountNotActivatedError,
  AccountService,
  AccountUpgradeRequiredError,
  type ActiveAccount,
  type PrivateIdentity,
  SessionExpiredError,
  SessionOutdatedError,
  type SignUpStep,
} from "./account-service";
import AccountSheet from "./AccountSheet";
import { setAccountHint } from "./hint";
import { approveAsOwner } from "./owner-approval";
import { createRelayerClient, type Relayed, RelayerError } from "./relayer";

export type AccountStatus = "loading" | "signed-out" | "working" | "session-expired" | "active";

/** The account the app trades with. Mera passkeys are the only account layer. */
export interface Account {
  /** True once the account layer has restored any existing session. */
  ready: boolean;
  /** True when a trading session is active. */
  authenticated: boolean;
  status: AccountStatus;
  /** With status session-expired: the session is still live but predates the current permissions. */
  sessionOutdated: boolean;
  /** With status session-expired: the account runs PasskeyAccount version 1 and must upgrade once. */
  upgradeRequired: boolean;
  /** The trading account address (the user's EIP-7702 delegated account). */
  address: `0x${string}` | undefined;
  session: ActiveAccount | null;
  /** True once the backend accepted this account's sign-in (needed for Autopilot, follows, alerts). */
  backendReady: boolean;
  /** The private-data identity (caller key, vault key), when this device holds it. */
  privateIdentity: PrivateIdentity | null;
  /** While an account is being created: the stage it is at ("done" for a moment once synced). */
  signUpStep: SignUpStep | "done" | null;
  /** Opens the account sheet (create or sign in). */
  login(): void;
  signUp(): Promise<void>;
  signIn(): Promise<void>;
  renewSession(): Promise<void>;
  /** One passkey prompt: the one-time upgrade of a version 1 account, which also starts a session. */
  upgrade(): Promise<void>;
  /** One passkey prompt: rebuilds the private-data keys on this device. */
  unlockPrivate(): Promise<PrivateIdentity>;
  /** Prompt-free, gas-free trade within the session's limits. */
  trade(calls: Call[]): Promise<Relayed>;
  /** One passkey prompt: an owner action such as a withdrawal or a new session key. */
  ownerExecute(calls: Call[]): Promise<Relayed>;
  /** One passkey prompt: approves a backend action a session alone may not take (a follow, enabling a rule, a link). */
  approve: Approve;
  logout(): Promise<void>;
  error: string | null;
}

const AccountContext = createContext<Account | null>(null);

const SESSION_LIFETIME_SEC = 7 * 86_400;
/** How long the sign-up checklist stays complete before the sheet shows the new account. */
const SIGNED_UP_HOLD_MS = 900;
const SESSION_DAILY_LIMIT = 500_000_000n; // 500 AUSD
const TOKEN_KEY = "trendr.backend-token";

/** Plain-language messages for the failures users can act on. */
export function describeError(e: unknown): string {
  if (isMeraError(e)) {
    if (e.code === "PRF_UNAVAILABLE") {
      return "This passkey provider does not support the passkey extension Trendr needs (PRF). Use iCloud Keychain, Google Password Manager, 1Password, or your phone.";
    }
    if (e.code === "PASSKEY_OPERATION_FAILED") return "The passkey request was cancelled or timed out.";
  }
  if (e instanceof AccountNotActivatedError) return "This passkey has no Trendr account yet. Create one instead.";
  if (e instanceof AccountUpgradeRequiredError) return e.message;
  if (e instanceof SessionOutdatedError) return e.message;
  if (e instanceof SessionExpiredError) return "Your trading session ended. Renew it with your passkey.";
  if (e instanceof RelayerError) {
    if (e.code === "unreachable") return "Trendr's relayer could not be reached, so nothing was sent. Check your connection and try again.";
    if (e.code === "rate_limited") return rateLimitMessage(null, e.retryAfter);
    if (e.code === "account_busy") return "Your last request is still going through. Wait a moment and try again.";
    if (e.code === "account_cooldown") return "Several of your recent transactions failed, so gas-free trading is paused for this account for a while.";
    if (e.code === "account_budget") return "You have reached today's gas-free trading allowance. It resets at midnight UTC.";
    if (e.code === "relayer_budget" || e.code === "activation_budget") return `Trendr is very busy right now. Try again in ${e.retryAfter !== null ? waitText(e.retryAfter) : "a few minutes"}.`;
    if (e.code === "policy") return "That action is not available from a trading session.";
    if (e.code === "ticket_required" || e.code === "ticket_expired" || e.code === "bad_ticket") return "Trendr could not confirm this new account in time. Try creating it again.";
    if (e.code === "upgrade_required") return "This account needs its one-time upgrade first. Sign in with your passkey to upgrade it.";
    if (e.code === "already_upgraded") return "This account is already upgraded. Sign in with your passkey.";
    if (e.code === "simulation_failed") return describeRevert(e.message);
    return `The transaction could not be sent: ${e.message}`;
  }
  // The API client already wrote its refusals for people: why, and when to try again.
  if (e instanceof ApiError && e.status === 429) return e.message;
  const text = e instanceof Error ? e.message : "";
  if (/rate limit|requests limited|too many requests|429/i.test(text)) return "The network is busy right now. Try again in a few seconds.";
  if (/fetch failed|network error|failed to fetch|timed? ?out/i.test(text)) return "Monad could not be reached. Check your connection and try again.";
  return text || "Something went wrong.";
}

const ausdOf = (raw: string) => (Number(raw) / 1e6).toLocaleString(undefined, { maximumFractionDigits: 2 });

/** Plain words for the account's own refusals of a session batch; anything else as the chain said it. */
export function describeRevert(reason: string): string {
  const limit = reason.match(/SpendLimitExceeded\((\d+), (\d+)\)/);
  if (limit) {
    return `This would put ${ausdOf(limit[1]!)} AUSD into trades, more than the ${ausdOf(limit[2]!)} AUSD your session has left today. The allowance counts every trade you open, resets at midnight UTC, and closing positions does not add to it.`;
  }
  if (/PriceOutsideBand/.test(reason)) return "Perpl's price moved: this order's limit is more than 2% from Perpl's mark price. Refresh the price and try again.";
  if (/StaleMark/.test(reason)) return "Perpl's mark price has not updated for a while, so session orders are paused. Try again in a minute.";
  if (/MustBeImmediate|OrderTypeNotAllowed/.test(reason)) return "A trading session places only immediate Perpl orders that open or close a position.";
  const leverage = reason.match(/LeverageNotAllowed\(\d+, (\d+), (\d+)\)/);
  if (leverage) return `A trading session opens Perpl positions at up to ${Number(leverage[2]) / 100}x. Lower the leverage, or confirm a higher one with your passkey.`;
  return `The transaction would fail: ${reason}`;
}

/** A backend token kept for this tab, reused only for the same account and the same session key. */
function storedToken(account: string, signer: string): string | null {
  try {
    const raw = sessionStorage.getItem(TOKEN_KEY);
    const t = raw ? (JSON.parse(raw) as { account: string; signer?: string; token: string; expiresAt: number }) : null;
    return t && t.account === account.toLowerCase() && t.signer === signer.toLowerCase() && t.expiresAt > Date.now() / 1000 + 60 ? t.token : null;
  } catch {
    return null;
  }
}

export default function AccountProvider({ children }: { children: React.ReactNode }) {
  const service = useRef<AccountService | null>(null);
  const [status, setStatus] = useState<AccountStatus>("loading");
  const [sessionOutdated, setSessionOutdated] = useState(false);
  const [upgradeRequired, setUpgradeRequired] = useState(false);
  const [session, setSession] = useState<ActiveAccount | null>(null);
  const [privateIdentity, setPrivateIdentity] = useState<PrivateIdentity | null>(null);
  const [backendReady, setBackendReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sheetOpen, setSheetOpen] = useState(false);
  const [signUpStep, setSignUpStep] = useState<SignUpStep | "done" | null>(null);
  const tokenRef = useRef<string | null>(null);

  const get = useCallback(() => {
    service.current ??= new AccountService(
      {
        chainId: CHAIN_ID,
        deployment: DEPLOYMENT,
        rpcUrls: RPC_URLS,
        // The app's registrable domain in production (trendr.bid serves app.trendr.bid); an unset or
    // empty value means this page's own host.
    rpId: process.env.NEXT_PUBLIC_PASSKEY_RP_ID || window.location.hostname,
        rpName: "Trendr",
        sessionLifetimeSec: SESSION_LIFETIME_SEC,
        sessionDailyLimit: SESSION_DAILY_LIMIT,
      },
      createRelayerClient(RELAYER_URL),
      activation.ticket,
    );
    return service.current;
  }, []);

  /**
   * Signs in to the backend with the session key: no prompt, and reused for the tab's lifetime.
   * `fresh` skips the stored token (the backend refused it).
   */
  const connectBackend = useCallback(async (active: ActiveAccount, fresh = false) => {
    const reuse = fresh ? null : storedToken(active.address, active.sessionAddress);
    const token =
      reuse ??
      (await (async () => {
        const issuedAt = Math.floor(Date.now() / 1000);
        const message = `Trendr sign-in\naccount: ${getAddress(active.address)}\nsigner: ${getAddress(active.sessionAddress)}\nissued: ${issuedAt}`;
        const { signer, signature } = await get().signWithSession(message);
        const res = await auth.session(active.address, signer, issuedAt, signature);
        try {
          sessionStorage.setItem(TOKEN_KEY, JSON.stringify({ account: active.address.toLowerCase(), signer: active.sessionAddress.toLowerCase(), token: res.token, expiresAt: res.expiresAt }));
        } catch {
          // Private mode: the token lives in memory only.
        }
        return res.token;
      })());
    tokenRef.current = token;
    setUserToken(token);
    setBackendReady(true);
    return token;
  }, [get]);

  /** Ends trading until the session is renewed: it expired, it predates the current permissions, or the account must upgrade. */
  const expire = useCallback((e: SessionExpiredError) => {
    setSessionOutdated(e instanceof SessionOutdatedError);
    setUpgradeRequired(e instanceof AccountUpgradeRequiredError);
    setStatus("session-expired");
  }, []);

  /** Makes `active` the app's account; resolves once the backend sign-in settled (either way). */
  const activate = useCallback(
    (active: ActiveAccount | null): Promise<void> => {
      setSession(active);
      setPrivateIdentity(get().privateIdentity);
      setSessionOutdated(false);
      setUpgradeRequired(false);
      setStatus(active ? "active" : "signed-out");
      // A signed-in call the backend refuses (session key revoked or replaced) signs in once more.
      setReauth(active ? () => connectBackend(active, true) : null);
      return active ? connectBackend(active).then(() => undefined, () => setBackendReady(false)) : Promise.resolve();
    },
    [get, connectBackend],
  );

  useEffect(() => {
    let cancelled = false;
    get()
      .restore()
      .then((active) => {
        if (!cancelled) void activate(active);
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        if (e instanceof SessionExpiredError) expire(e);
        else setStatus("signed-out");
      });
    return () => {
      cancelled = true;
      service.current?.lock();
    };
  }, [get, activate, expire]);

  // The next visit paints the shell this one settled on: signed in (or expired), or signed out.
  useEffect(() => {
    if (status === "active" || status === "session-expired") setAccountHint(true);
    else if (status === "signed-out") setAccountHint(false);
  }, [status]);

  /** Runs an account ceremony; resolves with the backend sign-in it started, or null when it failed. */
  const run = useCallback(
    async (fn: () => Promise<ActiveAccount>, done: { title: string; description: string }): Promise<{ synced: Promise<void> } | null> => {
      setError(null);
      setStatus("working");
      try {
        const active = await fn();
        const synced = activate(active);
        notify.success(done.title, done.description, explorerAddress(active.address));
        // Wrapped, so awaiting the ceremony never waits for the backend too.
        return { synced };
      } catch (e) {
        // An expired or outdated session is not an error: the session-expired view explains it.
        if (e instanceof SessionExpiredError) expire(e);
        else {
          setError(describeError(e));
          setStatus("signed-out");
        }
        return null;
      }
    },
    [activate, expire],
  );

  // A new account walks the sheet's checklist: passkey, account, session, then the backend sync.
  const signUp = useCallback(async () => {
    setSignUpStep("passkey");
    const created = await run(() => get().signUp(setSignUpStep), { title: "Account created", description: "Your passkey is the account. Trading works without prompts for a week." });
    if (!created) return setSignUpStep(null);
    setSignUpStep("sync");
    await created.synced;
    setSignUpStep("done");
    // The finished list stays a moment, then the sheet shows the account.
    await new Promise((r) => setTimeout(r, SIGNED_UP_HOLD_MS));
    setSignUpStep(null);
  }, [get, run]);
  const signIn = useCallback(async () => {
    await run(() => get().signIn(), { title: "Signed in", description: "Trading works without prompts for a week." });
  }, [get, run]);
  const renewSession = useCallback(async () => {
    await run(() => get().renewSession(), { title: "Session renewed", description: "Trading works without prompts for another week." });
  }, [get, run]);
  const upgrade = useCallback(async () => {
    await run(() => get().upgrade(), { title: "Account upgraded", description: "Same address, funds and positions, with the safer session limits." });
  }, [get, run]);
  const login = useCallback(() => {
    setError(null);
    setSheetOpen(true);
  }, []);
  const unlockPrivate = useCallback(async () => {
    const p = await get().unlockPrivate();
    setPrivateIdentity(p);
    return p;
  }, [get]);
  const logout = useCallback(async () => {
    setReauth(null);
    // Free this browser's push endpoint first, so the next account signed in here can use it.
    await disablePush().catch(() => {});
    const token = tokenRef.current;
    if (token) await auth.revoke(token).catch(() => {});
    try {
      sessionStorage.removeItem(TOKEN_KEY);
    } catch {
      // Nothing stored.
    }
    tokenRef.current = null;
    setUserToken(null);
    setBackendReady(false);
    await get().logout();
    setSession(null);
    setPrivateIdentity(null);
    setStatus("signed-out");
    notify.success("Signed out", "Your passkey signs you back in on any device.");
  }, [get]);

  const trade = useCallback(
    async (calls: Call[]) => {
      try {
        return await get().trade(calls);
      } catch (e) {
        if (e instanceof SessionExpiredError) expire(e);
        throw e;
      }
    },
    [get, expire],
  );
  const ownerExecute = useCallback((calls: Call[]) => get().ownerExecute(calls), [get]);
  const approve = useCallback<Approve>(
    (request) => {
      const active = get().active;
      if (!active) return Promise.reject(new SessionExpiredError("Sign in first."));
      return approveAsOwner({ account: active.address, chainId: CHAIN_ID, challenge: ownerApprovals.challenge, sign: (digest) => get().signOwnerChallenge(digest) }, request);
    },
    [get],
  );

  const value = useMemo<Account>(
    () => ({
      ready: status !== "loading",
      authenticated: status === "active",
      status,
      sessionOutdated,
      upgradeRequired,
      address: session?.address,
      session,
      backendReady,
      privateIdentity,
      signUpStep,
      login,
      signUp,
      signIn,
      renewSession,
      upgrade,
      unlockPrivate,
      trade,
      ownerExecute,
      approve,
      logout,
      error,
    }),
    [status, sessionOutdated, upgradeRequired, session, backendReady, privateIdentity, signUpStep, login, signUp, signIn, renewSession, upgrade, unlockPrivate, trade, ownerExecute, approve, logout, error],
  );

  return (
    <AccountContext.Provider value={value}>
      {children}
      <AccountSheet open={sheetOpen} onOpenChange={setSheetOpen} />
    </AccountContext.Provider>
  );
}

export function useAccount(): Account {
  const account = useContext(AccountContext);
  if (!account) throw new Error("useAccount must be used inside AccountProvider");
  return account;
}
