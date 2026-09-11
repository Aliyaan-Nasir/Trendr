import type { Chain } from "@trendr/chain";
import {
  bondingCurveAbi,
  type Deployment,
  outcomeMarketsAbi,
  outcomeTokenAbi,
  trendCoinAbi,
  trendrSpotAbi,
} from "@trendr/contracts";
import { type Abi, type Address, type Hex, isAddressEqual, zeroAddress } from "viem";

/** Whether an address is a token the Trendr protocol made: an UP or DOWN token, or a trend coin. */
export interface TrendrTokens {
  isTrendrToken(token: Address): Promise<boolean>;
}

/**
 * Decides from the protocol contracts' own records, so a contract that merely claims a trend or
 * series id is not a Trendr token:
 * - TrendrSpot.marketOf(token) != 0: a listed UP or DOWN token, or a graduated trend coin;
 * - BondingCurve.curveOf(token.trendId()).coin == token: a trend coin still on its curve;
 * - OutcomeMarkets.seriesOf(token.seriesId()).up or .down == token: an UP or DOWN token not listed yet.
 * Throws when the chain cannot be read.
 */
export function chainTokenLookup(chain: Chain, d: Deployment): (token: Address) => Promise<boolean> {
  return async (token) => {
    const market = (await chain.read({ address: d.trendrSpot, abi: trendrSpotAbi, functionName: "marketOf", args: [token] })) as Address;
    if (!isAddressEqual(market, zeroAddress)) return true;
    const code = await chain.code(token);
    if (!code || code === "0x") return false;
    const trendId = await probe(chain, token, trendCoinAbi, "trendId");
    if (trendId) {
      const curve = (await chain.read({ address: d.bondingCurve, abi: bondingCurveAbi, functionName: "curveOf", args: [trendId] })) as {
        coin: Address;
      };
      if (isAddressEqual(curve.coin, token)) return true;
    }
    const seriesId = await probe(chain, token, outcomeTokenAbi, "seriesId");
    if (seriesId) {
      const series = (await chain.read({ address: d.outcomeMarkets, abi: outcomeMarketsAbi, functionName: "seriesOf", args: [seriesId] })) as {
        up: Address;
        down: Address;
      };
      if (isAddressEqual(series.up, token) || isAddressEqual(series.down, token)) return true;
    }
    return false;
  };
}

/** A bytes32 getter on a contract that may not have it: null when it reverts or returns nothing. */
async function probe(chain: Chain, address: Address, abi: Abi, functionName: string): Promise<Hex | null> {
  try {
    const value = await chain.read({ address, abi, functionName });
    return typeof value === "string" && /^0x[0-9a-fA-F]{64}$/.test(value) ? (value as Hex) : null;
  } catch (e) {
    if (lacksFunction(e)) return null;
    throw e;
  }
}

/** viem errors that mean the call reached the contract and failed, rather than the RPC failing. */
const CONTRACT_FAILURES = new Set([
  "ContractFunctionRevertedError",
  "ContractFunctionZeroDataError",
  "AbiDecodingZeroDataError",
  "AbiDecodingDataSizeTooSmallError",
]);

/**
 * The call reached the contract and failed: no such function, a revert, or malformed output.
 * Matched by name, because @trendr/chain resolves its own copy of viem and `instanceof` fails
 * across copies.
 */
export function lacksFunction(e: unknown): boolean {
  for (let x: unknown = e, depth = 0; x && typeof x === "object" && depth < 10; x = (x as { cause?: unknown }).cause, depth++) {
    if (CONTRACT_FAILURES.has((x as { name?: string }).name ?? "")) return true;
  }
  return false;
}

/**
 * Caches answers per address: a Trendr token stays one, so yes is kept for good; no is kept
 * briefly, since an unlisted token may be listed later. Concurrent lookups of one address share
 * one read, and failed reads are not cached.
 */
export class CachedTrendrTokens implements TrendrTokens {
  private readonly yes = new Set<string>();
  private readonly no = new Map<string, number>();
  private readonly pending = new Map<string, Promise<boolean>>();

  constructor(
    private readonly lookup: (token: Address) => Promise<boolean>,
    private readonly negativeTtlMs = 30_000,
    private readonly now: () => number = () => Date.now(),
    private readonly maxNegative = 10_000,
  ) {}

  async isTrendrToken(token: Address): Promise<boolean> {
    const key = token.toLowerCase();
    if (this.yes.has(key)) return true;
    const until = this.no.get(key);
    if (until !== undefined) {
      if (until > this.now()) return false;
      this.no.delete(key);
    }
    const inflight = this.pending.get(key);
    if (inflight) return inflight;
    const p = this.lookup(token)
      .then((answer) => {
        if (answer) this.yes.add(key);
        else this.rememberNo(key);
        return answer;
      })
      .finally(() => this.pending.delete(key));
    this.pending.set(key, p);
    return p;
  }

  private rememberNo(key: string) {
    if (this.no.size >= this.maxNegative) {
      const t = this.now();
      for (const [k, until] of this.no) if (until <= t) this.no.delete(k);
      // Still full: the cache only saves reads, so start over rather than grow.
      if (this.no.size >= this.maxNegative) this.no.clear();
    }
    this.no.set(key, this.now() + this.negativeTtlMs);
  }
}
