import { describe, expect, test } from "bun:test";
import { decodeFunctionData, erc20Abi, getAddress } from "viem";
import { conversionMinOut, deployments, stableSwapAbi, usdcConversion, usdcToAusdCalls } from "../src";

const account = "0x00000000000000000000000000000000000a11ce" as const;

describe("usdcConversion", () => {
  test("exists on Mainnet only, against Mainnet AUSD", () => {
    const c = usdcConversion(143)!;
    expect(c.pool).toBe("0x942644106B073E30D72c2C5D7529D5C296ea91ab");
    expect([c.usdcIndex, c.ausdIndex]).toEqual([1n, 0n]);
    expect(c.ausd).toBe("0x00000000eFE302BEAA2b3e6e1b18d08D69a9012a");
    if (deployments[143]) expect(deployments[143].ausd.toLowerCase()).toBe(c.ausd.toLowerCase());
    expect(usdcConversion(10_143)).toBeNull();
  });
});

describe("conversionMinOut", () => {
  test("is the quote less the slippage", () => {
    expect(conversionMinOut(100_000_000n, 100_013_000n)).toBe((100_013_000n * 9_970n) / 10_000n);
  });

  test("never goes under 0.99 AUSD per USDC", () => {
    // 99.2 less 0.3% is 98.9, under the floor.
    expect(conversionMinOut(100_000_000n, 99_200_000n)).toBe(99_000_000n);
    expect(conversionMinOut(100_000_000n, 99_000_000n)).toBe(99_000_000n);
  });

  test("refuses a quote under the floor, as when the pool's fee is raised", () => {
    expect(conversionMinOut(100_000_000n, 98_999_999n)).toBeNull();
    expect(conversionMinOut(1_000_000_000n, 500_092_934n)).toBeNull();
    expect(conversionMinOut(0n, 0n)).toBeNull();
  });
});

describe("usdcToAusdCalls", () => {
  test("approves exactly the amount to the pool, then exchanges USDC for AUSD paid to the account", () => {
    const c = usdcConversion(143)!;
    const [approve, exchange] = usdcToAusdCalls(c, account, 25_000_000n, 24_900_000n);
    expect(approve!.target).toBe(c.usdc);
    expect(decodeFunctionData({ abi: erc20Abi, data: approve!.data })).toEqual({ functionName: "approve", args: [c.pool, 25_000_000n] });
    expect(exchange!.target).toBe(c.pool);
    expect(exchange!.data.slice(0, 10)).toBe("0xddc1f59d");
    expect(decodeFunctionData({ abi: stableSwapAbi, data: exchange!.data })).toEqual({
      functionName: "exchange",
      args: [1n, 0n, 25_000_000n, 24_900_000n, getAddress(account)],
    });
    expect([approve!.value, exchange!.value]).toEqual([0n, 0n]);
  });

  test("refuses a conversion without a minimum out", () => {
    expect(() => usdcToAusdCalls(usdcConversion(143)!, account, 1n, 0n)).toThrow();
  });
});
