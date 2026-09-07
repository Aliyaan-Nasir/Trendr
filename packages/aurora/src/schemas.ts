import { z } from "zod";

/**
 * Zod schemas for the Swap API (https://intents-api.aurora.dev), checked against responses
 * recorded from the live API (test/fixtures). Unknown fields are dropped; documented fields that
 * the live API sends as null are `nullish`.
 */

/** A raw token amount: a non-negative integer in the token's smallest unit, as a string. */
export const rawAmount = z.string().regex(/^\d+$/, "expected a non-negative integer string");

/** An ISO 8601 timestamp; Aurora sends both `...000Z` and `...Z` forms. */
export const timestamp = z.string().refine((s) => !Number.isNaN(Date.parse(s)), "expected an ISO timestamp");

export const swapTypeSchema = z.enum(["EXACT_INPUT", "EXACT_OUTPUT", "FLEX_INPUT", "ANY_INPUT"]);
export const depositTypeSchema = z.enum(["ORIGIN_CHAIN", "INTENTS", "CONFIDENTIAL_INTENTS"]);
export const refundTypeSchema = z.enum(["ORIGIN_CHAIN", "INTENTS", "CONFIDENTIAL_INTENTS"]);
export const recipientTypeSchema = z.enum(["DESTINATION_CHAIN", "INTENTS", "CONFIDENTIAL_INTENTS"]);
export const depositModeSchema = z.enum(["SIMPLE", "MEMO"]);
export const confidentialitySchema = z.enum(["public", "basic", "advanced"]);

/** Every status the Swap API documents for a swap. */
export const swapStatusSchema = z.enum(["PENDING_DEPOSIT", "KNOWN_DEPOSIT_TX", "INCOMPLETE_DEPOSIT", "PROCESSING", "SUCCESS", "REFUNDED", "FAILED"]);
export type SwapStatus = z.infer<typeof swapStatusSchema>;

/** Statuses after which a swap never changes again. */
export const TERMINAL_SWAP_STATUSES: readonly SwapStatus[] = ["SUCCESS", "REFUNDED", "FAILED"];

// --- Tokens -------------------------------------------------------------------------------------

export const tokenSchema = z.object({
  assetId: z.string().min(1),
  decimals: z.number().int().nonnegative(),
  /** Aurora's chain code: `eth`, `base`, `arb`, `sol`, `monad`... (more than the documented enum). */
  blockchain: z.string().min(1),
  symbol: z.string().min(1),
  price: z.number(),
  priceUpdatedAt: z.string(),
  /** Absent (or null) for native assets. */
  contractAddress: z.string().nullish(),
});
export type AuroraToken = z.infer<typeof tokenSchema>;

export const tokensResponseSchema = z.object({
  asset_stats: z.array(
    z.object({ token_id: z.string(), blockchain: z.string(), symbol: z.string(), volume_amount_usd: z.string() }),
  ),
  tokens: z.array(tokenSchema),
});
export type TokensResponse = z.infer<typeof tokensResponseSchema>;

// --- Quotes -------------------------------------------------------------------------------------

/** What `POST /api/quote/{apiKey}` takes. Fees are not a request field: they come from the key's configuration. */
export const quoteRequestSchema = z.object({
  /** True prices a swap without creating a deposit address. */
  dry: z.boolean(),
  swapType: swapTypeSchema,
  depositType: depositTypeSchema,
  depositMode: depositModeSchema.optional(),
  /** Raw units; the input for EXACT_INPUT and FLEX_INPUT, the output for EXACT_OUTPUT. */
  amount: rawAmount,
  originAsset: z.string().min(1),
  destinationAsset: z.string().min(1),
  /** Basis points, 100 = 1%. */
  slippageTolerance: z.number().int().min(0).max(10_000),
  refundTo: z.string().min(1),
  refundType: refundTypeSchema,
  recipient: z.string().min(1),
  recipientType: recipientTypeSchema,
  /** When refunds begin if the swap has not completed. Aurora applies a default when omitted. */
  deadline: timestamp.optional(),
  quoteWaitingTimeMs: z.number().int().nonnegative().optional(),
  sessionId: z.string().optional(),
  confidentiality: confidentialitySchema.optional(),
  virtualChainRecipient: z.string().optional(),
  virtualChainRefundRecipient: z.string().optional(),
  connectedWallets: z.array(z.string()).optional(),
});
export type QuoteRequest = z.infer<typeof quoteRequestSchema>;

export const appFeeSchema = z.object({ recipient: z.string(), fee: z.number() });

/** The request as Aurora echoes it, with the deadline it applied and the fees from the key. */
export const echoedQuoteRequestSchema = quoteRequestSchema.extend({
  deadline: timestamp,
  referral: z.string().nullish(),
  appFees: z.array(appFeeSchema).nullish(),
  virtualChainRecipient: z.string().nullish(),
  virtualChainRefundRecipient: z.string().nullish(),
  connectedWallets: z.array(z.string()).nullish(),
  customRecipientMsg: z.string().nullish(),
});

export const quoteSchema = z.object({
  /** Seconds from deposit to delivery. */
  timeEstimate: z.number(),
  /** Live quotes only: when the quote becomes inactive and refunds may begin. */
  deadline: timestamp.optional(),
  /** Live quotes only: when the deposit address stops accepting deposits. */
  timeWhenInactive: timestamp.optional(),
  /** Live quotes only. */
  depositAddress: z.string().optional(),
  depositMemo: z.string().nullish(),
  /** ANY_INPUT quotes into an Intents account: one address per chain, all funding the same account. */
  chainDepositAddresses: z.array(z.object({ blockchain: z.string(), address: z.string(), memo: z.string().optional() })).optional(),
  amountIn: rawAmount,
  amountInFormatted: z.string(),
  amountInUsd: z.string(),
  minAmountIn: rawAmount,
  maxAmountIn: rawAmount.optional(),
  amountOut: rawAmount,
  amountOutFormatted: z.string(),
  amountOutUsd: z.string(),
  minAmountOut: rawAmount,
  /** Charged in origin units if the deposit is refunded. */
  refundFee: rawAmount.nullish(),
  /** Already deducted from amountOut. */
  withdrawFee: rawAmount.nullish(),
  virtualChainRecipient: z.string().nullish(),
  virtualChainRefundRecipient: z.string().nullish(),
  customRecipientMsg: z.string().nullish(),
});
export type Quote = z.infer<typeof quoteSchema>;

export const quoteResponseSchema = z.object({
  timestamp: timestamp,
  signature: z.string(),
  correlationId: z.string().nullish(),
  quoteRequest: echoedQuoteRequestSchema,
  quote: quoteSchema,
});
export type QuoteResponse = z.infer<typeof quoteResponseSchema>;

// --- Deposits and status ------------------------------------------------------------------------

export const submitDepositRequestSchema = z.object({
  txHash: z.string().min(1),
  depositAddress: z.string().min(1),
  /** NEAR origins only. */
  nearSenderAccount: z.string().optional(),
  /** Required when the quote had a depositMemo. */
  memo: z.string().optional(),
});
export type SubmitDepositRequest = z.infer<typeof submitDepositRequestSchema>;

export const chainTxSchema = z.object({ hash: z.string(), explorerUrl: z.string() });

export const swapDetailsSchema = z.object({
  intentHashes: z.array(z.string()),
  nearTxHashes: z.array(z.string()),
  /** Settled amounts, null until the swap settles. */
  amountIn: rawAmount.nullish(),
  amountInFormatted: z.string().nullish(),
  amountInUsd: z.string().nullish(),
  amountOut: rawAmount.nullish(),
  amountOutFormatted: z.string().nullish(),
  amountOutUsd: z.string().nullish(),
  slippage: z.number().nullish(),
  /** The deposit and any refund, on the origin chain. */
  originChainTxHashes: z.array(chainTxSchema),
  /** The delivery on the destination chain (Monad). */
  destinationChainTxHashes: z.array(chainTxSchema),
  refundedAmount: rawAmount.nullish(),
  refundedAmountFormatted: z.string().nullish(),
  refundedAmountUsd: z.string().nullish(),
  refundReason: z.string().nullish(),
  depositedAmount: rawAmount.nullish(),
  depositedAmountFormatted: z.string().nullish(),
  depositedAmountUsd: z.string().nullish(),
  referral: z.string().nullish(),
});
export type SwapDetails = z.infer<typeof swapDetailsSchema>;

export const swapStatusResponseSchema = z.object({
  correlationId: z.string(),
  quoteResponse: quoteResponseSchema,
  status: swapStatusSchema,
  updatedAt: timestamp,
  swapDetails: swapDetailsSchema,
});
export type SwapStatusResponse = z.infer<typeof swapStatusResponseSchema>;

/** Confidential swaps expose only the status. Strict, so a drifted public response cannot pass as one. */
export const confidentialStatusResponseSchema = z.strictObject({ status: swapStatusSchema });
export type ConfidentialStatusResponse = z.infer<typeof confidentialStatusResponseSchema>;

export const statusResponseSchema = z.union([swapStatusResponseSchema, confidentialStatusResponseSchema]);
export type StatusResponse = z.infer<typeof statusResponseSchema>;

// --- History and incidents ----------------------------------------------------------------------

export const transactionSchema = z.object({
  originAsset: z.string(),
  destinationAsset: z.string(),
  depositAddress: z.string(),
  depositMemo: z.string().nullish(),
  depositAddressAndMemo: z.string().nullish(),
  recipient: z.string(),
  status: swapStatusSchema,
  createdAt: z.string(),
  createdAtTimestamp: z.number().nullish(),
  intentHashes: z.string().nullish(),
  referral: z.string().nullish(),
  amountInFormatted: z.string().nullish(),
  amountOutFormatted: z.string().nullish(),
  appFees: z.array(appFeeSchema).nullish(),
  nearTxHashes: z.array(z.string()).nullish(),
  originChainTxHashes: z.array(z.string()).nullish(),
  destinationChainTxHashes: z.array(z.string()).nullish(),
  amountIn: z.string().nullish(),
  amountInUsd: z.string().nullish(),
  amountOut: z.string().nullish(),
  amountOutUsd: z.string().nullish(),
  refundTo: z.string().nullish(),
  senders: z.array(z.string()).nullish(),
  refundReason: z.string().nullish(),
  refundFeeFormatted: z.string().nullish(),
  refundFee: z.string().nullish(),
  recipientType: recipientTypeSchema.nullish(),
  depositType: depositTypeSchema.nullish(),
  refundType: refundTypeSchema.nullish(),
});
export type Transaction = z.infer<typeof transactionSchema>;

export const transactionsResponseSchema = z.union([
  z.array(transactionSchema),
  z.object({
    data: z.array(transactionSchema),
    totalPages: z.number(),
    page: z.number(),
    perPage: z.number(),
    total: z.number(),
    nextPage: z.number().nullable(),
    prevPage: z.number().nullable(),
  }),
]);

export const incidentSchema = z.object({
  /** For example `address`, `chain` or `asset`. */
  scopeType: z.string(),
  scopeValue: z.string(),
  direction: z.string().nullish(),
  publicDescription: z.string().nullish(),
});
export type Incident = z.infer<typeof incidentSchema>;

export const incidentsResponseSchema = z.union([
  z.object({ status: z.literal("operational") }),
  z.object({ status: z.literal("incidents"), incidents: z.array(incidentSchema) }),
]);
export type IncidentsResponse = z.infer<typeof incidentsResponseSchema>;

// --- Persistent deposit addresses ---------------------------------------------------------------

/** Chain codes the persistent address API accepts; `evm` stands for every EVM chain (one shared address). */
export const persistentChainSchema = z.enum([
  "eth", "bera", "base", "gnosis", "arb", "bsc", "avax", "op", "pol", "monad", "adi", "plasma", "scroll", "xlayer",
  "sui", "aptos", "xrp", "btc", "doge", "tron", "ton", "near", "sol", "zec", "ltc", "cardano", "stellar", "aleo",
  "bch", "dash", "starknet", "coca", "qtc", "evm",
]);
export type PersistentChain = z.infer<typeof persistentChainSchema>;

export const createPersistentAddressRequestSchema = z.object({
  /** Where funds land on the destination chain (the Trendr account). */
  recipient: z.string().min(1),
  /** Trendr's id for the user; one address per (key, sender, recipient, asset, chain). */
  sender: z.string().min(1),
  depositChain: persistentChainSchema,
  destinationChain: persistentChainSchema.exclude(["evm"]),
  /** A symbol or, better, an asset id (a symbol shared by two tokens is rejected). */
  destinationAsset: z.string().min(1),
  confidential: z.boolean().optional(),
});
export type CreatePersistentAddressRequest = z.infer<typeof createPersistentAddressRequestSchema>;

export const persistentAddressResponseSchema = z.object({
  depositAddress: z.string().min(1),
  /** True when this exact address had already been requested. */
  alreadyExists: z.boolean(),
  /** Stellar only; deposits without it are not credited. */
  memo: z.string().optional(),
  correlationId: z.string().optional(),
});
export type PersistentAddressResponse = z.infer<typeof persistentAddressResponseSchema>;

export const persistentDepositSchema = z.object({
  tx_hash: z.string(),
  fromChain: z.string().nullish(),
  destinationChain: z.string().nullish(),
  asset_id: z.string().nullable(),
  decimals: z.number().nullable(),
  amount: z.string(),
  from: z.string().optional(),
  created_at: z.string(),
  intents_account: z.string(),
  deposit_address: z.string(),
  recipient: z.string(),
});
export type PersistentDeposit = z.infer<typeof persistentDepositSchema>;

export const persistentDepositsResponseSchema = z.object({ deposits: z.array(persistentDepositSchema) });

export const persistentAddressRecordSchema = z.object({
  depositAddress: z.string(),
  recipient: z.string(),
  sender: z.string(),
  depositChain: z.string().nullable(),
  destinationSymbol: z.string().nullable(),
  recipientChain: z.string().nullable(),
  memo: z.string().optional(),
  createdAt: z.string(),
  lastTimeUsed: z.string(),
});
export type PersistentAddressRecord = z.infer<typeof persistentAddressRecordSchema>;

export const persistentAddressPageSchema = z.object({
  data: z.array(persistentAddressRecordSchema),
  page: z.number(),
  perPage: z.number(),
  total: z.number(),
  totalPages: z.number(),
  nextPage: z.number().nullable(),
  prevPage: z.number().nullable(),
});
export type PersistentAddressPage = z.infer<typeof persistentAddressPageSchema>;
