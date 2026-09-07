import { isAddress } from "viem";
import { chainName, isAddressOn } from "./chains";
import { AuroraInputError } from "./errors";
import { MONAD_BLOCKCHAIN } from "./monad";
import type { AuroraToken, QuoteRequest } from "./schemas";

/**
 * Quote requests for Trendr's two cross-chain flows, with the refund policy built in:
 *
 * - Deposit: any supported asset on any chain into USDC on Monad, paid to the user's Trendr
 *   account. A refund always goes back to the user's own address on the chain they send from
 *   (refundType ORIGIN_CHAIN), never to Trendr and never to the Trendr account on another chain.
 * - Withdrawal: USDC on Monad out to any asset on any chain. A refund goes back to the Trendr
 *   account on Monad, where the user's session already controls it.
 *
 * Integrator fees are not part of the request: Aurora applies the fee configured for the API key
 * in the Client Portal and echoes it back as `quoteRequest.appFees`.
 */

export const DEFAULT_SLIPPAGE_BPS = 50;
/** Long enough to send from another wallet or an exchange; refunds begin after it. */
export const DEFAULT_DEPOSIT_WINDOW_MS = 60 * 60_000;

export type FundingSwapType = "EXACT_INPUT" | "EXACT_OUTPUT" | "FLEX_INPUT";

export interface DepositQuoteInput {
  /** What the user sends (from the Aurora token list). */
  origin: AuroraToken;
  /** What lands on Monad; USDC unless there is a reason otherwise (Kuru converts USDC to AUSD). */
  destination: AuroraToken;
  /** Raw units: of `origin` for EXACT_INPUT and FLEX_INPUT, of `destination` for EXACT_OUTPUT. */
  amount: bigint;
  /** The user's Trendr account on Monad. */
  account: string;
  /**
   * The user's own address on the origin chain: the wallet they send from. Not an exchange deposit
   * address, which may not credit a refund.
   */
  refundTo: string;
  swapType?: FundingSwapType;
  slippageBps?: number;
  /** Refunds begin after this. Default now + 1 hour. */
  deadline?: Date;
  /** True prices the deposit without creating an address. */
  dry: boolean;
  now?: () => number;
}

function checkCommon(amount: bigint, slippageBps: number) {
  if (amount <= 0n) throw new AuroraInputError("amount must be positive");
  if (!Number.isInteger(slippageBps) || slippageBps < 0 || slippageBps > 10_000) throw new AuroraInputError("slippage must be 0 to 10000 bps");
}

/** The quote request for an any-chain deposit into a Trendr account. */
export function depositQuoteRequest(input: DepositQuoteInput): QuoteRequest {
  const slippage = input.slippageBps ?? DEFAULT_SLIPPAGE_BPS;
  checkCommon(input.amount, slippage);
  if (input.destination.blockchain !== MONAD_BLOCKCHAIN) throw new AuroraInputError("deposits must land on Monad");
  if (!isAddress(input.account, { strict: false })) throw new AuroraInputError("the Trendr account must be an EVM address");
  if (!isAddressOn(input.origin.blockchain, input.refundTo)) {
    throw new AuroraInputError(`the refund address must be the sender's own ${chainName(input.origin.blockchain)} address`);
  }
  const now = input.now ?? Date.now;
  return {
    dry: input.dry,
    swapType: input.swapType ?? "EXACT_INPUT",
    depositType: "ORIGIN_CHAIN",
    originAsset: input.origin.assetId,
    destinationAsset: input.destination.assetId,
    amount: input.amount.toString(),
    slippageTolerance: slippage,
    refundTo: input.refundTo,
    refundType: "ORIGIN_CHAIN",
    recipient: input.account,
    recipientType: "DESTINATION_CHAIN",
    deadline: (input.deadline ?? new Date(now() + DEFAULT_DEPOSIT_WINDOW_MS)).toISOString(),
  };
}

export interface WithdrawalQuoteInput {
  /** What leaves the Trendr account on Monad (USDC after converting AUSD on Kuru). */
  origin: AuroraToken;
  destination: AuroraToken;
  amount: bigint;
  /** The Trendr account: it sends the deposit and takes any refund. */
  account: string;
  /** Where the user wants the funds, on the destination chain. */
  recipient: string;
  swapType?: FundingSwapType;
  slippageBps?: number;
  deadline?: Date;
  dry: boolean;
  now?: () => number;
}

/** The quote request for withdrawing from a Trendr account to any chain; refunds return to the account. */
export function withdrawalQuoteRequest(input: WithdrawalQuoteInput): QuoteRequest {
  const slippage = input.slippageBps ?? DEFAULT_SLIPPAGE_BPS;
  checkCommon(input.amount, slippage);
  if (input.origin.blockchain !== MONAD_BLOCKCHAIN) throw new AuroraInputError("withdrawals start on Monad");
  if (!isAddress(input.account, { strict: false })) throw new AuroraInputError("the Trendr account must be an EVM address");
  if (!isAddressOn(input.destination.blockchain, input.recipient)) {
    throw new AuroraInputError(`the recipient is not a ${chainName(input.destination.blockchain)} address`);
  }
  const now = input.now ?? Date.now;
  return {
    dry: input.dry,
    swapType: input.swapType ?? "EXACT_INPUT",
    depositType: "ORIGIN_CHAIN",
    originAsset: input.origin.assetId,
    destinationAsset: input.destination.assetId,
    amount: input.amount.toString(),
    slippageTolerance: slippage,
    refundTo: input.account,
    refundType: "ORIGIN_CHAIN",
    recipient: input.recipient,
    recipientType: "DESTINATION_CHAIN",
    // The account sends at once, so a short window is enough.
    deadline: (input.deadline ?? new Date(now() + 15 * 60_000)).toISOString(),
  };
}
