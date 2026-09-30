"use client";
import { useMutation } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import type { LocalAccount } from "viem";
import { describeError, useAccount } from "@/lib/account/AccountProvider";
import { social } from "@/lib/api";
import { identitySignInMessage, signAsCaller } from "@/lib/social";

/**
 * The caller identity on this device: a passkey-derived key apart from the trading account. When
 * the device lost it, one passkey prompt rebuilds it.
 *
 * The key signs through a signing session that the account layer can end (signing out, or a
 * restore that replaced it), so each identity is checked once with a local signature before the
 * screens use it; an ended one reads as locked and offers the one-prompt unlock.
 */

const probes = new WeakMap<LocalAccount, Promise<boolean>>();
const ENDED = /session has ended|session ended/i;
function usable(identity: LocalAccount): Promise<boolean> {
  let p = probes.get(identity);
  if (!p) {
    p = identity.signMessage({ message: "Trendr caller key check" }).then(
      () => true,
      () => false,
    );
    probes.set(identity, p);
  }
  return p;
}

export function useCallerIdentity() {
  const account = useAccount();
  const raw = account.privateIdentity?.identity ?? null;
  const [checked, setChecked] = useState<{ id: LocalAccount; ok: boolean } | null>(null);
  useEffect(() => {
    if (!raw) return;
    let live = true;
    void usable(raw).then((ok) => live && setChecked({ id: raw, ok }));
    return () => {
      live = false;
    };
  }, [raw]);
  const unlock = useMutation({ mutationFn: () => account.unlockPrivate() });
  /** After a signing error: an ended key reads as locked from now on. Returns true when it was that. */
  const failed = (e: unknown) => {
    if (!raw || !(e instanceof Error) || !ENDED.test(e.message)) return false;
    probes.set(raw, Promise.resolve(false));
    setChecked({ id: raw, ok: false });
    return true;
  };
  const status: "locked" | "checking" | "ready" = !raw ? "locked" : checked?.id !== raw ? "checking" : checked.ok ? "ready" : "locked";
  const identity = status === "ready" ? raw : null;
  return {
    identity,
    /** The identity's address once it is usable here. */
    address: identity ? (identity.address.toLowerCase() as `0x${string}`) : null,
    /** The identity this device knows, usable or not (to recognise your own profile). */
    known: raw ? (raw.address.toLowerCase() as `0x${string}`) : null,
    checking: status === "checking",
    failed,
    unlock: () => unlock.mutate(),
    unlocking: unlock.isPending,
    unlockError: unlock.error ? describeError(unlock.error) : null,
  };
}

let session: { identity: string; token: string; expiresAt: number } | null = null;

/** A vault session for the identity: one signature (no prompt), reused until it nears expiry. */
export async function identityToken(identity: LocalAccount): Promise<string> {
  const who = identity.address.toLowerCase();
  if (session && session.identity === who && session.expiresAt > Date.now() / 1000 + 120) return session.token;
  const { issuedAt, signature } = await signAsCaller(identity, (t) => identitySignInMessage(who, t));
  const res = await social.identitySession(who, issuedAt, signature);
  session = { identity: who, token: res.token, expiresAt: res.expiresAt };
  return res.token;
}

/** Forgets the vault session (after a 401). */
export const dropIdentityToken = () => {
  session = null;
};
