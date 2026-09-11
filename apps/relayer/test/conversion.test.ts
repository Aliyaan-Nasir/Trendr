import { describe, expect, test } from "bun:test";
import { type Call, type Deployment, deployments, stableSwapAbi, usdcConversion, usdcToAusdCalls } from "@trendr/contracts";
import { encodeFunctionData, erc20Abi } from "viem";
import { checkOwnerCalls, checkSessionCalls } from "../src/policy";
import type { TrendrTokens } from "../src/tokens";

/**
 * The USDC to AUSD conversion of an Aurora deposit on Mainnet: exactly approve(pool) on USDC and
 * exchange(USDC -> AUSD, receiver = the account) on the stable pool, in an owner batch only.
 */

const conversion = usdcConversion(143)!;
/** A Mainnet deployment (Testnet's protocol addresses stand in; only the chain and AUSD matter here). */
const mainnet: Deployment = { ...deployments[10143]!, chainId: 143, ausd: conversion.ausd };
const testnet = deployments[10143]!;
const account = "0x00000000000000000000000000000000000000aa" as const;
const thief = "0x00000000000000000000000000000000000000bb" as const;
const tokens: TrendrTokens = { isTrendrToken: async () => false };

const owner = (calls: Call[], d: Deployment = mainnet) => checkOwnerCalls(calls, d, account, tokens);
const exchange = (i: bigint, j: bigint, minOut: bigint, receiver: `0x${string}`): Call => ({
  target: conversion.pool,
  value: 0n,
  data: encodeFunctionData({ abi: stableSwapAbi, functionName: "exchange", args: [i, j, 25_000_000n, minOut, receiver] }),
});
const usdc = (functionName: "approve" | "transfer", to: `0x${string}`): Call => ({
  target: conversion.usdc,
  value: 0n,
  data: encodeFunctionData({ abi: erc20Abi, functionName, args: [to, 25_000_000n] }),
});

describe("USDC to AUSD conversion", () => {
  test("the owner batch the app sends is sponsored on Mainnet", async () => {
    expect(await owner(usdcToAusdCalls(conversion, account, 25_000_000n, 24_900_000n))).toEqual({ ok: true });
  });

  test("the exchange must pay the account itself, USDC for AUSD, with a minimum out", async () => {
    const approve = usdc("approve", conversion.pool);
    expect(await owner([approve, exchange(1n, 0n, 1n, thief)])).toMatchObject({ ok: false, index: 1, reason: "a conversion pays the account itself" });
    expect(await owner([exchange(0n, 1n, 1n, account)])).toMatchObject({ ok: false, reason: "the conversion pool only exchanges USDC for AUSD" });
    expect(await owner([exchange(1n, 2n, 1n, account)])).toMatchObject({ ok: false, reason: "the conversion pool only exchanges USDC for AUSD" });
    expect(await owner([approve, exchange(1n, 0n, 0n, account)])).toMatchObject({ ok: false, reason: "a conversion needs a minimum out" });
    const removeLiquidity: Call = { target: conversion.pool, value: 0n, data: "0x1a4d01d2" + "00".repeat(96) as `0x${string}` };
    expect(await owner([removeLiquidity])).toMatchObject({ ok: false, reason: "the conversion pool only exchanges" });
  });

  test("USDC may only be approved to the pool", async () => {
    expect(await owner([usdc("approve", thief)])).toMatchObject({ ok: false, reason: "USDC calls are limited to approving the conversion pool" });
    expect(await owner([usdc("transfer", thief)])).toMatchObject({ ok: false, reason: "USDC calls are limited to approving the conversion pool" });
  });

  test("Testnet has no conversion, and sessions never convert", async () => {
    const calls = usdcToAusdCalls(conversion, account, 25_000_000n, 24_900_000n);
    expect(await owner(calls, testnet)).toMatchObject({ ok: false, index: 0, reason: "call is not on the relayer allowlist" });
    expect(await checkSessionCalls(calls, mainnet, tokens)).toMatchObject({ ok: false, index: 0, reason: "approvals are limited to protocol contracts" });
    expect(await checkSessionCalls([calls[1]!], mainnet, tokens)).toMatchObject({ ok: false, reason: "call is not on the relayer allowlist" });
  });
});
