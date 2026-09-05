import { BaseError, createTransport, type EIP1193RequestFn, HttpRequestError, type Transport, TimeoutError } from "viem";
import { pacedHttp } from "./transport";

/**
 * Load balancing across several RPC endpoints of the same chain. Requests rotate round robin over
 * the endpoints that are healthy; an endpoint that fails (network error, server error, rate limit,
 * a node lagging behind the requested block) is benched for a cooldown that doubles while it keeps
 * failing, and the request moves on to the next endpoint. Errors about the request itself, such as
 * a reverted call or bad parameters, come back at once: another node would answer the same.
 */

export interface BalancedOptions {
  /** Requests per second per endpoint. */
  requestsPerSecond?: number;
  /** First bench after a failure; doubles per consecutive failure up to maxCooldownMs. */
  cooldownMs?: number;
  maxCooldownMs?: number;
  now?: () => number;
}

export interface EndpointHealth {
  url: string;
  requests: number;
  failures: number;
  consecutiveFailures: number;
  benchedUntil: number;
}

// Plan limits (a provider's free tier refusing a block range other endpoints serve) count too.
const ENDPOINT_FAILURE = /rate limit|limit exceeded|too many requests|requests limited|timeout|timed out|unavailable|bad gateway|gateway|header not found|block not found|unknown block|missing trie node|not synced|syncing|ECONNRESET|ECONNREFUSED|fetch failed|socket|free tier|upgrade to|block range/i;

/** True when an error says the endpoint, not the request, is at fault. */
export function isEndpointFailure(e: unknown): boolean {
  if (e instanceof HttpRequestError || e instanceof TimeoutError) return true;
  if (e instanceof BaseError) {
    let found = false;
    e.walk((x) => {
      const code = (x as { code?: number }).code;
      const status = (x as { status?: number }).status;
      if (x instanceof HttpRequestError || x instanceof TimeoutError) found = true;
      if (code === -32005 || code === 429 || (typeof status === "number" && (status === 429 || status >= 500))) found = true;
      return false;
    });
    if (found) return true;
    return ENDPOINT_FAILURE.test(`${e.shortMessage} ${e.details ?? ""}`);
  }
  return e instanceof Error && ENDPOINT_FAILURE.test(e.message);
}

/**
 * The provider of an endpoint (its registrable domain, `alchemy.com`), for public health output:
 * hosts and paths can carry account names and keys.
 */
export function providerOf(url: string): string {
  try {
    return new URL(url).hostname.split(".").slice(-2).join(".");
  } catch {
    return "invalid url";
  }
}

/** Every URL in `text` with long path segments (where providers put API keys) cut short, so errors are safe to store and show. */
export function redactUrls(text: string): string {
  return text.replace(/\b(?:https?|wss?):\/\/[^\s"'<>)\]]+/g, (match) => {
    // Punctuation after a URL in prose is not part of it.
    const tail = /[.,;:!?]+$/.exec(match)?.[0] ?? "";
    return redactUrl(match.slice(0, match.length - tail.length)) + tail;
  });
}

/** Masks credentials in an endpoint URL for logs. */
export function redactUrl(url: string): string {
  try {
    const u = new URL(url);
    const path = u.pathname.split("/").map((p) => (p.length > 16 ? `${p.slice(0, 4)}...` : p)).join("/");
    return `${u.protocol}//${u.host}${path}`;
  } catch {
    return "invalid url";
  }
}

export class EndpointPool {
  readonly health: EndpointHealth[];
  private cursor = 0;

  constructor(
    urls: readonly string[],
    private readonly opts: BalancedOptions = {},
  ) {
    if (urls.length === 0) throw new Error("at least one RPC endpoint is required");
    this.health = urls.map((url) => ({ url, requests: 0, failures: 0, consecutiveFailures: 0, benchedUntil: 0 }));
  }

  private now() {
    return (this.opts.now ?? Date.now)();
  }

  /** Endpoints in the order this request should try them: healthy ones from the cursor on, then benched ones. */
  order(): number[] {
    const n = this.health.length;
    const start = this.cursor++ % n;
    const all = Array.from({ length: n }, (_, i) => (start + i) % n);
    const now = this.now();
    const ready = all.filter((i) => this.health[i]!.benchedUntil <= now);
    const benched = all.filter((i) => this.health[i]!.benchedUntil > now).sort((a, b) => this.health[a]!.benchedUntil - this.health[b]!.benchedUntil);
    return [...ready, ...benched];
  }

  succeeded(i: number) {
    const h = this.health[i]!;
    h.requests++;
    h.consecutiveFailures = 0;
    h.benchedUntil = 0;
  }

  failed(i: number) {
    const h = this.health[i]!;
    h.requests++;
    h.failures++;
    h.consecutiveFailures++;
    const base = this.opts.cooldownMs ?? 2_000;
    const cooldown = Math.min(base * 2 ** (h.consecutiveFailures - 1), this.opts.maxCooldownMs ?? 60_000);
    h.benchedUntil = this.now() + cooldown;
  }

  /** Per-endpoint health, by provider only, safe to serve publicly. */
  report() {
    const now = this.now();
    return this.health.map((h) => ({ provider: providerOf(h.url), requests: h.requests, failures: h.failures, healthy: h.benchedUntil <= now }));
  }
}

const pools = new Map<string, EndpointPool>();

/** The shared pool for a set of URLs in this process, for health reporting. */
export function endpointPool(urls: readonly string[]): EndpointPool | undefined {
  return pools.get(urls.join(","));
}

/**
 * A viem transport over several endpoints. Every client in a process built from the same URL list
 * shares one pool, so health and rotation are global to the process.
 */
export function balancedHttp(urls: readonly string[], opts: BalancedOptions = {}): Transport {
  const key = urls.join(",");
  const pool = pools.get(key) ?? new EndpointPool(urls, opts);
  pools.set(key, pool);
  // Several endpoints fail over to each other at once; a lone endpoint has nowhere to fail over to,
  // so it retries rate limits and server errors with backoff instead.
  const attempts = urls.length > 1 ? 1 : undefined;
  const inner = urls.map((url) => pacedHttp(url, { requestsPerSecond: opts.requestsPerSecond, attempts }));
  return (config) => {
    const transports = inner.map((t) => t({ ...config, retryCount: 0 }));
    return createTransport(
      {
        key: "balanced",
        name: "Balanced JSON-RPC",
        type: "balanced",
        retryCount: 0,
        request: (async ({ method, params }: { method: string; params?: unknown }) => {
          let last: unknown;
          for (const i of pool.order()) {
            try {
              const result = await transports[i]!.request({ method, params } as never);
              pool.succeeded(i);
              return result;
            } catch (e) {
              if (!isEndpointFailure(e)) {
                pool.succeeded(i);
                throw e;
              }
              pool.failed(i);
              last = e;
            }
          }
          throw last;
        }) as EIP1193RequestFn,
      },
      { pool },
    );
  };
}

/** Splits a comma-separated list of URLs, dropping blanks. */
export const urlList = (value: string | undefined | null): string[] => (value ?? "").split(",").map((s) => s.trim()).filter(Boolean);
