"use client";
import { ExternalLink } from "lucide-react";
import type { ReactNode } from "react";
import { toast } from "sonner";
import { EXPLORER_NAME, explorerTx } from "@/lib/config";

/**
 * Every toast the app shows, so they read alike: short confirmations, backend errors, and one
 * toast per transaction that moves through pending, filled and final (or failed) in place.
 */

const ERROR_MS = 8_000;
const TX_MS = 4_000;
/** The final update restarts the timer, so it stays only briefly: the fill was already shown. */
const FINAL_MS = 2_500;

/** The compact Monadscan link a toast carries on its right. */
export function ToastLink({ href, label = EXPLORER_NAME }: { href: string; label?: string }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      aria-label={`View on ${EXPLORER_NAME}`}
      className="ml-auto inline-flex h-7 shrink-0 items-center gap-1.5 self-center rounded-lg border border-line bg-surface-2 px-2.5 font-strong text-[12px] text-text-2 transition-colors hover:border-line-strong hover:text-text"
    >
      <ExternalLink className="size-3.5" aria-hidden />
      {label}
    </a>
  );
}

/** `href` adds the Monadscan link: the transaction or account the toast is about. */
export const notify = {
  success: (title: string, description?: ReactNode, href?: string) => toast.success(title, { description, action: href ? <ToastLink href={href} /> : undefined }),
  info: (title: string, description?: ReactNode) => toast.info(title, { description }),
  /** A failure the user should read: stays a little longer. */
  error: (title: string, description?: ReactNode) => toast.error(title, { description, duration: ERROR_MS }),
  /** A short "Copied", replacing the previous one rather than stacking. */
  copied: (title = "Copied") => toast.success(title, { id: "copied", duration: 1_800 }),
};

/** Copies text and confirms it with a toast; says so when the browser refuses. */
export async function copyText(text: string, title = "Copied"): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    notify.copied(title);
    return true;
  } catch {
    notify.error("Could not copy", "Your browser blocked the clipboard. Select the text and copy it instead.");
    return false;
  }
}

/** Toasts still on screen: a finality update never brings back one the user dismissed. */
const open = new Set<string>();
const track = { onDismiss: (t: { id: string | number }) => open.delete(String(t.id)), onAutoClose: (t: { id: string | number }) => open.delete(String(t.id)) };

const seconds = (ms: number) => `${(ms / 1000).toFixed(1)}s`;

/** One transaction's toast, updated in place by its id. */
export const txToast = {
  pending(id: string, action: string) {
    open.add(id);
    toast.loading(action, { id, description: "Sending to Monad", duration: Number.POSITIVE_INFINITY, ...track });
  },
  filled(id: string, { done, fillMs, hash, final }: { done: string; fillMs: number | null; hash: string; final: boolean }) {
    // A finality update only refreshes a toast that is still showing.
    if (final && !open.has(id)) return;
    open.add(id);
    toast.success(done, {
      id,
      description: `Filled${fillMs === null ? "" : ` in ${seconds(fillMs)}`}, ${final ? "final" : "finalizing"}`,
      action: <ToastLink href={explorerTx(hash)} />,
      duration: final ? FINAL_MS : TX_MS,
      ...track,
    });
  },
  failed(id: string, { action, reason, hash }: { action: string; reason: string; hash: string | null }) {
    open.delete(id);
    toast.error(`${action} failed`, { id, description: reason, action: hash ? <ToastLink href={explorerTx(hash)} /> : undefined, duration: ERROR_MS });
  },
  cancelled(id: string, action: string) {
    open.delete(id);
    toast(`${action} cancelled`, { id, description: "Nothing was sent.", duration: 3_000 });
  },
  dismiss(id: string) {
    open.delete(id);
    toast.dismiss(id);
  },
};
