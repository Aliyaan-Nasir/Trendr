/**
 * Typed errors for every way an Aurora call can fail. Paths in errors never contain the API key:
 * the key is a path segment on the Swap API, so callers pass a redacted path for messages.
 */

export class AuroraError extends Error {
  override name = "AuroraError";
}

/** The request was rejected locally before it was sent (bad amount, address, slippage...). */
export class AuroraInputError extends AuroraError {
  override name = "AuroraInputError";
}

/** A non-2xx response. `apiStatusCode` is the status inside the body, which can differ from the HTTP status. */
export class AuroraHttpError extends AuroraError {
  override name = "AuroraHttpError";
  constructor(
    readonly status: number,
    readonly path: string,
    message: string,
    readonly body: unknown,
    readonly correlationId?: string,
    readonly apiStatusCode?: number,
  ) {
    super(message);
  }
}

/** HTTP 429. `retryAfterSeconds` comes from the Retry-After header (up to 3600 for the hourly window). */
export class AuroraRateLimitError extends AuroraHttpError {
  override name = "AuroraRateLimitError";
  constructor(
    path: string,
    message: string,
    body: unknown,
    readonly retryAfterSeconds: number,
  ) {
    super(429, path, message, body);
  }
}

/** No response within the per-attempt timeout, on every attempt allowed. */
export class AuroraTimeoutError extends AuroraError {
  override name = "AuroraTimeoutError";
  constructor(
    readonly path: string,
    readonly timeoutMs: number,
  ) {
    super(`Aurora ${path}: no response within ${timeoutMs} ms`);
  }
}

/** The request never produced an HTTP response (DNS, TLS, connection reset). */
export class AuroraNetworkError extends AuroraError {
  override name = "AuroraNetworkError";
  constructor(
    readonly path: string,
    override readonly cause: unknown,
  ) {
    super(`Aurora ${path}: ${cause instanceof Error ? cause.message : String(cause)}`);
  }
}

/** A 2xx response whose body does not match the documented shape. */
export class AuroraResponseError extends AuroraError {
  override name = "AuroraResponseError";
  constructor(
    readonly path: string,
    readonly issues: string,
    readonly body: unknown,
  ) {
    super(`Aurora ${path}: unexpected response: ${issues}`);
  }
}

/** True for a 404 from Aurora, including a 400 whose body says 404 (unknown deposit address). */
export function isNotFound(error: unknown): boolean {
  return error instanceof AuroraHttpError && (error.status === 404 || error.apiStatusCode === 404);
}

/**
 * The smallest origin amount Aurora accepts, when a quote was rejected as too small. Aurora says
 * "Amount is too low for bridge, try at least 150000" (raw origin units).
 */
export function minimumAmountFrom(error: unknown): bigint | undefined {
  if (!(error instanceof AuroraHttpError)) return undefined;
  const match = /too low.*?at least (\d+)/i.exec(error.message);
  return match ? BigInt(match[1]!) : undefined;
}
