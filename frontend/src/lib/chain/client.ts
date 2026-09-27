"use client";
import { useEffect, useState } from "react";
import { type Chain, createPublicClient, defineChain, type PublicClient } from "viem";
import { monad, monadTestnet } from "viem/chains";
import { CHAIN_ID, RPC_URL, RPC_URLS, WS_URL, WS_URLS } from "@/lib/config";
import { nextEndpoint, readTransport } from "./transport";

/** Read access to Monad from the browser, batched through Multicall3. */

const base: Chain = CHAIN_ID === 143 ? monad : monadTestnet;
export const chain = defineChain({ ...base, rpcUrls: { default: { http: [RPC_URL], webSocket: [WS_URL] } } });

export const publicClient: PublicClient = createPublicClient({ chain, transport: readTransport(RPC_URLS), batch: { multicall: { wait: 16 } } }) as PublicClient;

interface Head {
  number: bigint;
  timestamp: number;
  stage: "Proposed" | "Voted" | "Finalized";
}

type Listener = (h: Head) => void;
const listeners = new Set<Listener>();
let socket: WebSocket | null = null;
let last: Head | null = null;
/** Which of WS_URLS the stream uses; a drop moves it to the next one. */
let wsIndex = 0;
/** When the last head arrived (ms), to tell a live stream from a dropped one. */
let lastAt = 0;
/** A pending close of the unwatched stream: the next page usually subscribes again at once. */
let idle: ReturnType<typeof setTimeout> | null = null;
const IDLE_CLOSE_MS = 5_000;

/**
 * One shared subscription to Monad's speculative heads (monadNewHeads): blocks arrive every
 * 400 ms, first as Proposed and then Voted and Finalized, so the app can show a fill at the
 * proposed stage and mark it final when its block finalizes.
 */
function connect() {
  if (idle) {
    clearTimeout(idle);
    idle = null;
  }
  if (socket || typeof window === "undefined") return;
  const ws = new WebSocket(WS_URLS[wsIndex % WS_URLS.length]!);
  socket = ws;
  ws.onopen = () => ws.send(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_subscribe", params: ["monadNewHeads"] }));
  ws.onmessage = (e) => {
    try {
      const msg = JSON.parse(String(e.data)) as { params?: { result?: { number: string; timestamp: string; commitState: Head["stage"] } } };
      const r = msg.params?.result;
      if (!r) return;
      const head: Head = { number: BigInt(r.number), timestamp: Number(BigInt(r.timestamp)), stage: r.commitState };
      if (last && head.number < last.number) return;
      last = head;
      lastAt = Date.now();
      for (const l of listeners) l(head);
    } catch {
      // Not a head.
    }
  };
  ws.onclose = () => {
    // A stream released on purpose has already been replaced or is no longer wanted.
    if (socket !== ws) return;
    socket = null;
    // A dropped or refused stream moves to the next endpoint, if there is one.
    wsIndex = nextEndpoint(wsIndex, WS_URLS.length);
    if (listeners.size > 0) setTimeout(connect, 1500);
  };
}

/** Closes the stream, waiting for it to open first: closing a connecting socket logs a browser warning. */
function release() {
  const ws = socket;
  socket = null;
  if (!ws) return;
  if (ws.readyState === WebSocket.CONNECTING) ws.onopen = () => ws.close();
  else ws.close();
}

export function subscribeHeads(listener: Listener): () => void {
  listeners.add(listener);
  connect();
  if (last) listener(last);
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0 && !idle) {
      idle = setTimeout(() => {
        idle = null;
        if (listeners.size === 0) release();
      }, IDLE_CLOSE_MS);
    }
  };
}

/** The newest block the app has seen (Proposed or later), updating every ~400 ms. */
export function useHead(): Head | null {
  const [head, setHead] = useState<Head | null>(last);
  useEffect(() => subscribeHeads(setHead), []);
  return head;
}

/** Finalized height lags the proposed one by about two blocks on Monad. */
export const FINALITY_BLOCKS = 2n;

/**
 * Resolves true once `block` is final: two blocks behind the head stream, or at the node's
 * finalized block while the stream is quiet. Resolves false after `timeoutMs` without it.
 */
export function whenFinal(block: bigint, timeoutMs = 30_000): Promise<boolean> {
  return new Promise((resolve) => {
    let done = false;
    let unsubscribe: (() => void) | null = null;
    const finish = (ok: boolean) => {
      if (done) return;
      done = true;
      unsubscribe?.();
      clearInterval(poll);
      clearTimeout(timer);
      resolve(ok);
    };
    const poll = setInterval(() => {
      if (Date.now() - lastAt < 2_000) return;
      publicClient
        .getBlock({ blockTag: "finalized" })
        .then((b) => b.number >= block && finish(true))
        .catch(() => {
          // The next poll tries again.
        });
    }, 1_000);
    const timer = setTimeout(() => finish(false), timeoutMs);
    unsubscribe = subscribeHeads((h) => h.number - FINALITY_BLOCKS >= block && finish(true));
    if (done) unsubscribe();
  });
}
