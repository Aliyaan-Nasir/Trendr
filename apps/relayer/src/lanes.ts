/**
 * One relay per account at a time. A later request waits for the earlier one to land, so its
 * simulation sees the earlier batch's effects: a second copy of a signed batch, or a second batch
 * with the same nonce, fails simulation for free instead of reverting on chain from another
 * sponsor key. A few requests may wait; beyond that the account is refused.
 */
export class AccountLanes {
  private readonly lanes = new Map<string, { tail: Promise<void>; pending: number }>();

  /** @param maxPending Requests per account in flight or waiting. */
  constructor(private readonly maxPending: number) {}

  /** Runs `fn` after the account's earlier requests, or returns null when too many are pending. */
  run<T>(account: string, fn: () => Promise<T>): Promise<T> | null {
    const key = account.toLowerCase();
    const lane = this.lanes.get(key) ?? { tail: Promise.resolve(), pending: 0 };
    if (lane.pending >= this.maxPending) return null;
    lane.pending += 1;
    this.lanes.set(key, lane);
    const result = lane.tail.then(fn);
    lane.tail = result.then(
      () => this.done(key, lane),
      () => this.done(key, lane),
    );
    return result;
  }

  /** Accounts with a request in flight or waiting. */
  get busy(): number {
    return this.lanes.size;
  }

  private done(key: string, lane: { pending: number }) {
    lane.pending -= 1;
    if (lane.pending === 0 && this.lanes.get(key) === lane) this.lanes.delete(key);
  }
}
