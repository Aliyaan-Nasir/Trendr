import { type Abi, BaseError, ContractFunctionRevertedError, decodeErrorResult, type Hex } from "viem";

function revertData(e: BaseError): Hex | null {
  let found: Hex | null = null;
  e.walk((x) => {
    const data = (x as { data?: unknown }).data;
    if (typeof data === "string" && /^0x[0-9a-fA-F]{8,}$/.test(data)) found = data as Hex;
    else if (data && typeof data === "object" && typeof (data as { data?: unknown }).data === "string") found = (data as { data: Hex }).data;
    return false;
  });
  return found;
}

/**
 * Decodes custom errors against `abis`, including errors nested in a wrapper error's bytes
 * argument (such as an account's CallFailed(index, reason)).
 */
export function decodeRevert(data: Hex, abis: readonly Abi[]): string | null {
  for (const abi of abis) {
    try {
      const { errorName, args } = decodeErrorResult({ abi, data });
      const parts = (args ?? []).map((a) => {
        if (typeof a === "string" && a.startsWith("0x") && a.length > 10) return decodeRevert(a as Hex, abis) ?? a;
        return String(a);
      });
      return `${errorName}(${parts.join(", ")})`;
    } catch {
      // Not this ABI.
    }
  }
  return null;
}

/** The most specific reason a call failed: a decoded custom error when there is one. */
export function revertReason(e: unknown, abis: readonly Abi[] = []): string {
  if (e instanceof BaseError) {
    const data = revertData(e);
    const decoded = data ? decodeRevert(data, abis) : null;
    if (decoded) return decoded;
    const revert = e.walk((x) => x instanceof ContractFunctionRevertedError);
    if (revert instanceof ContractFunctionRevertedError) {
      return revert.data?.errorName ?? revert.reason ?? revert.shortMessage;
    }
    return e.shortMessage;
  }
  return e instanceof Error ? e.message : String(e);
}

/**
 * A one-line description of a failed RPC call or send for logs and health output: viem's short
 * message and the node's details, never the full message, which carries the endpoint URL (and
 * with it any API key) and the request body.
 */
export function errorSummary(e: unknown): string {
  if (e instanceof BaseError) {
    const details = e.details && e.details !== e.shortMessage ? e.details : null;
    return details ? `${e.shortMessage} (${details})` : e.shortMessage;
  }
  const text = e instanceof Error ? e.message : String(e);
  return text.replace(/https?:\/\/\S+/g, "<rpc>");
}
