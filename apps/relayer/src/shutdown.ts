/**
 * A redeploy sends SIGTERM: stop taking requests and let relays already sending reach the chain and
 * answer, so no account is left with a transaction it never heard back about. Railway waits
 * drainingSeconds (15) before it kills the process, so the wait stops short of that.
 */
export const DRAIN_MS = 12_000;

/** What draining needs from Bun's server: stop listening and resolve once open requests answered. */
export interface Stoppable {
  stop(closeActiveConnections?: boolean): Promise<void> | void;
}

/**
 * Stops taking new connections and waits for requests in flight (each account's queued relays are
 * requests in flight too) up to `ms`. Resolves true when every request answered, false on timeout.
 */
export async function drain(server: Stoppable, ms = DRAIN_MS): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<false>((r) => {
    timer = setTimeout(() => r(false), ms);
  });
  try {
    return await Promise.race([Promise.resolve(server.stop()).then(() => true as const), timeout]);
  } finally {
    clearTimeout(timer);
  }
}
