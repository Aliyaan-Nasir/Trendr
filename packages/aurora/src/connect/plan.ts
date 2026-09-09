import { type Address, isAddress } from "viem";
import { AuroraError } from "../errors";
import type { ConnectQuote, CreateExecutionBody, IntentsConnectClient } from "./client";
import type { EvmStepResponse, Execution, SigningStandard } from "./schemas";
import { type CheckedPayload, checkIntentPayload } from "./signing";
import { type EvmStep, validateSteps } from "./steps";

/**
 * Sizing a bridge-in so the user sees the exact amount the steps spend before signing (the API's
 * "three rounds", which the SDK calls the threeRound fee strategy):
 *
 * 1. Dry create with no steps: the guaranteed delivery (`minAmountOut`) before the step gas fee.
 * 2. Dry create with steps built at that amount: the service simulates them, measures
 *    `networkFee` and returns `minAmountOut` with the fee already carved out.
 * 3. Steps rebuilt at round 2's `minAmountOut` (less a small reserve) go into the live create.
 *
 * Rounds 1 and 2 create nothing. Round 3 is the caller's: send `plan.request` with
 * `createExecution`, then check the result with `checkCreatedExecution` before asking the user to
 * sign, because the quote can move between round 2 and the create.
 */

export const DEFAULT_RESERVE_BPS = 10;

export type PlanErrorCode = "MISSING_FIELD" | "NO_FEE_ESTIMATE" | "FEE_EXCEEDS_AMOUNT" | "QUOTE_MOVED" | "STEPS_CHANGED" | "UNEXPECTED_SIGNING";

export class ConnectPlanError extends AuroraError {
  override name = "ConnectPlanError";
  constructor(
    readonly code: PlanErrorCode,
    message: string,
  ) {
    super(message);
  }
}

export interface BridgeInPlanInput {
  /** The origin wallet that signs (EVM address, Solana key, NEAR account...). */
  wallet: string;
  quote: Omit<ConnectQuote, "recipient">;
  /** The ERC-20 delivered on the destination chain (Monad USDC); the service's fee is paid in it. */
  destinationToken: Address;
  /** Builds the steps for a spendable amount of the destination token. Called twice. */
  build: (ctx: { spendable: bigint; intermediary: Address }) => EvmStep[] | Promise<EvmStep[]>;
  /** Kept back from round 2's minimum in case the quote moves before the live create. Default 10 bps. */
  reserveBps?: number;
  metadata?: Record<string, unknown>;
  signal?: AbortSignal;
}

export interface BridgeInPlan {
  wallet: string;
  intermediary: Address;
  destinationToken: Address;
  /** Round 1: guaranteed delivery before the step gas fee. */
  grossMinAmountOut: bigint;
  /** Round 2: the service's gas reimbursement, in raw destination-token units. */
  networkFee: bigint;
  /** Round 2: guaranteed delivery after the fee. */
  minAmountOut: bigint;
  /** What the steps spend: minAmountOut less the reserve. */
  spendable: bigint;
  estimatedSeconds?: number;
  steps: EvmStep[];
  /** The live create body, ready for createExecution. */
  request: CreateExecutionBody;
  /** The round 2 dry run, including the fee step the service appends. */
  preview: Execution;
}

function big(value: string | null | undefined, what: string): bigint {
  if (value == null || !/^\d+$/.test(value)) throw new ConnectPlanError("MISSING_FIELD", `the execution has no ${what}`);
  return BigInt(value);
}

export async function planBridgeIn(client: IntentsConnectClient, input: BridgeInPlanInput): Promise<BridgeInPlan> {
  const reserve = input.reserveBps ?? DEFAULT_RESERVE_BPS;
  if (!Number.isInteger(reserve) || reserve < 0 || reserve >= 10_000) throw new ConnectPlanError("MISSING_FIELD", "reserveBps must be 0 to 9999");
  const body = (steps: EvmStep[], dry: boolean): CreateExecutionBody => ({
    version: "1.0",
    type: "evm",
    quote: { ...input.quote },
    steps,
    ...(input.metadata ? { metadata: input.metadata } : {}),
    dry,
  });
  const check = (steps: EvmStep[]) => validateSteps(steps, { flow: "bridge-in", destinationToken: input.destinationToken });

  const round1 = await client.createExecution(input.wallet, body([], true), input.signal);
  const grossMinAmountOut = big(round1.quote?.minAmountOut, "minAmountOut");
  const intermediary = round1.details?.intermediaryAddress ?? (await client.intermediary(input.wallet, input.signal)).evm;
  if (!isAddress(intermediary, { strict: false })) throw new ConnectPlanError("MISSING_FIELD", "no EVM intermediary for this wallet");

  const steps2 = await input.build({ spendable: grossMinAmountOut, intermediary });
  check(steps2);
  const round2 = await client.createExecution(input.wallet, body(steps2, true), input.signal);
  if (!round2.details?.networkFee) throw new ConnectPlanError("NO_FEE_ESTIMATE", "gas estimation failed (no networkFee); retry the round instead of signing");
  const networkFee = big(round2.details.networkFee, "networkFee");
  const minAmountOut = big(round2.quote?.minAmountOut, "minAmountOut");
  const spendable = (minAmountOut * BigInt(10_000 - reserve)) / 10_000n;
  if (spendable <= 0n) throw new ConnectPlanError("FEE_EXCEEDS_AMOUNT", "the network fee takes the whole amount; send more");

  const steps = await input.build({ spendable, intermediary });
  check(steps);
  const estimated = Number(round2.details.estimatedTime);
  return {
    wallet: input.wallet,
    intermediary,
    destinationToken: input.destinationToken,
    grossMinAmountOut,
    networkFee,
    minAmountOut,
    spendable,
    ...(Number.isFinite(estimated) ? { estimatedSeconds: estimated } : {}),
    steps,
    request: body(steps, false),
    preview: round2,
  };
}

const same = (a: EvmStep | EvmStepResponse, b: EvmStep | EvmStepResponse) =>
  a.to.toLowerCase() === b.to.toLowerCase() &&
  a.functionSignature === b.functionSignature &&
  JSON.stringify(a.parameters) === JSON.stringify(b.parameters) &&
  (a.value ?? "0") === (b.value ?? "0");

export interface CreatedExecution {
  executionId: string;
  depositAddress: string;
  depositMemo?: string;
  /** What the user deposits: `quote.amount` for EXACT_INPUT, `quote.amountIn` for EXACT_OUTPUT. */
  depositAmount: string;
  /** The exact string the origin wallet signs (erc191: personal_sign over it, verbatim). */
  payloadJson: string;
  payloadBase64?: string;
  signingStandard: SigningStandard;
  feeStep: EvmStepResponse;
  /** For erc191: the parsed payload (signer, deadline, the chain-signature digests it authorizes). */
  authorized?: CheckedPayload;
}

export interface CheckCreatedOptions {
  /** The origin wallet's standard. Default erc191 (EVM wallets and Trendr accounts). */
  signingStandard?: SigningStandard;
  now?: number;
  /** Chain-signature contracts the payload may call; unchecked when omitted. */
  allowedContracts?: readonly string[];
}

/**
 * Checks a live create before the user signs: the quote still covers what the steps spend, the
 * service echoed our steps unchanged plus exactly one fee transfer in the destination token, and
 * the payload is in the wallet's signing standard and, for erc191, is for this wallet and unexpired.
 */
export function checkCreatedExecution(created: Execution, plan: BridgeInPlan, options: CheckCreatedOptions = {}): CreatedExecution {
  const expected = options.signingStandard ?? "erc191";
  if (!created.id) throw new ConnectPlanError("MISSING_FIELD", "the execution has no id");
  const depositAddress = created.quote?.depositAddress;
  if (!depositAddress) throw new ConnectPlanError("MISSING_FIELD", "the execution has no deposit address");
  const minAmountOut = big(created.quote?.minAmountOut, "minAmountOut");
  if (minAmountOut < plan.spendable) {
    throw new ConnectPlanError("QUOTE_MOVED", `the quote now guarantees ${minAmountOut}, less than the ${plan.spendable} the steps spend; plan again`);
  }
  const echoed = (created.steps ?? []) as EvmStepResponse[];
  if (echoed.length !== plan.steps.length + 1 || !plan.steps.every((s, i) => same(s, echoed[i]!))) {
    throw new ConnectPlanError("STEPS_CHANGED", "the service did not echo the planned steps");
  }
  const feeStep = echoed[echoed.length - 1]!;
  const fee = created.details?.networkFee;
  if (
    feeStep.to.toLowerCase() !== plan.destinationToken.toLowerCase() ||
    feeStep.functionSignature !== "transfer(address,uint256)" ||
    feeStep.parameters[1] !== fee
  ) {
    throw new ConnectPlanError("STEPS_CHANGED", "the appended step is not the documented fee transfer");
  }
  const payload = created.details?.payload;
  const standard = created.details?.signingStandard ?? payload?.standard;
  if (standard !== expected || !payload?.payload_json) {
    throw new ConnectPlanError("UNEXPECTED_SIGNING", `expected a ${expected} payload, got ${standard ?? "none"}`);
  }
  const authorized =
    standard === "erc191"
      ? checkIntentPayload(payload.payload_json, {
          wallet: plan.wallet,
          ...(options.now !== undefined ? { now: options.now } : {}),
          ...(options.allowedContracts ? { allowedContracts: options.allowedContracts } : {}),
        })
      : undefined;
  const swapType = created.quote?.swapType ?? plan.request.quote.swapType;
  const depositAmount = swapType === "EXACT_OUTPUT" ? big(created.quote?.amountIn, "amountIn") : big(created.quote?.amount ?? plan.request.quote.amount, "amount");
  return {
    executionId: created.id,
    depositAddress,
    ...(created.quote?.depositMemo ? { depositMemo: created.quote.depositMemo } : {}),
    depositAmount: depositAmount.toString(),
    payloadJson: payload.payload_json,
    ...(payload.payload_bytes_base64 ? { payloadBase64: payload.payload_bytes_base64 } : {}),
    signingStandard: standard,
    feeStep,
    ...(authorized ? { authorized } : {}),
  };
}
