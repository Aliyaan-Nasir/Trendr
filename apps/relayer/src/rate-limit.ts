/** Token buckets keyed by caller, with an injectable clock for tests. */
export class RateLimiter {
  private readonly buckets = new Map<string, { tokens: number; at: number }>();

  constructor(
    private readonly capacity: number,
    private readonly refillPerSecond: number,
    private readonly now: () => number = () => Date.now() / 1000,
  ) {}

  /** Takes one token for `key`; false when the bucket is empty. */
  take(key: string): boolean {
    const t = this.now();
    const b = this.buckets.get(key) ?? { tokens: this.capacity, at: t };
    b.tokens = Math.min(this.capacity, b.tokens + (t - b.at) * this.refillPerSecond);
    b.at = t;
    if (b.tokens < 1) {
      this.buckets.set(key, b);
      return false;
    }
    b.tokens -= 1;
    this.buckets.set(key, b);
    if (this.buckets.size > 100_000) this.sweep(t);
    return true;
  }

  /** Whole seconds until `key` has a token again (at least 1), for a Retry-After header. */
  retryAfter(key: string): number {
    const b = this.buckets.get(key);
    if (!b) return 1;
    const tokens = Math.min(this.capacity, b.tokens + (this.now() - b.at) * this.refillPerSecond);
    return Math.max(1, Math.ceil((1 - tokens) / this.refillPerSecond));
  }

  /** Drops full buckets so memory stays bounded. */
  private sweep(t: number) {
    for (const [k, b] of this.buckets) {
      if (b.tokens + (t - b.at) * this.refillPerSecond >= this.capacity) this.buckets.delete(k);
    }
  }
}
