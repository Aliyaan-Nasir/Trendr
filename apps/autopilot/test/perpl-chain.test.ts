import { describe, expect, test } from "bun:test";
import { exchangeAbi } from "@trendr/perpl";
import { encodeEventTopics, encodeAbiParameters, type Log } from "viem";
import { outcomeFromLogs } from "../src/perpl-chain";
import { BTC } from "./fakes";

let index = 0;
function log(eventName: string, args: Record<string, unknown>): Log {
  const event = exchangeAbi.find((x) => x.type === "event" && x.name === eventName) as unknown as { inputs: Array<{ name: string; type: string; indexed?: boolean }> };
  const data = encodeAbiParameters(
    event.inputs.filter((i) => !i.indexed) as never,
    event.inputs.filter((i) => !i.indexed).map((i) => args[i.name] ?? (i.type === "bool" ? false : i.type === "bytes" ? "0x" : i.type === "string" ? "" : i.type === "address" ? "0x0000000000000000000000000000000000000000" : 0n)) as never,
  );
  const topics = encodeEventTopics({ abi: exchangeAbi, eventName: eventName as never, args: {} as never });
  return { address: "0x1964C32f0bE608E7D29302AFF5E61268E72080cc", data, topics, logIndex: index++, blockNumber: 1n, blockHash: "0x00", transactionHash: "0x01", transactionIndex: 0, removed: false } as unknown as Log;
}
const request = (accountId: bigint, orderDescId: bigint) => log("OrderRequestV2", { perpId: 16n, accountId, orderDescId, orderType: 0, lotLNS: 50n });

describe("outcomeFromLogs", () => {
  test("attributes fills in a batch to the order they follow", () => {
    index = 0;
    const logs = [
      request(1029n, 7n),
      log("TakerOrderFilledV2", { lotLNS: 50n, feeCNS: 14_202n }),
      log("PositionOpenedV2", { perpId: 16n, accountId: 1029n, positionType: 0, depositCNS: 20_583_200n, pricePNS: 823_256n, lotLNS: 50n }),
      request(55n, 3n),
      log("TakerOrderFilledV2", { lotLNS: 900n, feeCNS: 1n }),
      log("OrderBatchCompleted", { gasLeft: 1n }),
    ];
    const out = outcomeFromLogs(logs, 1029n, 7n, BTC, "0x01", 1n)!;
    expect(out).toMatchObject({ filled: 0.0005, price: 82_325.6, failure: null });
    expect(out.marginAusd).toBeCloseTo(20.5832);
    expect(out.feeAusd).toBeCloseTo(0.014202);
    // The other account's fill is not ours.
    expect(outcomeFromLogs(logs, 55n, 3n, BTC, "0x01", 1n)!.filled).toBeCloseTo(0.009);
  });

  test("reads realized PnL and funding from a close", () => {
    index = 0;
    const logs = [request(1029n, 8n), log("TakerOrderFilledV2", { lotLNS: 50n, feeCNS: 14_202n }), log("PositionClosed", { perpId: 16n, accountId: 1029n, positionType: 0, pricePNS: 823_268n, deltaPnlCNS: 600n, fundingCNS: -100n })];
    expect(outcomeFromLogs(logs, 1029n, 8n, BTC, "0x01", 1n)).toMatchObject({ filled: 0.0005, price: 82_326.8, pnlAusd: 0.0005 });
  });

  test("reports why an order did not fill, and nothing for an order not in the transaction", () => {
    index = 0;
    const logs = [request(1029n, 9n), log("OrderDescIdTooLow", { lastOrderDescId: 0n })];
    expect(outcomeFromLogs(logs, 1029n, 9n, BTC, "0x01", 1n)).toMatchObject({ filled: 0, failure: "OrderDescIdTooLow" });
    expect(outcomeFromLogs(logs, 1029n, 10n, BTC, "0x01", 1n)).toBeNull();
  });
});

describe("account", () => {
  test("a wallet without a Perpl account is null, but RPC failures still throw", async () => {
    const { PerplChain } = await import("../src/perpl-chain");
    const { ContractFunctionExecutionError, ContractFunctionRevertedError, HttpRequestError } = await import("viem");
    const revert = new ContractFunctionExecutionError(new ContractFunctionRevertedError({ abi: exchangeAbi, functionName: "getAccountByAddr", data: "0x03a0e277" as `0x${string}` }), {
      abi: exchangeAbi,
      functionName: "getAccountByAddr",
      args: ["0x0000000000000000000000000000000000000001"],
    });
    const reverting = new PerplChain({ readContract: async () => Promise.reject(revert) } as never, "0x1964C32f0bE608E7D29302AFF5E61268E72080cc");
    expect(await reverting.account("0x0000000000000000000000000000000000000001")).toBeNull();
    const down = new PerplChain({ readContract: async () => Promise.reject(new HttpRequestError({ url: "https://rpc" })) } as never, "0x1964C32f0bE608E7D29302AFF5E61268E72080cc");
    await expect(down.account("0x0000000000000000000000000000000000000001")).rejects.toThrow();
  });
});
