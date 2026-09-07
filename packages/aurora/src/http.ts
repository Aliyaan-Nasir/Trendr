import { z } from "zod";
import { AuroraHttpError, AuroraNetworkError, AuroraRateLimitError, AuroraResponseError, AuroraTimeoutError } from "./errors";

/**
 * The transport shared by the Swap API and Intents Connect clients: per-attempt timeouts, retries
 * with exponential backoff and jitter, Aurora's rate-limit contract, and zod validation of every
 * response.
 *
 * Aurora limits each API key per endpoint to 100 requests per 10 seconds and 2000 per hour, and
 * answers 429 with Retry-After (seconds until the window resets). Rejected requests are not
 * processed but still count toward the hourly quota, so a 429 is always safe to retry and is
 * retried after Retry-After, while a wait longer than `maxRetryAfterMs` (the hourly window) is
 * surfaced as AuroraRateLimitError instead of blocking. Network errors, timeouts and 5xx are only
 * retried for idempotent calls, so a live quote or execution is never created twice by a retry.
 */

export interface HttpOptions {
  baseUrl: string;
  fetch?: typeof fetch;
  /** Per attempt. Default 15 s. */
  timeoutMs?: number;
  /** Retries after the first attempt. Default 3. */
  retries?: number;
  /** First backoff; it doubles per attempt. Default 500 ms. */
  backoffMs?: number;
  /** Cap on a single backoff. Default 10 s. */
  maxBackoffMs?: number;
  /** Longest Retry-After waited in process. Default 15 s, which covers the 10-second window. */
  maxRetryAfterMs?: number;
  /** Injectable for tests. */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  random?: () => number;
}

export interface RequestSpec<T> {
  method: "GET" | "POST" | "DELETE";
  /** Real path, which may contain the API key. */
  path: string;
  /** Path for errors and logs, with the key replaced by {apiKey}. */
  label: string;
  query?: Record<string, string | number | boolean | undefined>;
  body?: unknown;
  headers?: Record<string, string>;
  schema: z.ZodType<T>;
  /** Safe to repeat after a network error, timeout or 5xx. */
  idempotent: boolean;
  signal?: AbortSignal;
}

const RETRYABLE_STATUS = new Set([500, 502, 503, 504]);

export function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal!.reason);
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function bodyField(body: unknown, key: string): unknown {
  return body && typeof body === "object" ? (body as Record<string, unknown>)[key] : undefined;
}

/** Aurora's error bodies: `{ message, statusCode }`, `{ message, correlationId, path }` or `{ error }`. */
function errorMessage(status: number, label: string, body: unknown): string {
  const message = bodyField(body, "message") ?? bodyField(body, "error");
  return `Aurora ${label}: HTTP ${status}${typeof message === "string" && message ? `: ${message}` : ""}`;
}

export class HttpClient {
  private readonly fetchFn: typeof fetch;
  private readonly sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
  private readonly random: () => number;
  readonly timeoutMs: number;
  readonly retries: number;
  private readonly backoffMs: number;
  private readonly maxBackoffMs: number;
  private readonly maxRetryAfterMs: number;

  constructor(private readonly options: HttpOptions) {
    this.fetchFn = options.fetch ?? fetch;
    this.sleep = options.sleep ?? defaultSleep;
    this.random = options.random ?? Math.random;
    this.timeoutMs = options.timeoutMs ?? 15_000;
    this.retries = options.retries ?? 3;
    this.backoffMs = options.backoffMs ?? 500;
    this.maxBackoffMs = options.maxBackoffMs ?? 10_000;
    this.maxRetryAfterMs = options.maxRetryAfterMs ?? 15_000;
  }

  private url(path: string, query?: RequestSpec<unknown>["query"]): string {
    const url = `${this.options.baseUrl.replace(/\/$/, "")}${path}`;
    if (!query) return url;
    const params = new URLSearchParams();
    for (const [k, v] of Object.entries(query)) if (v !== undefined) params.set(k, String(v));
    const qs = params.toString();
    return qs ? `${url}?${qs}` : url;
  }

  private backoff(attempt: number): number {
    return Math.min(this.maxBackoffMs, this.backoffMs * 2 ** attempt) + Math.floor(this.random() * 250);
  }

  async request<T>(spec: RequestSpec<T>): Promise<T> {
    const url = this.url(spec.path, spec.query);
    const raw = spec.body === undefined ? undefined : JSON.stringify(spec.body);
    const init: RequestInit = {
      method: spec.method,
      headers: { Accept: "application/json", ...(raw ? { "Content-Type": "application/json" } : {}), ...spec.headers },
      ...(raw ? { body: raw } : {}),
    };

    for (let attempt = 0; ; attempt++) {
      if (spec.signal?.aborted) throw spec.signal.reason;
      const last = attempt >= this.retries;
      const controller = new AbortController();
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        controller.abort();
      }, this.timeoutMs);
      const onAbort = () => controller.abort(spec.signal!.reason);
      spec.signal?.addEventListener("abort", onAbort, { once: true });

      let res: Response;
      let text: string;
      try {
        res = await this.fetchFn(url, { ...init, signal: controller.signal });
        text = await res.text();
      } catch (cause) {
        if (spec.signal?.aborted) throw spec.signal.reason;
        const error = timedOut ? new AuroraTimeoutError(spec.label, this.timeoutMs) : new AuroraNetworkError(spec.label, cause);
        if (!spec.idempotent || last) throw error;
        await this.sleep(this.backoff(attempt), spec.signal);
        continue;
      } finally {
        clearTimeout(timer);
        spec.signal?.removeEventListener("abort", onAbort);
      }

      let body: unknown = text;
      try {
        body = text ? JSON.parse(text) : undefined;
      } catch {
        // Keep the raw text; non-JSON bodies only matter for errors.
      }

      if (res.status === 429) {
        const header = Number(res.headers.get("retry-after"));
        const retryAfterSeconds = Number.isFinite(header) && header > 0 ? header : 1;
        const wait = Math.max(retryAfterSeconds * 1000, this.backoff(attempt));
        if (last || retryAfterSeconds * 1000 > this.maxRetryAfterMs) {
          throw new AuroraRateLimitError(spec.label, errorMessage(429, spec.label, body), body, retryAfterSeconds);
        }
        await this.sleep(wait + Math.floor(this.random() * 500), spec.signal);
        continue;
      }

      if (!res.ok) {
        if (spec.idempotent && !last && RETRYABLE_STATUS.has(res.status)) {
          await this.sleep(this.backoff(attempt), spec.signal);
          continue;
        }
        const correlationId = bodyField(body, "correlationId");
        const apiStatusCode = bodyField(body, "statusCode");
        throw new AuroraHttpError(
          res.status,
          spec.label,
          errorMessage(res.status, spec.label, body),
          body,
          typeof correlationId === "string" ? correlationId : undefined,
          typeof apiStatusCode === "number" ? apiStatusCode : undefined,
        );
      }

      const parsed = spec.schema.safeParse(body);
      if (!parsed.success) throw new AuroraResponseError(spec.label, z.prettifyError(parsed.error), body);
      return parsed.data;
    }
  }
}
