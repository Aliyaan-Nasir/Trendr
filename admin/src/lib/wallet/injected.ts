"use client";
import { useSyncExternalStore } from "react";
import { utf8ToHex } from "@/src/lib/auth/message";

/**
 * A dependency-free connector for an injected EIP-1193 wallet (window.ethereum). The panel only
 * needs an address and personal_sign: it never sends transactions.
 */

interface Eip1193Provider {
  request(args: { method: string; params?: unknown[] }): Promise<unknown>;
  on?(event: "accountsChanged", listener: (accounts: string[]) => void): void;
}

declare global {
  interface Window {
    ethereum?: Eip1193Provider;
  }
}

export interface WalletState {
  /** False until the first silent account check has finished (and always on the server). */
  ready: boolean;
  /** Whether a browser wallet is installed. */
  hasProvider: boolean;
  address: string | null;
  connecting: boolean;
  error: string | null;
}

/** A wallet failure with the EIP-1193 code when there is one (4001: the user said no). */
export class WalletError extends Error {
  constructor(
    message: string,
    readonly code: number | null = null,
  ) {
    super(message);
  }
}

const DISCONNECTED_KEY = "trendr-admin:wallet-disconnected";
const SERVER_STATE: WalletState = { ready: false, hasProvider: false, address: null, connecting: false, error: null };

let state: WalletState = SERVER_STATE;
let initialized = false;
const listeners = new Set<() => void>();

function setState(patch: Partial<WalletState>) {
  state = { ...state, ...patch };
  listeners.forEach((listener) => listener());
}

function getProvider(): Eip1193Provider | null {
  return typeof window !== "undefined" ? (window.ethereum ?? null) : null;
}

function wasDisconnected(): boolean {
  try {
    return window.localStorage.getItem(DISCONNECTED_KEY) === "1";
  } catch {
    return false;
  }
}

function rememberDisconnected(value: boolean) {
  try {
    if (value) window.localStorage.setItem(DISCONNECTED_KEY, "1");
    else window.localStorage.removeItem(DISCONNECTED_KEY);
  } catch {
    // Storage can be unavailable (private mode); the wallet still works without it.
  }
}

function firstAccount(accounts: unknown): string | null {
  return Array.isArray(accounts) && typeof accounts[0] === "string" ? accounts[0] : null;
}

function errorCode(err: unknown): number | null {
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === "number" ? code : null;
}

function describeConnectError(err: unknown): string {
  const code = errorCode(err);
  if (code === 4001) return "The connection request was rejected in your wallet.";
  if (code === -32002) return "A connection request is already open in your wallet.";
  return err instanceof Error && err.message ? err.message : "Could not connect to the wallet.";
}

function init() {
  if (initialized || typeof window === "undefined") return;
  initialized = true;

  const provider = getProvider();
  if (!provider) {
    setState({ ready: true, hasProvider: false });
    return;
  }

  provider.on?.("accountsChanged", (accounts) => {
    if (wasDisconnected()) return;
    setState({ address: firstAccount(accounts) });
  });

  if (wasDisconnected()) {
    setState({ ready: true, hasProvider: true });
    return;
  }

  // Silent reconnect: eth_accounts never prompts, it only returns already authorized accounts.
  setState({ hasProvider: true, connecting: true });
  provider
    .request({ method: "eth_accounts" })
    .then((accounts) => setState({ address: firstAccount(accounts) }))
    .catch(() => setState({ address: null }))
    .finally(() => setState({ ready: true, connecting: false }));
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  init();
  return () => {
    listeners.delete(listener);
  };
}

export async function connectWallet(): Promise<string | null> {
  const provider = getProvider();
  if (!provider) {
    setState({ error: "No browser wallet found." });
    return null;
  }
  setState({ connecting: true, error: null });
  try {
    const address = firstAccount(await provider.request({ method: "eth_requestAccounts" }));
    rememberDisconnected(false);
    setState({ address });
    return address;
  } catch (err) {
    setState({ error: describeConnectError(err) });
    return null;
  } finally {
    setState({ connecting: false });
  }
}

export function disconnectWallet(): void {
  rememberDisconnected(true);
  setState({ address: null, error: null });
  // Best effort: wallets that support it drop the site permission; others ignore the call.
  getProvider()
    ?.request({ method: "wallet_revokePermissions", params: [{ eth_accounts: {} }] })
    .catch(() => {});
}

/** EIP-191 personal_sign of a UTF-8 message by `address`; resolves to the 0x signature. */
export async function signMessage(address: string, message: string): Promise<string> {
  const provider = getProvider();
  if (!provider) throw new WalletError("No browser wallet found.");
  try {
    const signature = await provider.request({ method: "personal_sign", params: [utf8ToHex(message), address] });
    if (typeof signature !== "string" || !/^0x[0-9a-fA-F]+$/.test(signature)) throw new WalletError("The wallet returned no signature.");
    return signature;
  } catch (err) {
    if (err instanceof WalletError) throw err;
    const code = errorCode(err);
    if (code === 4001) throw new WalletError("The signature request was rejected in your wallet.", code);
    throw new WalletError(err instanceof Error && err.message ? err.message : "The wallet could not sign the message.", code);
  }
}

/** EVM addresses are case-insensitive (checksum casing is only a display convention). */
export function sameAddress(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

export function useWallet(): WalletState {
  return useSyncExternalStore(subscribe, () => state, () => SERVER_STATE);
}
