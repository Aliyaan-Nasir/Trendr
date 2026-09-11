import { describe, expect, test } from "bun:test";
import type { Chain } from "@trendr/chain";
import { deployments } from "@trendr/contracts";
import { type Address, ContractFunctionExecutionError, ContractFunctionRevertedError, ContractFunctionZeroDataError, type Hex, zeroAddress } from "viem";
import { CachedTrendrTokens, chainTokenLookup, lacksFunction } from "../src/tokens";

const d = deployments[10143]!;
const listed = "0x0000000000000000000000000000000000000a01" as const;
const coin = "0x0000000000000000000000000000000000000a02" as const;
const outcome = "0x0000000000000000000000000000000000000a03" as const;
const impostor = "0x0000000000000000000000000000000000000a04" as const;
const eoa = "0x0000000000000000000000000000000000000a05" as const;
const broken = "0x0000000000000000000000000000000000000a06" as const;
const TREND = `0x${"11".repeat(32)}` as Hex;
const SERIES = `0x${"22".repeat(32)}` as Hex;

/** How viem reports a call that reached a contract and reverted, wrapped as readContract wraps it. */
const reverted = (functionName: string) =>
  new ContractFunctionExecutionError(new ContractFunctionRevertedError({ abi: [], functionName, message: "execution reverted" }), {
    abi: [],
    functionName,
  });
const noData = (functionName: string) =>
  new ContractFunctionExecutionError(new ContractFunctionZeroDataError({ functionName }), { abi: [], functionName });

/** A chain that knows a listed UP token, a curve coin, an unlisted DOWN token and a few impostors. */
function fakeChain(rpcDown = false) {
  const reads: string[] = [];
  const chain = {
    chainId: 10143,
    code: async (a: Address) => (a === eoa ? undefined : "0x6080"),
    read: async ({ address, functionName, args }: { address: Address; functionName: string; args?: readonly unknown[] }) => {
      reads.push(`${address}.${functionName}`);
      if (address === d.trendrSpot && functionName === "marketOf") return args![0] === listed ? "0x00000000000000000000000000000000000000ff" : zeroAddress;
      if (address === d.bondingCurve && functionName === "curveOf") return { coin: args![0] === TREND ? coin : zeroAddress, state: 1 };
      if (address === d.outcomeMarkets && functionName === "seriesOf") {
        return args![0] === SERIES ? { up: "0x0000000000000000000000000000000000000b01", down: outcome } : { up: zeroAddress, down: zeroAddress };
      }
      if (address === broken && rpcDown) throw new Error("fetch failed");
      if (functionName === "trendId") {
        // The impostor claims the real coin's trend; only the curve's answer counts.
        if (address === coin || address === impostor) return TREND;
        throw reverted("trendId");
      }
      if (functionName === "seriesId") {
        if (address === outcome) return SERIES;
        if (address === impostor) return SERIES;
        throw noData("seriesId");
      }
      throw new Error(`unexpected read ${address}.${functionName}`);
    },
  } as unknown as Chain;
  return { chain, reads };
}

describe("on-chain token lookup", () => {
  test("knows listed outcome tokens and graduated coins from TrendrSpot alone", async () => {
    const { chain, reads } = fakeChain();
    expect(await chainTokenLookup(chain, d)(listed)).toBe(true);
    expect(reads).toEqual([`${d.trendrSpot}.marketOf`]);
  });

  test("knows a coin still on its curve, and an outcome token not listed yet", async () => {
    const { chain } = fakeChain();
    const lookup = chainTokenLookup(chain, d);
    expect(await lookup(coin)).toBe(true);
    expect(await lookup(outcome)).toBe(true);
  });

  test("refuses contracts that claim a trend or series, contracts without the getters, and EOAs", async () => {
    const { chain, reads } = fakeChain();
    const lookup = chainTokenLookup(chain, d);
    expect(await lookup(impostor)).toBe(false);
    expect(await lookup(broken)).toBe(false);
    reads.length = 0;
    expect(await lookup(eoa)).toBe(false);
    expect(reads).toEqual([`${d.trendrSpot}.marketOf`]);
  });

  test("throws when the chain cannot be read, rather than answering no", async () => {
    const { chain } = fakeChain(true);
    await expect(chainTokenLookup(chain, d)(broken)).rejects.toThrow("fetch failed");
  });

  test("tells contract failures from RPC failures", () => {
    expect(lacksFunction(reverted("trendId"))).toBe(true);
    expect(lacksFunction(noData("seriesId"))).toBe(true);
    // Matched by name, so errors from @trendr/chain's own copy of viem count too.
    expect(lacksFunction({ name: "ContractFunctionExecutionError", cause: { name: "AbiDecodingZeroDataError" } })).toBe(true);
    expect(lacksFunction(new Error("fetch failed"))).toBe(false);
    expect(lacksFunction({ name: "HttpRequestError", cause: { name: "TimeoutError" } })).toBe(false);
    expect(lacksFunction(undefined)).toBe(false);
  });
});

describe("token cache", () => {
  const token = "0x0000000000000000000000000000000000000c01" as const;

  test("keeps yes for good and no for a while", async () => {
    let t = 0;
    let answer = false;
    let lookups = 0;
    const cache = new CachedTrendrTokens(
      async () => {
        lookups++;
        return answer;
      },
      30_000,
      () => t,
    );
    expect(await cache.isTrendrToken(token)).toBe(false);
    t = 29_999;
    expect(await cache.isTrendrToken(token)).toBe(false);
    expect(lookups).toBe(1);
    // Listed in the meantime: the next lookup after the negative entry expires says yes.
    answer = true;
    t = 30_000;
    expect(await cache.isTrendrToken(token)).toBe(true);
    answer = false;
    t = 10 ** 12;
    expect(await cache.isTrendrToken(token.toUpperCase().replace("0X", "0x") as Address)).toBe(true);
    expect(lookups).toBe(2);
  });

  test("shares one read between concurrent lookups and does not cache failures", async () => {
    let lookups = 0;
    let fail = true;
    const cache = new CachedTrendrTokens(async () => {
      lookups++;
      await Bun.sleep(5);
      if (fail) throw new Error("rpc down");
      return true;
    });
    const both = await Promise.allSettled([cache.isTrendrToken(token), cache.isTrendrToken(token)]);
    expect(both.map((r) => r.status)).toEqual(["rejected", "rejected"]);
    expect(lookups).toBe(1);
    fail = false;
    expect(await cache.isTrendrToken(token)).toBe(true);
    expect(lookups).toBe(2);
  });

  test("bounds the negative entries", async () => {
    let t = 0;
    const cache = new CachedTrendrTokens(async () => false, 1_000, () => t, 3);
    const no = (cache as unknown as { no: Map<string, number> }).no;
    for (let i = 0; i < 3; i++) await cache.isTrendrToken(`0x${i.toString(16).padStart(40, "0")}`);
    t = 2_000;
    await cache.isTrendrToken(`0x${"9".repeat(40)}`);
    // The expired entries went first.
    expect(no.size).toBe(1);
    for (let i = 0; i < 5; i++) await cache.isTrendrToken(`0x${(i + 16).toString(16).padStart(40, "0")}`);
    expect(no.size).toBeLessThanOrEqual(3);
  });
});
