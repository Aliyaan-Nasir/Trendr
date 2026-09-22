import { DAY_MS, HOUR_MS } from "./plan";

/**
 * What the targets spend, from the drops in their balances between checks (refills only raise
 * them, so they never count). Kept in memory: after a restart the estimate returns once an hour
 * has been observed.
 */
export class BurnMeter {
  private readonly last = new Map<string, bigint>();
  private samples: { at: number; name: string; wei: bigint }[] = [];
  private since: number | null = null;

  observe(now: number, name: string, balance: bigint): void {
    const prev = this.last.get(name);
    if (prev !== undefined && balance < prev) this.samples.push({ at: now, name, wei: prev - balance });
    this.last.set(name, balance);
    this.since ??= now;
    this.samples = this.samples.filter((s) => s.at > now - DAY_MS);
  }

  /** Wei per day over the last 24 hours (all targets, or one), or null before an hour of observation. */
  perDay(now: number, name?: string): bigint | null {
    if (this.since === null) return null;
    const span = now - Math.max(this.since, now - DAY_MS);
    if (span < HOUR_MS) return null;
    let total = 0n;
    for (const s of this.samples) if (s.at > now - DAY_MS && (name === undefined || s.name === name)) total += s.wei;
    return (total * BigInt(DAY_MS)) / BigInt(span);
  }
}

/** Days the spendable MON lasts at `perDay`; null when nothing is being spent or the burn is unknown. */
export function runwayDays(spendable: bigint, perDay: bigint | null): number | null {
  if (perDay === null || perDay === 0n) return null;
  return Number((spendable * 100n) / perDay) / 100;
}
