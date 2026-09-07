import { formatUnits } from "viem";
import { chainName } from "./chains";
import { DEFAULT_STATUS_POLL_MS } from "./client";
import type { AuroraToken, QuoteResponse, StatusResponse, SwapStatus } from "./schemas";

/**
 * One deposit's lifecycle, from a quote to USDC in the Trendr account or a refund to the sender.
 *
 *   quoted -> awaiting_deposit -> deposit_detected -> processing -> succeeded
 *                    |                  |                 \-> refunded | failed
 *                    |                  \-> incomplete_deposit -> processing | refunded
 *                    \-> expired (deadline passed, nothing sent) -> deposit_detected (late deposit)
 *
 * The state is plain JSON (amounts are raw-unit strings) so the backend can store it per deposit
 * and resume after a restart. Updates are monotonic: a stale or out-of-order status never moves a
 * deposit backwards, and once it has succeeded or been refunded it never changes again. FAILED is
 * final for polling but may still be refined to REFUNDED or SUCCESS if Aurora later reports it.
 */

export type DepositPhase =
  | "quoted"
  | "awaiting_deposit"
  | "deposit_detected"
  | "incomplete_deposit"
  | "processing"
  | "succeeded"
  | "refunded"
  | "failed"
  | "expired";

export interface DepositAsset {
  assetId: string;
  symbol: string;
  blockchain: string;
  decimals: number;
}

export interface DepositSuccess {
  kind: "success";
  /** Settled amount delivered on Monad, raw units of the destination asset. */
  amountOut: string;
  amountOutFormatted?: string;
  /** The delivery transaction(s) on Monad. */
  monadTxHashes: string[];
  explorerUrls: string[];
}

export interface DepositRefund {
  kind: "refund";
  /** Raw units of the origin asset sent back. */
  refundedAmount: string;
  refundedAmountFormatted?: string;
  refundReason?: string;
  /** Where the refund went: the sender's own address on the origin chain. */
  refundTo: string;
  /** Origin-chain transactions that are not the deposit. Empty when Aurora has not reported one. */
  refundTxHashes: string[];
  explorerUrls: string[];
}

export interface DepositFailure {
  kind: "failure";
}

export type DepositOutcome = DepositSuccess | DepositRefund | DepositFailure;

export interface DepositState {
  phase: DepositPhase;
  origin: DepositAsset;
  destination: DepositAsset;
  swapType: string;
  /** Absent for a dry quote. */
  depositAddress?: string;
  depositMemo?: string;
  amountIn: string;
  amountInFormatted: string;
  minAmountIn: string;
  maxAmountIn?: string;
  amountOut: string;
  amountOutFormatted: string;
  minAmountOut: string;
  recipient: string;
  refundTo: string;
  refundFee?: string;
  /** When refunds begin if nothing completed (live quotes). */
  deadline?: string;
  /** When the deposit address stops accepting deposits (live quotes). */
  timeWhenInactive?: string;
  timeEstimateSeconds: number;
  auroraStatus?: SwapStatus;
  updatedAt?: string;
  /** Deposit transactions on the origin chain, from the app or from Aurora. */
  depositTxHashes: string[];
  /** Every origin-chain transaction Aurora reported, deposits and refunds. Kept for support cases. */
  originTxHashes: string[];
  depositedAmount?: string;
  depositedAmountFormatted?: string;
  outcome?: DepositOutcome;
  history: { at: string; phase: DepositPhase; auroraStatus?: SwapStatus }[];
}

const RANK: Record<DepositPhase, number> = {
  quoted: 0,
  awaiting_deposit: 1,
  expired: 1,
  deposit_detected: 2,
  incomplete_deposit: 3,
  processing: 4,
  failed: 5,
  succeeded: 6,
  refunded: 6,
};

const PHASE_OF: Record<SwapStatus, DepositPhase> = {
  PENDING_DEPOSIT: "awaiting_deposit",
  KNOWN_DEPOSIT_TX: "deposit_detected",
  INCOMPLETE_DEPOSIT: "incomplete_deposit",
  PROCESSING: "processing",
  SUCCESS: "succeeded",
  REFUNDED: "refunded",
  FAILED: "failed",
};

const asset = (t: AuroraToken): DepositAsset => ({ assetId: t.assetId, symbol: t.symbol, blockchain: t.blockchain, decimals: t.decimals });
const iso = (ms: number) => new Date(ms).toISOString();
const unique = (xs: string[]) => [...new Set(xs)];

function move(state: DepositState, phase: DepositPhase, at: number, auroraStatus?: SwapStatus): DepositState {
  if (phase === state.phase) return state;
  return { ...state, phase, history: [...state.history, { at: iso(at), phase, ...(auroraStatus ? { auroraStatus } : {}) }] };
}

/** A deposit from a quote. A live quote (with a deposit address) starts in awaiting_deposit. */
export function depositFromQuote(quote: QuoteResponse, tokens: { origin: AuroraToken; destination: AuroraToken }, now = Date.now()): DepositState {
  const q = quote.quote;
  const r = quote.quoteRequest;
  if (tokens.origin.assetId !== r.originAsset || tokens.destination.assetId !== r.destinationAsset) {
    throw new Error("the tokens do not match the quote's assets");
  }
  const phase: DepositPhase = q.depositAddress ? "awaiting_deposit" : "quoted";
  return {
    phase,
    origin: asset(tokens.origin),
    destination: asset(tokens.destination),
    swapType: r.swapType,
    ...(q.depositAddress ? { depositAddress: q.depositAddress } : {}),
    ...(q.depositMemo ? { depositMemo: q.depositMemo } : {}),
    amountIn: q.amountIn,
    amountInFormatted: q.amountInFormatted,
    minAmountIn: q.minAmountIn,
    ...(q.maxAmountIn ? { maxAmountIn: q.maxAmountIn } : {}),
    amountOut: q.amountOut,
    amountOutFormatted: q.amountOutFormatted,
    minAmountOut: q.minAmountOut,
    recipient: r.recipient,
    refundTo: r.refundTo,
    ...(q.refundFee ? { refundFee: q.refundFee } : {}),
    ...(q.deadline ? { deadline: q.deadline } : {}),
    ...(q.timeWhenInactive ? { timeWhenInactive: q.timeWhenInactive } : {}),
    timeEstimateSeconds: q.timeEstimate,
    depositTxHashes: [],
    originTxHashes: [],
    history: [{ at: iso(now), phase }],
  };
}

/** The app sent (or the user pasted) the deposit transaction. */
export function withDepositTx(state: DepositState, txHash: string, now = Date.now()): DepositState {
  const next = { ...state, depositTxHashes: unique([...state.depositTxHashes, txHash]) };
  return state.phase === "awaiting_deposit" || state.phase === "expired" ? move(next, "deposit_detected", now) : next;
}

/** Marks an unfunded live quote expired once its deadline has passed. */
export function withClock(state: DepositState, now = Date.now()): DepositState {
  if (state.phase !== "awaiting_deposit" || !state.deadline) return state;
  return now >= Date.parse(state.deadline) ? move(state, "expired", now) : state;
}

/** Applies a status from GET /api/status (or the submit-deposit response). */
export function withStatus(state: DepositState, status: StatusResponse, now = Date.now()): DepositState {
  if (state.phase === "succeeded" || state.phase === "refunded") return state;
  const target = PHASE_OF[status.status];
  let next: DepositState = { ...state, auroraStatus: status.status };

  if ("swapDetails" in status) {
    const d = status.swapDetails;
    const origin = d.originChainTxHashes.map((t) => t.hash);
    next = {
      ...next,
      updatedAt: status.updatedAt,
      originTxHashes: unique([...state.originTxHashes, ...origin]),
      // Before a refund, every origin-chain transaction Aurora reports is a deposit.
      depositTxHashes: status.status === "REFUNDED" ? state.depositTxHashes : unique([...state.depositTxHashes, ...origin]),
      ...(d.depositedAmount ? { depositedAmount: d.depositedAmount } : {}),
      ...(d.depositedAmountFormatted ? { depositedAmountFormatted: d.depositedAmountFormatted } : {}),
    };
    if (status.status === "SUCCESS") {
      next.outcome = {
        kind: "success",
        amountOut: d.amountOut ?? state.amountOut,
        ...(d.amountOutFormatted ? { amountOutFormatted: d.amountOutFormatted } : {}),
        monadTxHashes: d.destinationChainTxHashes.map((t) => t.hash),
        explorerUrls: d.destinationChainTxHashes.map((t) => t.explorerUrl),
      };
    } else if (status.status === "REFUNDED") {
      let deposits = next.depositTxHashes;
      // Refunded before any deposit was seen: the first origin transaction is the deposit.
      if (deposits.length === 0 && origin.length > 0) deposits = [origin[0]!];
      const refunds = d.originChainTxHashes.filter((t) => !deposits.includes(t.hash));
      next.depositTxHashes = deposits;
      next.outcome = {
        kind: "refund",
        refundedAmount: d.refundedAmount ?? "0",
        ...(d.refundedAmountFormatted ? { refundedAmountFormatted: d.refundedAmountFormatted } : {}),
        ...(d.refundReason ? { refundReason: d.refundReason } : {}),
        refundTo: state.refundTo,
        refundTxHashes: refunds.map((t) => t.hash),
        explorerUrls: refunds.map((t) => t.explorerUrl),
      };
    }
  } else if (status.status === "SUCCESS" || status.status === "REFUNDED") {
    // Confidential swaps expose no details; the outcome is known only by kind.
    next.outcome =
      status.status === "SUCCESS"
        ? { kind: "success", amountOut: state.amountOut, monadTxHashes: [], explorerUrls: [] }
        : { kind: "refund", refundedAmount: "0", refundTo: state.refundTo, refundTxHashes: [], explorerUrls: [] };
  }
  if (status.status === "FAILED") next.outcome = { kind: "failure" };

  // A swap Aurora still reports as PENDING_DEPOSIT keeps an expired quote expired.
  if (state.phase === "expired" && target === "awaiting_deposit") return next;
  if (RANK[target] < RANK[state.phase]) return next;
  return move(next, target, now, status.status);
}

/** Succeeded or refunded: the funds are accounted for and the deposit never changes again. */
export function isSettled(state: DepositState): boolean {
  return state.phase === "succeeded" || state.phase === "refunded";
}

/**
 * How long to wait before the next status poll, or null to stop. Active deposits poll at Aurora's
 * recommended cadence; an expired quote is watched slowly until its address goes inactive, so a
 * late deposit (which Aurora refunds) is still tracked.
 */
export function nextPollMs(state: DepositState, now = Date.now()): number | null {
  switch (state.phase) {
    case "awaiting_deposit":
    case "deposit_detected":
    case "incomplete_deposit":
    case "processing":
      return DEFAULT_STATUS_POLL_MS;
    case "expired":
      return state.timeWhenInactive && now < Date.parse(state.timeWhenInactive) ? 60_000 : null;
    default:
      return null;
  }
}

// --- What the app tells the user ----------------------------------------------------------------

export type DepositAction = "review" | "send" | "wait" | "top_up" | "none" | "contact_support" | "new_quote";

export interface DepositMessage {
  title: string;
  body: string;
  /** Shown directly under the deposit address and QR code, never elsewhere. */
  requirements: string[];
  action: DepositAction;
  /** Explorer links for the outcome. */
  links: string[];
  /** For a support case: Aurora asks for the deposit address and transaction hashes. */
  support?: { depositAddress?: string; txHashes: string[] };
}

export interface DescribeOptions {
  /** Formats an ISO time for display. Default "2026-10-09 19:45 UTC". */
  formatTime?: (iso: string) => string;
}

const defaultTime = (s: string) => `${new Date(s).toISOString().slice(0, 16).replace("T", " ")} UTC`;

export function formatEta(seconds: number): string {
  if (seconds < 90) return `about ${Math.max(1, Math.round(seconds / 10) * 10)} seconds`;
  return `about ${Math.round(seconds / 60)} minutes`;
}

const amount = (raw: string, decimals: number) => formatUnits(BigInt(raw), decimals);

/**
 * The transfer requirements for a one-time deposit address, per Aurora's UX recommendations: name
 * the one asset and network, the amount rule, the memo if any, and the consequence of sending
 * anything else. Data-driven from the quote, never a generic string.
 */
export function transferRequirements(state: DepositState, options: DescribeOptions = {}): string[] {
  const time = options.formatTime ?? defaultTime;
  const sym = state.origin.symbol;
  const chain = chainName(state.origin.blockchain);
  const lines = [`1 asset supported: send only ${sym} from ${chain} to this address.`];
  const minIn = amount(state.minAmountIn, state.origin.decimals);
  if (state.swapType === "EXACT_INPUT") lines.push(`Send exactly ${state.amountInFormatted} ${sym}. Less is refunded; more is swapped and the excess refunded.`);
  else if (state.swapType === "FLEX_INPUT") lines.push(`Send at least ${minIn} ${sym}.`);
  else lines.push(`Send ${state.amountInFormatted} ${sym} (at least ${minIn} ${sym}).`);
  if (state.depositMemo) lines.push(`Include the memo ${state.depositMemo}, or the deposit is not credited.`);
  if (state.deadline) lines.push(`Send before ${time(state.deadline)}.`);
  lines.push(`Sending another asset or using another network may result in permanent loss of funds.`);
  lines.push(`If the deposit cannot complete, it is refunded to ${state.refundTo} on ${chain}.`);
  return lines;
}

/** Short, plain copy for each phase. */
export function describeDeposit(state: DepositState, options: DescribeOptions = {}): DepositMessage {
  const time = options.formatTime ?? defaultTime;
  const sym = state.origin.symbol;
  const chain = chainName(state.origin.blockchain);
  const out = `${state.amountOutFormatted} ${state.destination.symbol}`;
  const eta = formatEta(state.timeEstimateSeconds);
  const base = { requirements: [] as string[], links: [] as string[] };
  switch (state.phase) {
    case "quoted":
      return {
        ...base,
        title: "Review your deposit",
        body: `Send ${state.amountInFormatted} ${sym} on ${chain}. About ${out} arrives on Monad ${eta} after it lands.`,
        action: "review",
      };
    case "awaiting_deposit":
      return {
        ...base,
        title: `Send ${state.amountInFormatted} ${sym} on ${chain}`,
        body: `It arrives as ${state.destination.symbol} in your Trendr account ${eta} after it lands.`,
        requirements: transferRequirements(state, options),
        action: "send",
      };
    case "deposit_detected":
      return { ...base, title: `Deposit seen on ${chain}`, body: `Waiting for ${chain} to confirm it.`, action: "wait" };
    case "incomplete_deposit": {
      const got = state.depositedAmountFormatted ?? (state.depositedAmount ? amount(state.depositedAmount, state.origin.decimals) : "less");
      const needed = amount(state.minAmountIn, state.origin.decimals);
      return {
        ...base,
        title: "Deposit is short",
        body:
          `Received ${got} ${sym}, but at least ${needed} ${sym} is needed. ` +
          `Send the rest to the same address${state.deadline ? ` before ${time(state.deadline)}` : ""}, or it is refunded to ${state.refundTo} on ${chain}.`,
        requirements: transferRequirements(state, options),
        action: "top_up",
      };
    }
    case "processing":
      return { ...base, title: "Deposit received", body: `Converting to ${state.destination.symbol} on Monad. About ${out}, ${eta}.`, action: "wait" };
    case "succeeded": {
      const o = state.outcome?.kind === "success" ? state.outcome : undefined;
      const got = o?.amountOutFormatted ?? (o ? amount(o.amountOut, state.destination.decimals) : state.amountOutFormatted);
      return {
        ...base,
        title: "Deposit complete",
        body: `${got} ${state.destination.symbol} arrived in your Trendr account.`,
        action: "none",
        links: o?.explorerUrls ?? [],
      };
    }
    case "refunded": {
      const o = state.outcome?.kind === "refund" ? state.outcome : undefined;
      const back = o?.refundedAmountFormatted ?? (o ? amount(o.refundedAmount, state.origin.decimals) : state.amountInFormatted);
      return {
        ...base,
        title: "Deposit refunded",
        body: `${back} ${sym} was sent back to ${state.refundTo} on ${chain}.${o?.refundReason ? ` Reason: ${o.refundReason}.` : ""}`,
        action: "none",
        links: o?.explorerUrls ?? [],
      };
    }
    case "failed":
      return {
        ...base,
        title: "Deposit needs attention",
        body: "This deposit could not be completed. Contact support with the deposit address and your transaction hash so it can be traced.",
        action: "contact_support",
        support: { ...(state.depositAddress ? { depositAddress: state.depositAddress } : {}), txHashes: state.originTxHashes.length ? state.originTxHashes : state.depositTxHashes },
      };
    case "expired":
      return { ...base, title: "Quote expired", body: "Do not send funds to this address. Get a new quote to deposit.", action: "new_quote" };
  }
}
