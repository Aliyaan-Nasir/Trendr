import { z } from "zod";
import { DEFAULT_STATUS_POLL_MS, MIN_STATUS_POLL_MS } from "../client";
import { AuroraInputError } from "../errors";
import { defaultSleep, HttpClient, type HttpOptions } from "../http";
import {
  type ConnectToken,
  type Execution,
  executionResponseSchema,
  type ExecutionStatus,
  executionsResponseSchema,
  type Intermediary,
  intermediaryResponseSchema,
  resultStatusSchema,
  supportedTokensResponseSchema,
  TERMINAL_EXECUTION_STATUSES,
} from "./schemas";
import type { EvmStep } from "./steps";

export const INTENTS_CONNECT_API = "https://intents-connect-api.aurora.dev";

/** The quote half of a bridge-in or out-operation execution. */
export interface ConnectQuote {
  originAsset: string;
  destinationAsset: string;
  /** Raw units: origin for EXACT_INPUT, destination for EXACT_OUTPUT. */
  amount: string;
  swapType: "EXACT_INPUT" | "EXACT_OUTPUT";
  slippageTolerance: number;
  deadline?: string;
  /** Out-operations only; a bridge-in always delivers to the intermediary. */
  recipient?: string;
}

export interface CreateExecutionBody {
  version: "1.0";
  type: "evm";
  quote: ConnectQuote;
  steps: EvmStep[];
  metadata?: Record<string, unknown>;
  dry: boolean;
  outOperation?: boolean;
}

export interface CreateStepsBody {
  version: "1.0";
  type: "evm";
  /** The token the service charges its fee in (and the steps must touch). */
  destinationAsset: string;
  steps: EvmStep[];
  metadata?: Record<string, unknown>;
  dry: boolean;
}

export interface ConnectClientOptions extends Partial<HttpOptions> {
  /** Sent as x-api-key on the two create calls. Keep it server-side (Aurora's SDK proxies it). */
  apiKey?: string;
}

const connectQuoteSchema = z.object({
  originAsset: z.string().min(1),
  destinationAsset: z.string().min(1),
  amount: z.string().regex(/^\d+$/),
  swapType: z.enum(["EXACT_INPUT", "EXACT_OUTPUT"]),
  slippageTolerance: z.number().int().min(0).max(10_000),
  deadline: z.string().optional(),
  recipient: z.string().optional(),
});

/**
 * The Intents Connect API. Every call is keyed by the origin wallet (the address that signs). The
 * create calls accept `dry: true`, which quotes, sizes the network fee and simulates the steps
 * without creating anything; a live create takes a per-wallet lock until the execution finishes.
 */
export class IntentsConnectClient {
  private readonly http: HttpClient;
  private readonly sleep: (ms: number, signal?: AbortSignal) => Promise<void>;

  constructor(private readonly options: ConnectClientOptions = {}) {
    this.http = new HttpClient({ ...options, baseUrl: options.baseUrl ?? INTENTS_CONNECT_API });
    this.sleep = options.sleep ?? defaultSleep;
  }

  private keyHeader(): Record<string, string> {
    if (!this.options.apiKey) throw new AuroraInputError("this call needs the Aurora API key (x-api-key)");
    return { "x-api-key": this.options.apiKey };
  }

  /** GET /api/v1/supported_tokens. `outOperation` swaps the lists for EVM-origin out-operations. */
  async supportedTokens(flow?: "inOperation" | "outOperation", signal?: AbortSignal): Promise<{ in: ConnectToken[]; out: ConnectToken[] }> {
    const res = await this.http.request({
      method: "GET",
      path: "/api/v1/supported_tokens",
      label: "/api/v1/supported_tokens",
      query: { flow },
      schema: supportedTokensResponseSchema,
      idempotent: true,
      signal,
    });
    return res.result;
  }

  /** GET /api/v1/executions/{wallet}/intermediary: the deterministic accounts the wallet controls on destination chains. */
  async intermediary(wallet: string, signal?: AbortSignal): Promise<Intermediary> {
    const path = `/api/v1/executions/${encodeURIComponent(wallet)}/intermediary`;
    const res = await this.http.request({ method: "GET", path, label: path, schema: intermediaryResponseSchema, idempotent: true, signal });
    return res.result;
  }

  /**
   * POST /api/v1/executions/{wallet}: a quote-backed execution (bridge-in, or out-operation with
   * `outOperation: true`). Dry runs are retried like reads; a live create is not, because it takes
   * the wallet's in-flight lock (a second one answers 409).
   */
  async createExecution(wallet: string, body: CreateExecutionBody, signal?: AbortSignal): Promise<Execution> {
    const quote = connectQuoteSchema.safeParse(body.quote);
    if (!quote.success) throw new AuroraInputError(`invalid execution quote: ${z.prettifyError(quote.error)}`);
    if (body.quote.recipient && !body.outOperation) throw new AuroraInputError("quote.recipient is only allowed on an out-operation");
    if (!body.dry && body.steps.length === 0) throw new AuroraInputError("a live execution needs steps");
    const path = `/api/v1/executions/${encodeURIComponent(wallet)}`;
    const res = await this.http.request({
      method: "POST",
      path,
      label: path,
      headers: this.keyHeader(),
      body,
      schema: executionResponseSchema,
      idempotent: body.dry,
      signal,
    });
    return res.result;
  }

  /** POST /api/v1/executions/{wallet}/steps: steps on funds the intermediary already holds (no bridge, no key needed). */
  async createStepsExecution(wallet: string, body: CreateStepsBody, signal?: AbortSignal): Promise<Execution> {
    if (!body.dry && body.steps.length === 0) throw new AuroraInputError("a live execution needs steps");
    const path = `/api/v1/executions/${encodeURIComponent(wallet)}/steps`;
    const res = await this.http.request({ method: "POST", path, label: path, body, schema: executionResponseSchema, idempotent: body.dry, signal });
    return res.result;
  }

  /** POST /api/v1/executions/{wallet}/submit: the origin wallet's signature over the execution's payload. */
  async submitSignature(wallet: string, body: { executionId: string; signature: string; publicKey?: string }, signal?: AbortSignal): Promise<string> {
    const path = `/api/v1/executions/${encodeURIComponent(wallet)}/submit`;
    const res = await this.http.request({ method: "POST", path, label: path, body, schema: resultStatusSchema, idempotent: true, signal });
    return res.result.status;
  }

  /** POST /api/v1/executions/deposit/submit: records the origin-chain deposit transaction and notifies 1Click. */
  async recordDeposit(body: { txHash: string; depositAddress: string; memo?: string }, signal?: AbortSignal): Promise<string> {
    const path = "/api/v1/executions/deposit/submit";
    const res = await this.http.request({ method: "POST", path, label: path, body, schema: resultStatusSchema, idempotent: true, signal });
    return res.result.status;
  }

  /** GET /api/v1/executions/{wallet}, optionally filtered by ids and statuses. */
  async executions(wallet: string, filter: { id?: string | string[]; status?: ExecutionStatus | ExecutionStatus[] } = {}, signal?: AbortSignal): Promise<Execution[]> {
    const path = `/api/v1/executions/${encodeURIComponent(wallet)}`;
    const join = (v?: string | string[]) => (Array.isArray(v) ? v.join(",") : v);
    const res = await this.http.request({
      method: "GET",
      path,
      label: path,
      query: { id: join(filter.id), status: join(filter.status) },
      schema: executionsResponseSchema,
      idempotent: true,
      signal,
    });
    return res.result;
  }

  async execution(wallet: string, id: string, signal?: AbortSignal): Promise<Execution | undefined> {
    return (await this.executions(wallet, { id }, signal)).find((e) => e.id === id);
  }

  /**
   * DELETE /api/v1/executions/{wallet}/{id}: frees the wallet's lock. Needs the wallet's signature
   * over "delete_execution:{id}" (see deleteExecutionMessage). Not allowed after SUCCESS.
   */
  async deleteExecution(wallet: string, executionId: string, body: { signature: string; publicKey?: string }, signal?: AbortSignal): Promise<string> {
    const path = `/api/v1/executions/${encodeURIComponent(wallet)}/${encodeURIComponent(executionId)}`;
    const res = await this.http.request({ method: "DELETE", path, label: path, body, schema: resultStatusSchema, idempotent: true, signal });
    return res.result.status;
  }

  /** Polls one execution (at least every 5 s) until it reaches a final status. */
  async waitForExecution(
    wallet: string,
    executionId: string,
    options: { intervalMs?: number; signal?: AbortSignal; onUpdate?: (execution: Execution) => void } = {},
  ): Promise<Execution> {
    const interval = Math.max(MIN_STATUS_POLL_MS, options.intervalMs ?? DEFAULT_STATUS_POLL_MS);
    for (;;) {
      const execution = await this.execution(wallet, executionId, options.signal);
      if (!execution) throw new AuroraInputError(`execution ${executionId} not found for ${wallet}`);
      options.onUpdate?.(execution);
      if (TERMINAL_EXECUTION_STATUSES.includes(execution.status)) return execution;
      await this.sleep(interval, options.signal);
    }
  }
}
