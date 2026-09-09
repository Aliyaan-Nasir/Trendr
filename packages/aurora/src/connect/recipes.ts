import { type Address, type Hex, isAddress, parseAbiItem } from "viem";
import { CURVE_AUSD_POOL, curvePoolAbi } from "../curve";
import { KURU_AUSD_USDC, KURU_MAINNET, kuruRouterAbi } from "../kuru";
import { AUSD_MAINNET, MONAD_ASSETS } from "../monad";
import { type Amount, amountParam, approveStep, callStep, ConnectStepError, type EvmStep, MIN_AMOUNT_OUT, transferStep } from "./steps";

/**
 * Trendr's Intents Connect recipes for Monad: what the user's intermediary account does once the
 * bridged USDC arrives. Each recipe ends with the result in the user's Trendr account, never in the
 * intermediary: AUSD paid to it, an outcome complete set minted to it, or a perp position opened
 * for it (AttentionPerp.openFor).
 *
 * The USDC to AUSD swap runs on a venue the caller chooses:
 * - `CURVE_AUSD_VENUE`, the AUSD/USDC/USDT0 stable pool, which pays its output to any receiver,
 *   so AUSD goes straight to the account (no remainder left in the intermediary);
 * - `KURU_CLOB_VENUE`, Kuru's AUSD/USDC book through Router.anyToAnySwap, which pays the caller,
 *   so the account receives the swap's guaranteed minimum and any surplus stays in the
 *   intermediary (recover it with `sweepSteps`). Soft-paused on 2026-10-09.
 *
 * The AUSD recipes need literal amounts (the three-round plan in plan.ts sizes them); only
 * `fundUsdcSteps` uses the service's {MIN_AMOUNT_OUT} placeholder.
 */

export type AusdVenue =
  | { kind: "curve"; pool: Address; usdcIndex: number; ausdIndex: number }
  | { kind: "kuru"; router: Address; market: Address };

export const CURVE_AUSD_VENUE: AusdVenue = {
  kind: "curve",
  pool: CURVE_AUSD_POOL.address,
  usdcIndex: CURVE_AUSD_POOL.index.USDC,
  ausdIndex: CURVE_AUSD_POOL.index.AUSD,
};

/** Kuru AUSD/USDC (base AUSD, quote USDC): buying AUSD is isBuy = true. */
export const KURU_CLOB_VENUE: AusdVenue = { kind: "kuru", router: KURU_MAINNET.router, market: KURU_AUSD_USDC.address };

export interface MonadConnectConfig {
  usdc: Address;
  ausd: Address;
  venue: AusdVenue;
}

/** Monad Mainnet with the stable pool, the venue that could fill a swap on 2026-10-09. */
export const MONAD_MAINNET_CONNECT: MonadConnectConfig = {
  usdc: MONAD_ASSETS.USDC.address!,
  ausd: AUSD_MAINNET.address,
  venue: CURVE_AUSD_VENUE,
};

const anyToAnySwapFn = kuruRouterAbi.find((x) => x.type === "function" && x.name === "anyToAnySwap")!;
const curveExchangeFn = curvePoolAbi.find((x) => x.type === "function" && x.name === "exchange")!;
/** OutcomeMarkets.mint: `amount` collateral in, `amount` UP and DOWN to `to`. */
export const outcomeMintFn = parseAbiItem("function mint(bytes32 seriesId, uint256 amount, address to)");
/** AttentionPerp.openFor: a position owned by `owner`, paid by the caller. */
export const perpOpenForFn = parseAbiItem(
  "function openFor(address owner, bytes32 trendId, bool isLong, uint256 margin, uint256 leverage, uint64 acceptableIndex, uint256 deadline) returns (uint256 id)",
);

function evm(address: string, what: string): Address {
  if (!isAddress(address, { strict: false })) throw new ConnectStepError("BAD_PARAMETERS", `${what} must be an EVM address`);
  return address;
}

function positive(amount: bigint, what: string) {
  if (amount <= 0n) throw new ConnectStepError("BAD_PARAMETERS", `${what} must be positive`);
}

/**
 * Approve exactly `usdcIn` to the venue and swap it for at least `minAusdOut` AUSD, which ends up
 * at `receiver` (on Kuru, by a transfer of the minimum when the receiver is not the intermediary).
 */
export function swapUsdcToAusdSteps(
  cfg: MonadConnectConfig,
  input: { usdcIn: Amount; minAusdOut: bigint; receiver: Address | "intermediary" },
): EvmStep[] {
  if (typeof input.usdcIn === "bigint") positive(input.usdcIn, "usdcIn");
  positive(input.minAusdOut, "minAusdOut");
  const v = cfg.venue;
  if (v.kind === "curve") {
    if (input.receiver === "intermediary") throw new ConnectStepError("BAD_PARAMETERS", "the curve venue needs the intermediary's address as receiver");
    return [
      approveStep(cfg.usdc, v.pool, input.usdcIn),
      callStep(v.pool, curveExchangeFn, [String(v.usdcIndex), String(v.ausdIndex), amountParam(input.usdcIn), input.minAusdOut.toString(), evm(input.receiver, "receiver")]),
    ];
  }
  const steps = [
    approveStep(cfg.usdc, v.router, input.usdcIn),
    callStep(v.router, anyToAnySwapFn, [[v.market], [true], [false], cfg.usdc, cfg.ausd, amountParam(input.usdcIn), input.minAusdOut.toString()]),
  ];
  if (input.receiver !== "intermediary") steps.push(transferStep(cfg.ausd, evm(input.receiver, "receiver"), input.minAusdOut));
  return steps;
}

export interface DepositAusdInput {
  usdcIn: bigint;
  /** The least AUSD the swap may return: a venue quote less slippage. */
  minAusdOut: bigint;
  account: string;
}

/** Bridged USDC to AUSD, paid to the Trendr account. */
export function depositAusdSteps(cfg: MonadConnectConfig, input: DepositAusdInput): EvmStep[] {
  return swapUsdcToAusdSteps(cfg, { usdcIn: input.usdcIn, minAusdOut: input.minAusdOut, receiver: evm(input.account, "Trendr account") });
}

/** The intermediary must hold the AUSD that a mint or openFor pulls; Kuru pays it there anyway. */
function swapToIntermediary(cfg: MonadConnectConfig, input: DepositAusdInput & { intermediary: string }): EvmStep[] {
  const receiver = cfg.venue.kind === "curve" ? evm(input.intermediary, "intermediary") : "intermediary";
  return swapUsdcToAusdSteps(cfg, { usdcIn: input.usdcIn, minAusdOut: input.minAusdOut, receiver });
}

export interface MintOutcomeSetInput extends DepositAusdInput {
  /** The user's intermediary on Monad (from the plan or GET .../intermediary). */
  intermediary: string;
  outcomeMarkets: Address;
  seriesId: Hex;
}

/** Bridged USDC to AUSD, then `minAusdOut` complete sets (UP and DOWN) minted to the Trendr account. */
export function mintOutcomeSetSteps(cfg: MonadConnectConfig, input: MintOutcomeSetInput): EvmStep[] {
  const markets = evm(input.outcomeMarkets, "OutcomeMarkets");
  return [
    ...swapToIntermediary(cfg, input),
    approveStep(cfg.ausd, markets, input.minAusdOut),
    callStep(markets, outcomeMintFn, [input.seriesId, input.minAusdOut.toString(), evm(input.account, "Trendr account")]),
  ];
}

export interface OpenPerpInput extends DepositAusdInput {
  intermediary: string;
  attentionPerp: Address;
  trendId: Hex;
  isLong: boolean;
  /** Notional over net margin, 1e18-scaled, at most 3e18. */
  leverage: bigint;
  /** Highest entry for a long, lowest for a short (index units). */
  acceptableIndex: bigint;
  /** Unix seconds; the bridge takes time, so leave room (several minutes). */
  deadline: bigint;
}

/** Bridged USDC to AUSD, then a perp position opened for the Trendr account with `minAusdOut` margin. */
export function openPerpSteps(cfg: MonadConnectConfig, input: OpenPerpInput): EvmStep[] {
  const perp = evm(input.attentionPerp, "AttentionPerp");
  return [
    ...swapToIntermediary(cfg, input),
    approveStep(cfg.ausd, perp, input.minAusdOut),
    callStep(perp, perpOpenForFn, [
      evm(input.account, "Trendr account"),
      input.trendId,
      input.isLong,
      input.minAusdOut.toString(),
      input.leverage.toString(),
      input.acceptableIndex.toString(),
      input.deadline.toString(),
    ]),
  ];
}

/**
 * The single-round recipe: the guaranteed USDC (after the service's fee) goes straight to the
 * Trendr account, whose session converts it to AUSD. Use it when no venue can absorb the amount,
 * or when the exact figure need not be known before signing.
 */
export function fundUsdcSteps(cfg: MonadConnectConfig, input: { account: string }): EvmStep[] {
  return [transferStep(cfg.usdc, evm(input.account, "Trendr account"), MIN_AMOUNT_OUT)];
}

/**
 * A steps-only execution that moves what is left in the intermediary to the Trendr account: swap
 * surplus AUSD, delivery above the minimum, or the USDC of an execution whose swap reverted. The
 * service takes its fee in USDC from the intermediary, so `usdc` must leave room for it (plan with
 * a dry run first). Read the balances on chain; this only builds the calls.
 */
export function sweepSteps(cfg: MonadConnectConfig, input: { account: string; usdc: bigint; ausd: bigint }): EvmStep[] {
  const to = evm(input.account, "Trendr account");
  // The USDC step comes first and always exists: it satisfies the destination-token rule.
  const steps = [transferStep(cfg.usdc, to, input.usdc)];
  if (input.ausd > 0n) steps.push(transferStep(cfg.ausd, to, input.ausd));
  return steps;
}
