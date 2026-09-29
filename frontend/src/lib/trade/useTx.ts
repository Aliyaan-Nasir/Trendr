"use client";
import { isMeraError } from "@category-labs/mera";
import { useQuery } from "@tanstack/react-query";
import { useCallback, useEffect, useRef, useState } from "react";
import { describeError } from "@/lib/account/AccountProvider";
import type { Relayed } from "@/lib/account/relayer";
import { FINALITY_BLOCKS, publicClient, useHead, whenFinal } from "@/lib/chain/client";
import { txToast } from "@/lib/toast";

/**
 * One transaction's progress at Monad speed. The relayer answers once the transaction is in a
 * proposed block, which the app shows as "Filled"; it turns "Final" once the chain is two blocks
 * further on (Monad finalizes about two blocks behind the proposed head).
 *
 * Every run also has one toast: the fill (updated in place when final) and any failure, each with
 * its Monadscan link. The pending stage toasts only when nothing on screen shows it: the inline
 * status scrolled away or its screen closed while the transaction was still in flight.
 */

export type TxStage = "idle" | "pending" | "filled" | "final" | "failed";

interface State {
  stage: Exclude<TxStage, "final">;
  hash: `0x${string}` | null;
  block: bigint | null;
  error: string | null;
  /** Milliseconds from sending to the fill. */
  fillMs: number | null;
}

const IDLE: State = { stage: "idle", hash: null, block: null, error: null, fillMs: null };

/** How a run names itself in its toasts. */
export interface TxLabels {
  /** The action, as its button names it ("Buy Up"): titles the pending and failed toasts. */
  action: string;
  /** What it did, past tense ("Bought Up"): titles the success toast. */
  done: string;
}

const GENERIC: TxLabels = { action: "Transaction", done: "Transaction filled" };
/** How long a run may stay pending, out of sight, before it gets its own toast. */
const PENDING_CHECK_MS = 1_200;

export interface Tx extends Omit<State, "stage"> {
  stage: TxStage;
  busy: boolean;
  /** Sends and tracks one transaction; resolves with the receipt, or null when it failed. */
  run(send: () => Promise<Relayed>, labels?: TxLabels): Promise<Relayed | null>;
  reset(): void;
  /** Ref for the inline status: while it is in view, the pending stage needs no toast. */
  inline(el: HTMLElement | null): void;
}

/** A transaction that made it into a block and reverted there. */
class RevertedError extends Error {
  constructor(readonly hash: `0x${string}`) {
    super("The transaction reverted on chain.");
  }
}

const cancelled = (e: unknown) => isMeraError(e) && e.code === "PASSKEY_OPERATION_FAILED";

/** True while `el` is attached, visible and at least partly inside the viewport. */
function inView(el: HTMLElement | null): boolean {
  if (!el?.isConnected) return false;
  const r = el.getBoundingClientRect();
  return r.width > 0 && r.height > 0 && r.bottom > 0 && r.top < window.innerHeight && r.right > 0 && r.left < window.innerWidth;
}

let runs = 0;

interface Flight {
  id: string;
  action: string;
  /** True once the pending toast is up. */
  toasted: boolean;
}

export function useTx(): Tx {
  const head = useHead();
  const [s, setS] = useState<State>(IDLE);
  const inlineEl = useRef<HTMLElement | null>(null);
  const flight = useRef<Flight | null>(null);

  // A screen that closes mid-flight hands the transaction to a toast.
  useEffect(
    () => () => {
      const f = flight.current;
      if (f && !f.toasted) {
        f.toasted = true;
        txToast.pending(f.id, f.action);
      }
    },
    [],
  );

  const run = useCallback(async (send: () => Promise<Relayed>, labels: TxLabels = GENERIC) => {
    const f: Flight = { id: `tx-${++runs}`, action: labels.action, toasted: false };
    flight.current = f;
    const started = performance.now();
    setS({ ...IDLE, stage: "pending" });
    const watch = setInterval(() => {
      if (f.toasted || flight.current !== f || inView(inlineEl.current)) return;
      f.toasted = true;
      txToast.pending(f.id, f.action);
    }, PENDING_CHECK_MS);
    try {
      const r = await send();
      if (r.status !== "success") throw new RevertedError(r.hash);
      const fillMs = performance.now() - started;
      const block = BigInt(r.blockNumber);
      setS({ stage: "filled", hash: r.hash, block, error: null, fillMs });
      txToast.filled(f.id, { done: labels.done, fillMs, hash: r.hash, final: false });
      void whenFinal(block).then((final) => final && txToast.filled(f.id, { done: labels.done, fillMs, hash: r.hash, final: true }));
      return r;
    } catch (e) {
      const error = describeError(e);
      const hash = e instanceof RevertedError ? e.hash : null;
      setS({ ...IDLE, stage: "failed", error, hash });
      // A cancelled passkey prompt is the user's own choice: the inline note is enough when in view.
      if (cancelled(e)) {
        if (f.toasted || !inView(inlineEl.current)) txToast.cancelled(f.id, labels.action);
      } else {
        txToast.failed(f.id, { action: labels.action, reason: error, hash });
      }
      return null;
    } finally {
      clearInterval(watch);
      if (flight.current === f) flight.current = null;
    }
  }, []);
  const reset = useCallback(() => setS(IDLE), []);
  const inline = useCallback((el: HTMLElement | null) => {
    inlineEl.current = el;
  }, []);

  // Without the head stream (a dropped socket), ask the node for its finalized block instead.
  const finalized = useQuery({
    queryKey: ["finalized-block"],
    queryFn: async () => (await publicClient.getBlock({ blockTag: "finalized" })).number,
    enabled: s.stage === "filled" && head === null,
    refetchInterval: 800,
  });
  const reached = (head ? head.number - FINALITY_BLOCKS : finalized.data ?? -1n) >= (s.block ?? 0n);
  const stage: TxStage = s.stage === "filled" && s.block !== null && reached ? "final" : s.stage;
  return { ...s, stage, busy: s.stage === "pending", run, reset, inline };
}
