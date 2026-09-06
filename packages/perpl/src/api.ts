import * as ed from "@noble/ed25519";
import type { PerplNetwork } from "./networks";

/**
 * Perpl's signed trading API. An API key is an Ed25519 key pair enrolled once with a wallet
 * signature; every request is signed over a canonical string (chain id, method, target without the
 * /api prefix, timestamp, nonce, body hash) and sent with four X-API-* headers.
 */

export interface ApiCredentials {
  /** The opaque X-API-Key token returned at enrollment. */
  token: string;
  /** The Ed25519 secret key, 32 bytes. */
  secretKey: Uint8Array;
}

const toHex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
const toBase64Url = (b: Uint8Array) => btoa(String.fromCharCode(...b)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

export async function sha256Hex(body: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(body));
  return toHex(new Uint8Array(digest));
}

export function randomNonce(): string {
  return toBase64Url(crypto.getRandomValues(new Uint8Array(16)));
}

/** The string Perpl signs for a REST request: six fields joined by newlines. */
export async function canonicalRequest(
  chainId: number,
  method: string,
  target: string,
  timestampMs: string,
  nonce: string,
  body: string,
): Promise<string> {
  return [String(chainId), method.toUpperCase(), target, timestampMs, nonce, await sha256Hex(body)].join("\n");
}

export async function signCanonical(secretKey: Uint8Array, canonical: string): Promise<string> {
  return toBase64Url(await ed.signAsync(new TextEncoder().encode(canonical), secretKey));
}

/** A fresh Ed25519 key pair for enrollment; the public key is sent as 0x-hex. */
export async function generateApiKeyPair(): Promise<{ secretKey: Uint8Array; publicKeyHex: `0x${string}` }> {
  const secretKey = ed.utils.randomSecretKey();
  const publicKey = await ed.getPublicKeyAsync(secretKey);
  return { secretKey, publicKeyHex: `0x${toHex(publicKey)}` };
}

export class PerplApiError extends Error {
  constructor(
    readonly status: number,
    readonly path: string,
    message: string,
  ) {
    super(message);
  }
}

/** Sign-in frame for the trading WebSocket: chain id, a fixed label, timestamp and nonce. */
export async function tradingSignIn(chainId: number, creds: ApiCredentials, now = Date.now()) {
  const timestamp = String(now);
  const nonce = randomNonce();
  const signature = await signCanonical(creds.secretKey, [String(chainId), "trading-ws-signin", timestamp, nonce].join("\n"));
  return { mt: 29, chain_id: chainId, api_key: creds.token, timestamp, nonce, signature };
}

/** An order as the API takes it (OrderSpec). Types are numbered from 1 here. */
export interface OrderSpec {
  rq: number;
  mkt: number;
  acc: number;
  oid?: number;
  t: number;
  p?: number;
  s: number;
  a?: string;
  ms?: number;
  mnp?: number;
  tif?: number;
  fl: number;
  tp?: number;
  tpc?: number;
  tr?: number;
  lp?: number;
  lv: number;
  lb: number;
  bf?: number;
}

export interface BatchStatus {
  status: { code: number; error?: string };
  statuses: { code: number; error?: string }[];
}

export class PerplApi {
  constructor(
    private readonly network: PerplNetwork,
    private readonly creds: ApiCredentials,
    private readonly fetchFn: typeof fetch = fetch,
    private readonly now: () => number = Date.now,
  ) {}

  /** Sends a signed request to `target` (path and query without /api). */
  async request<T>(method: "GET" | "POST", target: string, body?: unknown): Promise<T> {
    const raw = body === undefined ? "" : JSON.stringify(body);
    const timestamp = String(this.now());
    const nonce = randomNonce();
    const signature = await signCanonical(this.creds.secretKey, await canonicalRequest(this.network.chainId, method, target, timestamp, nonce, raw));
    const res = await this.fetchFn(`${this.network.rest}${target}`, {
      method,
      headers: {
        "X-API-Key": this.creds.token,
        "X-API-Timestamp": timestamp,
        "X-API-Nonce": nonce,
        "X-API-Signature": signature,
        ...(raw ? { "Content-Type": "application/json" } : {}),
      },
      ...(raw ? { body: raw } : {}),
    });
    if (!res.ok) throw new PerplApiError(res.status, target, `Perpl ${method} ${target}: HTTP ${res.status}`);
    return (await res.json()) as T;
  }

  wallet() {
    return this.request<{ addr: string; as: { id: number; b: string; lb: string; fw: boolean; lfr: number }[] }>("GET", "/v1/trading/wallet");
  }

  openOrders() {
    return this.request<{ d: unknown[] }>("GET", "/v1/trading/orders");
  }

  positions() {
    return this.request<{ d: unknown[] }>("GET", "/v1/trading/positions");
  }

  fills(count = 50, page?: string) {
    return this.request<{ d: unknown[]; np?: string }>("GET", `/v1/trading/fills?count=${count}${page ? `&page=${page}` : ""}`);
  }

  positionHistory(count = 50, page?: string) {
    return this.request<{ d: unknown[]; np?: string }>("GET", `/v1/trading/position-history?count=${count}${page ? `&page=${page}` : ""}`);
  }

  portfolio(kind: "equity" | "pnl", period: "day" | "week" | "2weeks" | "month" | "all") {
    return this.request<{ at: number; chart: { t: number; v: string }[] }>("GET", `/v1/trading/portfolio/${kind}/${period}`);
  }

  /** Submits up to 100 orders; read every status, since a batch is not a transaction. */
  submit(orders: OrderSpec[]) {
    if (orders.length === 0 || orders.length > 100) throw new Error("a batch holds 1 to 100 orders");
    return this.request<BatchStatus>("POST", "/v1/trading/orders", { d: orders });
  }
}
