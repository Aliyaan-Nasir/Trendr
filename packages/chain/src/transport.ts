import { http, type HttpTransport } from "viem";

/** Paces requests to a fixed rate with a small burst, shared by everything using one limiter. */
export class RateLimiter {
  private tokens: number;
  private last = Date.now();
  private queue: (() => void)[] = [];
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly perSecond: number,
    private readonly burst = Math.max(1, Math.ceil(perSecond / 2)),
  ) {
    this.tokens = this.burst;
  }

  take(): Promise<void> {
    return new Promise((resolve) => {
      this.queue.push(resolve);
      this.drain();
    });
  }

  private drain() {
    const now = Date.now();
    this.tokens = Math.min(this.burst, this.tokens + ((now - this.last) / 1000) * this.perSecond);
    this.last = now;
    while (this.queue.length > 0 && this.tokens >= 1) {
      this.tokens -= 1;
      this.queue.shift()!();
    }
    if (this.queue.length > 0 && !this.timer) {
      this.timer = setTimeout(() => {
        this.timer = null;
        this.drain();
      }, Math.ceil(((1 - this.tokens) / this.perSecond) * 1000));
    }
  }
}

const RATE_LIMITED = /limited|rate limit|too many requests/i;

/** True when an RPC response says the caller exceeded its request rate. */
export async function isRateLimited(res: Response): Promise<boolean> {
  if (res.status === 429) return true;
  if (!res.ok) return false;
  const text = await res.clone().text();
  return text.includes('"error"') && RATE_LIMITED.test(text);
}

export interface TransportOptions {
  /** Requests per second this process may send; shared public RPCs allow about 15 per IP. */
  requestsPerSecond?: number;
  /** Attempts for a request that was rate limited, failed on the server or failed to connect. */
  attempts?: number;
  limiter?: RateLimiter;
}

const limiters = new Map<string, RateLimiter>();

/**
 * An HTTP transport that paces requests and retries transient failures (rate limits, server
 * errors, dropped connections) with jittered exponential backoff. viem's own retries are off so
 * the two never compound. Every client in a process that uses the same URL shares one limiter,
 * whose rate the first of them sets.
 */
export function pacedHttp(url: string, opts: TransportOptions = {}): HttpTransport {
  // One limiter per URL and process: the first client to use a URL sets its rate.
  const limiter = opts.limiter ?? limiters.get(url) ?? new RateLimiter(opts.requestsPerSecond ?? 10);
  limiters.set(url, limiter);
  const attempts = opts.attempts ?? 6;
  return http(url, {
    retryCount: 0,
    fetchFn: async (input, init) => {
      let delay = 250;
      for (let attempt = 1; ; attempt++) {
        await limiter.take();
        let res: Response | null = null;
        try {
          res = await fetch(input, init);
        } catch (e) {
          if (attempt >= attempts) throw e;
        }
        if (res && (attempt >= attempts || (res.status < 500 && !(await isRateLimited(res))))) return res;
        await new Promise((r) => setTimeout(r, delay + Math.random() * delay));
        delay = Math.min(delay * 2, 5000);
      }
    },
  });
}
