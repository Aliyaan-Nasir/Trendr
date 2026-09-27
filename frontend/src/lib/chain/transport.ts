import { fallback, http, type Transport } from "viem";

/** Every read endpoint in order, each batching its own requests, falling over on errors and limits. */
export function readTransport(urls: readonly string[]): Transport {
  const transports = urls.map((u) => http(u, { batch: true, retryCount: 1 }));
  return transports.length === 1 ? transports[0]! : fallback(transports, { retryCount: 1 });
}

/** The endpoint after `i` in a list of `n`, wrapping around: where a dropped stream reconnects. */
export const nextEndpoint = (i: number, n: number) => (n > 0 ? (i + 1) % n : 0);
