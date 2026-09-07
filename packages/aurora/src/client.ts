import { z } from "zod";
import { AuroraInputError, AuroraResponseError } from "./errors";
import { defaultSleep, HttpClient, type HttpOptions } from "./http";
import {
  type CreatePersistentAddressRequest,
  createPersistentAddressRequestSchema,
  type IncidentsResponse,
  incidentsResponseSchema,
  type PersistentAddressPage,
  persistentAddressPageSchema,
  type PersistentAddressRecord,
  persistentAddressRecordSchema,
  type PersistentAddressResponse,
  persistentAddressResponseSchema,
  type PersistentDeposit,
  persistentDepositsResponseSchema,
  type QuoteRequest,
  quoteRequestSchema,
  type QuoteResponse,
  quoteResponseSchema,
  type StatusResponse,
  statusResponseSchema,
  type SubmitDepositRequest,
  submitDepositRequestSchema,
  type SwapStatus,
  type SwapStatusResponse,
  swapStatusResponseSchema,
  TERMINAL_SWAP_STATUSES,
  tokensResponseSchema,
  transactionsResponseSchema,
} from "./schemas";
import { TokenList } from "./tokens";

export const AURORA_SWAP_API = "https://intents-api.aurora.dev";

/** Aurora asks for status polls every 5 to 10 seconds; faster polling does not settle sooner. */
export const MIN_STATUS_POLL_MS = 5_000;
export const DEFAULT_STATUS_POLL_MS = 6_000;
/** Aurora asks for the token list to be cached and refreshed every few minutes. */
export const DEFAULT_TOKEN_TTL_MS = 5 * 60_000;

export interface AuroraClientOptions extends Partial<HttpOptions> {
  /** The app key from Intents Studio. Not secret (Aurora ships it in browsers) but never logged here. */
  apiKey: string;
  tokenTtlMs?: number;
  now?: () => number;
}

export interface StatusPollOptions {
  depositMemo?: string;
  intervalMs?: number;
  signal?: AbortSignal;
  /** Called on every poll, before the terminal check. */
  onStatus?: (status: StatusResponse) => void;
  /**
   * Extra statuses that end the wait, for example INCOMPLETE_DEPOSIT to ask the user for the rest
   * at once. SUCCESS, REFUNDED and FAILED always end it.
   */
  stopOn?: readonly SwapStatus[];
}

export interface TransactionsQuery {
  walletAddress?: string;
  numberOfTransactions?: number;
  lastDepositAddress?: string;
  lastDepositMemo?: string;
  direction?: "next" | "prev";
}

export interface PersistentAddressesQuery {
  recipient?: string;
  sender?: string;
  depositChain?: string;
  recipientChain?: string;
  destinationAsset?: string;
  sort?: "created" | "used";
  page?: number;
  perPage?: number;
}

/** True when the status response carries swap details (every non-confidential swap). */
export function hasDetails(status: StatusResponse): status is SwapStatusResponse {
  return "swapDetails" in status;
}

/**
 * The Swap API and persistent deposit addresses (https://intents-api.aurora.dev). The API key is a
 * path segment on every call; errors and logs show it as {apiKey}.
 */
export class AuroraClient {
  private readonly http: HttpClient;
  private readonly sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
  private readonly now: () => number;
  private readonly tokenTtlMs: number;
  private tokenCache?: { at: number; list: TokenList };
  private tokenFetch?: Promise<TokenList>;

  constructor(private readonly options: AuroraClientOptions) {
    if (!options.apiKey) throw new AuroraInputError("an Aurora API key is required");
    this.http = new HttpClient({ ...options, baseUrl: options.baseUrl ?? AURORA_SWAP_API });
    this.sleep = options.sleep ?? defaultSleep;
    this.now = options.now ?? Date.now;
    this.tokenTtlMs = options.tokenTtlMs ?? DEFAULT_TOKEN_TTL_MS;
  }

  private key(path: string) {
    return { path: `${path}/${encodeURIComponent(this.options.apiKey)}`, label: `${path}/{apiKey}` };
  }

  /** GET /api/tokens/{apiKey}, cached for `tokenTtlMs`. Concurrent callers share one request. */
  async tokens(options: { refresh?: boolean; signal?: AbortSignal } = {}): Promise<TokenList> {
    const cached = this.tokenCache;
    if (!options.refresh && cached && this.now() - cached.at < this.tokenTtlMs) return cached.list;
    if (!this.tokenFetch) {
      this.tokenFetch = this.http
        .request({ method: "GET", ...this.key("/api/tokens"), schema: tokensResponseSchema, idempotent: true, signal: options.signal })
        .then((res) => {
          const list = new TokenList(res.tokens);
          this.tokenCache = { at: this.now(), list };
          return list;
        })
        .finally(() => {
          this.tokenFetch = undefined;
        });
    }
    return this.tokenFetch;
  }

  /**
   * POST /api/quote/{apiKey}. A dry quote prices the swap and reserves nothing; a live quote also
   * returns the deposit address and deadline. Only dry quotes are retried after a network error or
   * 5xx, so a retry never leaves two live deposit addresses behind.
   */
  async quote(request: QuoteRequest, signal?: AbortSignal): Promise<QuoteResponse> {
    const parsed = quoteRequestSchema.safeParse(request);
    if (!parsed.success) throw new AuroraInputError(`invalid quote request: ${z.prettifyError(parsed.error)}`);
    const res = await this.http.request({
      method: "POST",
      ...this.key("/api/quote"),
      body: parsed.data,
      schema: quoteResponseSchema,
      idempotent: parsed.data.dry,
      signal,
    });
    if (!parsed.data.dry && (!res.quote.depositAddress || !res.quote.deadline)) {
      throw new AuroraResponseError("/api/quote/{apiKey}", "a live quote came back without a deposit address or deadline", res);
    }
    return res;
  }

  /** POST /api/deposit/submit/{apiKey}: tells Aurora the deposit tx so it is detected sooner. Optional but recommended. */
  async submitDeposit(request: SubmitDepositRequest, signal?: AbortSignal): Promise<SwapStatusResponse> {
    const parsed = submitDepositRequestSchema.safeParse(request);
    if (!parsed.success) throw new AuroraInputError(`invalid deposit: ${z.prettifyError(parsed.error)}`);
    return this.http.request({
      method: "POST",
      ...this.key("/api/deposit/submit"),
      body: parsed.data,
      schema: swapStatusResponseSchema,
      idempotent: true,
      signal,
    });
  }

  /** GET /api/status/{apiKey}?depositAddress=... An unknown address is an error with isNotFound(error). */
  status(depositAddress: string, depositMemo?: string, signal?: AbortSignal): Promise<StatusResponse> {
    return this.http.request({
      method: "GET",
      ...this.key("/api/status"),
      query: { depositAddress, depositMemo },
      schema: statusResponseSchema,
      idempotent: true,
      signal,
    });
  }

  /**
   * Polls the status every `intervalMs` (at least 5 s, per Aurora) until SUCCESS, REFUNDED or
   * FAILED, or a status in `stopOn`. Abort with `signal`; persist progress from `onStatus` so a
   * restarted process can resume with the same deposit address.
   */
  async waitForSwap(depositAddress: string, options: StatusPollOptions = {}): Promise<StatusResponse> {
    const interval = Math.max(MIN_STATUS_POLL_MS, options.intervalMs ?? DEFAULT_STATUS_POLL_MS);
    const stop = new Set<SwapStatus>([...TERMINAL_SWAP_STATUSES, ...(options.stopOn ?? [])]);
    for (;;) {
      const status = await this.status(depositAddress, options.depositMemo, options.signal);
      options.onStatus?.(status);
      if (stop.has(status.status)) return status;
      await this.sleep(interval, options.signal);
    }
  }

  /** GET /api/transactions/{apiKey}: recent swaps made with this key, newest first. */
  async transactions(query: TransactionsQuery = {}, signal?: AbortSignal) {
    const res = await this.http.request({
      method: "GET",
      ...this.key("/api/transactions"),
      query: { ...query },
      schema: transactionsResponseSchema,
      idempotent: true,
      signal,
    });
    return Array.isArray(res) ? res : res.data;
  }

  /** GET /api/incidents/{apiKey}: active incidents by chain, asset or address, to warn users before they send. */
  incidents(signal?: AbortSignal): Promise<IncidentsResponse> {
    return this.http.request({ method: "GET", ...this.key("/api/incidents"), schema: incidentsResponseSchema, idempotent: true, signal });
  }

  /**
   * POST /api/persistent-deposit-address/{apiKey}: a permanent, reusable address for one user that
   * routes any supported asset on `depositChain` to `destinationAsset` at `recipient`. Repeat calls
   * with the same inputs return the same address, so it is retried like a read. Keys Aurora has not
   * approved get HTTP 403.
   */
  async createPersistentAddress(request: CreatePersistentAddressRequest, signal?: AbortSignal): Promise<PersistentAddressResponse> {
    const parsed = createPersistentAddressRequestSchema.safeParse(request);
    if (!parsed.success) throw new AuroraInputError(`invalid persistent address request: ${z.prettifyError(parsed.error)}`);
    return this.http.request({
      method: "POST",
      ...this.key("/api/persistent-deposit-address"),
      body: parsed.data,
      schema: persistentAddressResponseSchema,
      idempotent: true,
      signal,
    });
  }

  /**
   * GET /api/persistent-deposit-status/{apiKey}: `received` lists deposits that reached the
   * address's Intents account, `success` the deliveries to the recipient, `failed` the failed ones.
   */
  async persistentDeposits(
    address: string,
    type: "received" | "success" | "failed",
    page: { limit?: number; offset?: number } = {},
    signal?: AbortSignal,
  ): Promise<PersistentDeposit[]> {
    const res = await this.http.request({
      method: "GET",
      ...this.key("/api/persistent-deposit-status"),
      query: { type, address, ...page },
      schema: persistentDepositsResponseSchema,
      idempotent: true,
      signal,
    });
    return res.deposits;
  }

  /** GET /api/persistent-deposit-address-data/{apiKey}: one address this key created. */
  persistentAddress(address: string, signal?: AbortSignal): Promise<PersistentAddressRecord> {
    return this.http.request({
      method: "GET",
      ...this.key("/api/persistent-deposit-address-data"),
      query: { address },
      schema: persistentAddressRecordSchema,
      idempotent: true,
      signal,
    });
  }

  /** GET /api/persistent-deposit-addresses/{apiKey}: addresses this key created, filtered and paged. */
  persistentAddresses(query: PersistentAddressesQuery = {}, signal?: AbortSignal): Promise<PersistentAddressPage> {
    return this.http.request({
      method: "GET",
      ...this.key("/api/persistent-deposit-addresses"),
      query: { ...query },
      schema: persistentAddressPageSchema,
      idempotent: true,
      signal,
    });
  }
}
