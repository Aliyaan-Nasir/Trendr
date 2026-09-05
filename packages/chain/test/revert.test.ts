import { describe, expect, test } from "bun:test";
import { InvalidParamsRpcError, RpcRequestError, TransactionExecutionError } from "viem";
import { errorSummary } from "../src/revert";

describe("errorSummary", () => {
  test("keeps the short message and the node's details, never the endpoint", () => {
    const url = "https://monad-testnet.example.org/v2/SECRET_KEY";
    const rpc = new RpcRequestError({ body: { method: "eth_sendRawTransactionSync" }, url, error: { code: -32602, message: "Signer had insufficient balance" } });
    const wrapped = new TransactionExecutionError(new InvalidParamsRpcError(rpc), { account: undefined, chain: undefined } as never);
    const text = errorSummary(wrapped);
    expect(text).toContain("Signer had insufficient balance");
    expect(text).not.toContain("SECRET_KEY");
    expect(text).not.toContain("eth_sendRawTransactionSync");
  });

  test("strips URLs from plain errors", () => {
    expect(errorSummary(new Error("fetch failed for https://rpc.example.org/key123 after 3 tries"))).toBe("fetch failed for <rpc> after 3 tries");
    expect(errorSummary("boom")).toBe("boom");
  });
});
