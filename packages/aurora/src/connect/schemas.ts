import { z } from "zod";

/**
 * Zod schemas for the Intents Connect API (https://intents-connect-api.aurora.dev), checked against
 * dry-run responses recorded from the live API. The OpenAPI spec marks every field optional and
 * the live API sends nulls for absent ones, so most fields are `nullish`.
 */

export const executionStatusSchema = z.enum([
  "CREATED",
  "DEPOSIT_PENDING",
  "DEPOSIT_PROCESSING",
  "OPERATION_PENDING",
  "OPERATION_PROCESSING",
  "SUCCESS",
  "DEPOSIT_FAILED",
  "OPERATION_FAILED",
  "EXPIRED",
]);
export type ExecutionStatus = z.infer<typeof executionStatusSchema>;

/** Final statuses. EXPIRED is final for the API, but a late deposit can still revive it (see the SDK docs). */
export const TERMINAL_EXECUTION_STATUSES: readonly ExecutionStatus[] = ["SUCCESS", "DEPOSIT_FAILED", "OPERATION_FAILED", "EXPIRED"];

export const signingStandardSchema = z.enum(["raw_ed25519", "nep413", "erc191", "tip191", "sep53", "ton_connect"]);
export type SigningStandard = z.infer<typeof signingStandardSchema>;

/** A step parameter as JSON: integers as decimal strings, addresses and bytes as 0x hex, tuples and arrays as arrays. */
export type StepParameter = string | number | boolean | StepParameter[];
export const stepParameterSchema: z.ZodType<StepParameter> = z.lazy(() =>
  z.union([z.string(), z.number(), z.boolean(), z.array(stepParameterSchema)]),
);

/** An EVM step: a call from the intermediary. These five keys are the only ones the API accepts. */
export const evmStepSchema = z.object({
  to: z.string(),
  functionSignature: z.string(),
  parameters: z.array(stepParameterSchema),
  value: z.string().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});
export type EvmStepResponse = z.infer<typeof evmStepSchema>;

/** Solana steps appear in listings of wallets that also used Solana; Trendr does not build them. */
const solanaStepSchema = z.object({ programId: z.string() }).loose();

export const signingPayloadSchema = z.object({
  standard: signingStandardSchema.nullish(),
  /** The exact string an erc191 wallet signs, verbatim. */
  payload_json: z.string().nullish(),
  payload_bytes_base64: z.string().nullish(),
});

export const executionQuoteSchema = z.object({
  amount: z.string().nullish(),
  amountIn: z.string().nullish(),
  amountInUsd: z.string().nullish(),
  amountOut: z.string().nullish(),
  amountOutUsd: z.string().nullish(),
  deadline: z.string().nullish(),
  depositAddress: z.string().nullish(),
  depositMemo: z.string().nullish(),
  destinationAsset: z.string().nullish(),
  minAmountIn: z.string().nullish(),
  minAmountOut: z.string().nullish(),
  originAsset: z.string().nullish(),
  recipient: z.string().nullish(),
  swapType: z.enum(["EXACT_INPUT", "EXACT_OUTPUT"]).nullish(),
});

export const executionDetailsSchema = z.object({
  /** Seconds, as a string. */
  estimatedTime: z.string().nullish(),
  intermediaryAddress: z.string().nullish(),
  messageSigned: z.boolean().nullish(),
  messageToSign: z.string().nullish(),
  /** Gas reimbursement in raw destination-token units, taken by a transfer step the service appends. */
  networkFee: z.string().nullish(),
  payload: signingPayloadSchema.nullish(),
  signingStandard: signingStandardSchema.nullish(),
});

export const executionSchema = z.object({
  id: z.string().nullish(),
  createdAt: z.string().nullish(),
  status: executionStatusSchema,
  executionMode: z.enum(["quote_with_steps", "steps_only"]).nullish(),
  type: z.enum(["evm", "solana"]).nullish(),
  version: z.string().nullish(),
  metadata: z.record(z.string(), z.unknown()).nullish(),
  details: executionDetailsSchema.nullish(),
  quote: executionQuoteSchema.nullish(),
  steps: z.array(z.union([evmStepSchema, solanaStepSchema])).nullish(),
});
export type Execution = z.infer<typeof executionSchema>;

export const executionResponseSchema = z.object({ result: executionSchema });
export const executionsResponseSchema = z.object({ result: z.array(executionSchema) });
export const resultStatusSchema = z.object({ result: z.object({ status: z.string() }) });

export const intermediaryResponseSchema = z.object({
  result: z.object({
    /** The EVM intermediary (same address on every EVM destination). */
    evm: z.string(),
    originAccount: z.string().nullish(),
    originType: z.enum(["evm", "near", "solana", "stellar", "ton", "tron"]).nullish(),
    solana: z.string().nullish(),
  }),
});
export type Intermediary = z.infer<typeof intermediaryResponseSchema>["result"];

export const connectTokenSchema = z.object({
  assetId: z.string(),
  blockchain: z.string(),
  coingeckoId: z.string().nullish(),
  /** Empty string for native assets. */
  contractAddress: z.string().nullish(),
  decimals: z.number().int(),
  price: z.number().nullish(),
  priceUpdatedAt: z.string().nullish(),
  symbol: z.string(),
});
export type ConnectToken = z.infer<typeof connectTokenSchema>;

export const supportedTokensResponseSchema = z.object({
  result: z.object({ in: z.array(connectTokenSchema), out: z.array(connectTokenSchema) }),
});
