import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { QuoteRequest, StatusResponse, SwapStatus, SwapStatusResponse } from "../src";

export interface Fixture<T = any> {
  status: number;
  body: T;
  request?: any;
  [key: string]: unknown;
}

export function fixture<T = any>(name: string): Fixture<T> {
  return JSON.parse(readFileSync(join(import.meta.dir, "fixtures", `${name}.json`), "utf8"));
}

export const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

export const fromFixture = (name: string, headers?: Record<string, string>) => {
  const f = fixture(name);
  return json(f.status, f.body, headers);
};

type Step = Response | Error | ((url: string, init: RequestInit) => Response | Promise<Response>);

/** A fetch that answers from a script, in order, and records every call. */
export function scriptedFetch(script: Step[]) {
  const calls: { url: string; init: RequestInit; body?: any }[] = [];
  const fn = async (url: string, init: RequestInit) => {
    calls.push({ url, init, body: typeof init.body === "string" ? JSON.parse(init.body) : undefined });
    const next = script.shift();
    if (!next) throw new Error(`unexpected request ${init.method} ${url}`);
    if (next instanceof Error) throw next;
    return typeof next === "function" ? next(url, init) : next;
  };
  return { fetch: fn as unknown as typeof fetch, calls, left: () => script.length };
}

/** A sleep that returns at once and records what was asked. */
export function recordedSleep() {
  const waits: number[] = [];
  return { sleep: async (ms: number) => void waits.push(ms), waits };
}

/** The recorded PENDING_DEPOSIT status, rewritten to another status with some swap details. */
export function statusLike(status: SwapStatus, details: Partial<SwapStatusResponse["swapDetails"]> = {}, updatedAt = "2026-10-09T20:00:00.000Z"): StatusResponse {
  const base = fixture<SwapStatusResponse>("swap/status-pending-deposit").body;
  return { ...base, status, updatedAt, swapDetails: { ...base.swapDetails, ...details } };
}

/**
 * A recorded live quote response (from the public status of an unfunded Intents Connect test
 * quote) and the clean request that would produce it.
 */
export function liveQuote() {
  const response = fixture("swap/status-pending-deposit").body.quoteResponse;
  const { referral: _r, appFees: _a, virtualChainRecipient: _v, virtualChainRefundRecipient: _vr, ...request } = response.quoteRequest;
  return { response, request: request as QuoteRequest };
}

/** U+2014, built from its code so this file does not contain the character. */
export const EM_DASH = String.fromCharCode(0x2014);
