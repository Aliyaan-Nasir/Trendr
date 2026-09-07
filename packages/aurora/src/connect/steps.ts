import { type AbiFunction, type AbiParameter, type Address, encodeFunctionData, type Hex, isAddress, parseAbiItem, toFunctionSignature } from "viem";
import { AuroraInputError } from "../errors";
import type { StepParameter } from "./schemas";

/**
 * Intents Connect EVM steps: calls the user's intermediary account makes on the destination chain,
 * in order. The service ABI-encodes `parameters` against `functionSignature`, appends its own fee
 * transfer, and the origin wallet signs the whole batch once.
 *
 * Builders here derive `functionSignature` from an ABI item, so the selector the service computes
 * always matches the contract. `encodeStep` produces the same calldata locally, which is how the
 * tests prove each Trendr step calls what it claims to.
 */

/** Filled by the service with the guaranteed delivered amount after its fee (bridge-in only). */
export const MIN_AMOUNT_OUT = "{MIN_AMOUNT_OUT}";
/** Filled with the origin amount a step must produce (out-operation with EXACT_OUTPUT only). */
export const AMOUNT_IN = "{AMOUNT_IN}";
/** Filled with the 1Click deposit address (out-operation only). */
export const DEPOSIT_ADDRESS = "{DEPOSIT_ADDRESS}";
/** Filled with the intermediary account. */
export const INTERMEDIARY = "{INTERMEDIARY}";

export type Placeholder = typeof MIN_AMOUNT_OUT | typeof AMOUNT_IN | typeof DEPOSIT_ADDRESS | typeof INTERMEDIARY;
const PLACEHOLDERS: readonly string[] = [MIN_AMOUNT_OUT, AMOUNT_IN, DEPOSIT_ADDRESS, INTERMEDIARY];

/** An amount: a literal in raw units, or a placeholder the service fills. */
export type Amount = bigint | typeof MIN_AMOUNT_OUT | typeof AMOUNT_IN;

export interface EvmStep {
  to: Address | typeof DEPOSIT_ADDRESS;
  functionSignature: string;
  parameters: StepParameter[];
  /** Native value in wei, as a decimal string. */
  value: string;
  /** Passed through untouched; anything a client needs to carry goes here. */
  metadata?: Record<string, unknown>;
}

export const MAX_EVM_STEPS = 30;
const MAX_SIGNATURE_BYTES = 1024;
const STEP_KEYS = new Set(["to", "functionSignature", "parameters", "value", "metadata"]);

export type StepErrorCode =
  | "NO_STEPS"
  | "TOO_MANY_STEPS"
  | "ILLEGAL_STEP_SHAPE"
  | "BAD_SIGNATURE"
  | "BAD_PARAMETERS"
  | "PLACEHOLDER_NOT_ALLOWED"
  | "DESTINATION_TOKEN_UNTOUCHED";

export class ConnectStepError extends AuroraInputError {
  override name = "ConnectStepError";
  constructor(
    readonly code: StepErrorCode,
    message: string,
  ) {
    super(message);
  }
}

export const amountParam = (amount: Amount): string => (typeof amount === "bigint" ? amount.toString() : amount);

/** A step calling `fn` on `to` with `args` in signature order. */
export function callStep(
  to: Address,
  fn: AbiFunction,
  args: StepParameter[],
  options: { value?: bigint; metadata?: Record<string, unknown> } = {},
): EvmStep {
  if (args.length !== fn.inputs.length) throw new ConnectStepError("BAD_PARAMETERS", `${fn.name} takes ${fn.inputs.length} arguments, got ${args.length}`);
  return {
    to,
    functionSignature: toFunctionSignature(fn),
    parameters: args,
    value: (options.value ?? 0n).toString(),
    ...(options.metadata ? { metadata: options.metadata } : {}),
  };
}

const approveFn = parseAbiItem("function approve(address spender, uint256 amount) returns (bool)");
const transferFn = parseAbiItem("function transfer(address to, uint256 amount) returns (bool)");

/** ERC-20 approve of exactly `amount`: Intents Connect keeps permissions bounded, and so does Trendr. */
export function approveStep(token: Address, spender: Address, amount: Amount): EvmStep {
  return callStep(token, approveFn, [spender, amountParam(amount)]);
}

export function transferStep(token: Address, to: Address, amount: Amount): EvmStep {
  return callStep(token, transferFn, [to, amountParam(amount)]);
}

function parseSignature(signature: string): AbiFunction {
  if (new TextEncoder().encode(signature).length > MAX_SIGNATURE_BYTES) throw new ConnectStepError("BAD_SIGNATURE", "functionSignature is over 1024 bytes");
  try {
    const item = parseAbiItem(`function ${signature}`) as AbiFunction;
    if (toFunctionSignature(item) !== signature) throw new Error("not canonical");
    return item;
  } catch {
    throw new ConnectStepError("BAD_SIGNATURE", `not a canonical Solidity signature: ${signature}`);
  }
}

function placeholdersIn(value: StepParameter, found: Set<string>) {
  if (Array.isArray(value)) value.forEach((v) => placeholdersIn(v, found));
  else if (typeof value === "string" && PLACEHOLDERS.includes(value)) found.add(value);
}

export type StepFlow = "bridge-in" | "steps-only" | "out-operation";

/**
 * Checks steps against the API's documented rules before they are sent, so a mistake fails here
 * with a clear code instead of as a 400 or, worse, a batch the user signs and the chain reverts.
 * `destinationToken` is the ERC-20 the service charges its fee in (null for a native asset):
 * at least one step must call it.
 */
export function validateSteps(steps: readonly EvmStep[], options: { flow: StepFlow; destinationToken: Address | null }): void {
  if (steps.length === 0) throw new ConnectStepError("NO_STEPS", "an execution needs at least one step");
  if (steps.length > MAX_EVM_STEPS) throw new ConnectStepError("TOO_MANY_STEPS", `at most ${MAX_EVM_STEPS} EVM steps`);
  steps.forEach((step, i) => {
    const extra = Object.keys(step).filter((k) => !STEP_KEYS.has(k));
    if (extra.length) throw new ConnectStepError("ILLEGAL_STEP_SHAPE", `step ${i}: unknown keys ${extra.join(", ")}`);
    if (step.to === DEPOSIT_ADDRESS ? options.flow !== "out-operation" : !isAddress(step.to, { strict: false })) {
      throw new ConnectStepError("ILLEGAL_STEP_SHAPE", `step ${i}: bad target ${step.to}`);
    }
    if (!/^\d+$/.test(step.value) && !PLACEHOLDERS.includes(step.value)) throw new ConnectStepError("ILLEGAL_STEP_SHAPE", `step ${i}: value must be a decimal string`);
    const fn = parseSignature(step.functionSignature);
    if (fn.inputs.length !== step.parameters.length) {
      throw new ConnectStepError("BAD_PARAMETERS", `step ${i}: ${step.functionSignature} takes ${fn.inputs.length} parameters, got ${step.parameters.length}`);
    }
    const found = new Set<string>();
    step.parameters.forEach((p) => placeholdersIn(p, found));
    placeholdersIn(step.value, found);
    for (const p of found) {
      const allowed = p === INTERMEDIARY || (p === MIN_AMOUNT_OUT && options.flow === "bridge-in") || (p !== MIN_AMOUNT_OUT && options.flow === "out-operation");
      if (!allowed) throw new ConnectStepError("PLACEHOLDER_NOT_ALLOWED", `step ${i}: ${p} is not allowed in a ${options.flow} execution`);
    }
  });
  const token = options.destinationToken;
  if (token && !steps.some((s) => s.to !== DEPOSIT_ADDRESS && s.to.toLowerCase() === token.toLowerCase())) {
    throw new ConnectStepError("DESTINATION_TOKEN_UNTOUCHED", `no step calls the destination token ${token}; the service charges its fee in it`);
  }
}

function toArg(param: AbiParameter, value: StepParameter): unknown {
  const type = param.type;
  if (type.endsWith("]")) {
    if (!Array.isArray(value)) throw new ConnectStepError("BAD_PARAMETERS", `${type} needs an array`);
    const inner = { ...param, type: type.slice(0, type.lastIndexOf("[")) } as AbiParameter;
    return value.map((v) => toArg(inner, v));
  }
  if (type === "tuple") {
    const components = (param as { components: readonly AbiParameter[] }).components;
    if (!Array.isArray(value) || value.length !== components.length) throw new ConnectStepError("BAD_PARAMETERS", "a tuple needs an array of its fields");
    return components.map((c, i) => toArg(c, value[i]!));
  }
  if (/^u?int\d*$/.test(type)) {
    if (typeof value === "boolean" || Array.isArray(value)) throw new ConnectStepError("BAD_PARAMETERS", `${type} needs a number`);
    return BigInt(value);
  }
  if (type === "bool") {
    if (typeof value !== "boolean") throw new ConnectStepError("BAD_PARAMETERS", "bool needs true or false");
    return value;
  }
  if (typeof value !== "string") throw new ConnectStepError("BAD_PARAMETERS", `${type} needs a string`);
  return value;
}

function fill(value: StepParameter, values: Partial<Record<Placeholder, string>>): StepParameter {
  if (Array.isArray(value)) return value.map((v) => fill(v, values));
  if (typeof value === "string" && value in values) return values[value as Placeholder]!;
  return value;
}

/**
 * The call a step makes, as the service would encode it, with placeholders replaced from
 * `values` (for example `{ "{MIN_AMOUNT_OUT}": "19888375" }`).
 */
export function encodeStep(step: EvmStep, values: Partial<Record<Placeholder, string>> = {}): { to: Address; value: bigint; data: Hex } {
  const fn = parseSignature(step.functionSignature);
  const params = step.parameters.map((p) => fill(p, values));
  if (params.length !== fn.inputs.length) throw new ConnectStepError("BAD_PARAMETERS", `${step.functionSignature} takes ${fn.inputs.length} parameters`);
  const to = fill(step.to, values);
  const value = fill(step.value, values);
  if (typeof to !== "string" || !isAddress(to, { strict: false })) throw new ConnectStepError("BAD_PARAMETERS", `unresolved target ${String(to)}`);
  const args = fn.inputs.map((input, i) => toArg(input, params[i]!));
  return { to, value: BigInt(value as string), data: encodeFunctionData({ abi: [fn], functionName: fn.name, args } as never) };
}
