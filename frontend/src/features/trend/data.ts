"use client";
import { useQuery } from "@tanstack/react-query";
import { attentionPerpAbi, bondingCurveAbi, type OrderBook, type PriceBand, toPriceBand, trendRegistryAbi, trendrSpotAbi } from "@trendr/contracts";
import type { PerplMarket } from "@trendr/perpl";
import { type Address, BaseError, ContractFunctionRevertedError, erc20Abi, type Hex, parseAbi, zeroAddress } from "viem";
import { perplApi } from "@/lib/api";
import { perplMarketsQuery } from "@/lib/perpl-markets";
import { publicClient } from "@/lib/chain/client";
import { DEPLOYMENT } from "@/lib/config";
import { INDEX_SCALE, readBook, readCurve, readPerpl, readPerpMarket, readPerpPositions, readSeries, tokenBalances } from "@/lib/trade/reads";
import type { KuruParams } from "./math";

/** Live chain state for the trend page, each read refreshed at the pace it moves. */

const d = DEPLOYMENT;

/** The registry's own view: the index the contracts trade at, whether it is fresh, and the trend's status. */
export function useRegistryIndex(trendId: Hex | undefined) {
  return useQuery({
    queryKey: ["registry-index", trendId],
    enabled: Boolean(trendId),
    refetchInterval: 3_000,
    queryFn: async () => {
      const [[index, updatedAt], fresh, status] = await Promise.all([
        publicClient.readContract({ address: d.trendRegistry, abi: trendRegistryAbi, functionName: "indexOf", args: [trendId!] }),
        publicClient.readContract({ address: d.trendRegistry, abi: trendRegistryAbi, functionName: "isFresh", args: [trendId!] }),
        publicClient.readContract({ address: d.trendRegistry, abi: trendRegistryAbi, functionName: "statusOf", args: [trendId!] }),
      ]);
      return { index: Number(index) / INDEX_SCALE, updatedAt: Number(updatedAt), fresh, status: Number(status) as 0 | 1 | 2 | 3 };
    },
  });
}

export function useSeries(trendId: Hex | undefined) {
  return useQuery({ queryKey: ["series", trendId], enabled: Boolean(trendId), refetchInterval: 8_000, queryFn: () => readSeries(trendId!) });
}

/** A Kuru book, refreshed every two seconds while the ticket is on screen. */
export function useBook(market: Address | undefined, levels = 8) {
  return useQuery<OrderBook | null>({
    queryKey: ["book", market, levels],
    enabled: Boolean(market) && market !== zeroAddress,
    refetchInterval: 2_000,
    queryFn: () => readBook(market!, levels),
  });
}

/**
 * TrendrSpot's band for an UP or DOWN token: session trades keep inside it, anything else needs the
 * passkey. Null when TrendrSpot gives none (the series closed or the oracle is stale); undefined
 * while it loads or the chain cannot be read.
 */
export function usePriceBand(token: Address | undefined) {
  return useQuery<PriceBand | null>({
    queryKey: ["price-band", token],
    enabled: Boolean(token),
    refetchInterval: 5_000,
    queryFn: async () => {
      try {
        return toPriceBand(await publicClient.readContract({ address: d.trendrSpot, abi: trendrSpotAbi, functionName: "priceBand", args: [token!] }));
      } catch (e) {
        if (e instanceof BaseError && e.walk((x) => x instanceof ContractFunctionRevertedError)) return null;
        throw e;
      }
    },
  });
}

export function useTokenBalances(owner: Address | undefined, tokens: readonly Address[]) {
  return useQuery({
    queryKey: ["balances", owner, ...tokens],
    enabled: Boolean(owner) && tokens.length > 0,
    refetchInterval: 3_000,
    queryFn: () => tokenBalances(owner!, tokens),
  });
}

export function usePerpMarket(trendId: Hex | undefined, index: number | undefined) {
  return useQuery({
    queryKey: ["perp-market", trendId, index],
    enabled: Boolean(trendId) && index !== undefined,
    refetchInterval: 4_000,
    queryFn: async () => {
      const [m, cap] = await Promise.all([
        readPerpMarket(trendId!),
        publicClient.readContract({ address: d.attentionPerp, abi: attentionPerpAbi, functionName: "openInterestCap", args: [BigInt(Math.round(index! * INDEX_SCALE))] }),
      ]);
      return { ...m, cap: cap as bigint };
    },
  });
}

export function useMyPerpPositions(owner: Address | undefined, trendId: Hex | undefined) {
  return useQuery({
    queryKey: ["perp-positions", owner, trendId],
    enabled: Boolean(owner) && Boolean(trendId),
    refetchInterval: 4_000,
    queryFn: async () => (await readPerpPositions(owner!)).filter((p) => p.trendId.toLowerCase() === trendId!.toLowerCase()),
  });
}

export function useCurve(trendId: Hex | undefined) {
  return useQuery({
    queryKey: ["curve", trendId],
    enabled: Boolean(trendId),
    refetchInterval: 4_000,
    queryFn: async () => {
      const curve = await readCurve(trendId!);
      if (!curve) return null;
      const [ratchet, full] = await Promise.all([
        publicClient.readContract({ address: d.bondingCurve, abi: bondingCurveAbi, functionName: "ratchetBps", args: [trendId!] }),
        publicClient.readContract({ address: d.bondingCurve, abi: bondingCurveAbi, functionName: "curveOf", args: [trendId!] }),
      ]);
      const c = full as { sold: bigint; virtualQuote: bigint };
      return { ...curve, ratchetBps: Number(ratchet), sold: c.sold, virtualQuote: c.virtualQuote };
    },
  });
}

/** A token's symbol; fixed at deployment. */
export function useSymbol(token: Address | undefined) {
  return useQuery({ queryKey: ["symbol", token], enabled: Boolean(token) && token !== zeroAddress, staleTime: Infinity, queryFn: () => publicClient.readContract({ address: token!, abi: erc20Abi, functionName: "symbol" }) });
}

/** Coins out (and the fee) for `quoteIn` on the curve, straight from the contract's own quote. */
export function useCurveQuote(trendId: Hex | undefined, side: "buy" | "sell", amount: bigint | null) {
  return useQuery({
    queryKey: ["curve-quote", trendId, side, amount?.toString()],
    enabled: Boolean(trendId) && amount !== null && amount > 0n,
    refetchInterval: 4_000,
    queryFn: async () => {
      const [out, fee] = (await publicClient.readContract({ address: d.bondingCurve, abi: bondingCurveAbi, functionName: side === "buy" ? "quoteBuy" : "quoteSell", args: [trendId!, amount!] })) as readonly [bigint, bigint];
      return { out, fee };
    },
  });
}

const kuruParamsAbi = parseAbi(["function getMarketParams() view returns (uint32, uint96, address, uint256, address, uint256, uint32, uint96, uint96, uint256, uint256)"]);

/** A Kuru market's precisions and taker fee; fixed at deployment. */
export function useKuruParams(market: Address | undefined) {
  return useQuery<KuruParams>({
    queryKey: ["kuru-params", market],
    enabled: Boolean(market) && market !== zeroAddress,
    staleTime: Infinity,
    queryFn: async () => {
      const [pricePrecision, sizePrecision, , baseDecimals, , quoteDecimals, , , , takerFeeBps] = await publicClient.readContract({ address: market!, abi: kuruParamsAbi, functionName: "getMarketParams" });
      return { pricePrecision: BigInt(pricePrecision), sizePrecision, baseDecimals: Number(baseDecimals), quoteDecimals: Number(quoteDecimals), takerFeeBps };
    },
  });
}

/** Perpl's market for a ticker, if Perpl lists it. */
export function usePerplMarket(ticker: string | null) {
  const markets = useQuery(perplMarketsQuery);
  const market = ticker ? (markets.data?.markets.find((m) => m.symbol.toUpperCase() === ticker.toUpperCase() && m.isOpen) ?? null) : null;
  const minimums = markets.data?.minAccountOpen !== undefined ? { accountOpen: BigInt(markets.data.minAccountOpen), deposit: BigInt(markets.data.minDeposit ?? "0") } : null;
  return { market, minimums, isLoading: markets.isLoading };
}

export function usePerplTicker(market: PerplMarket | null) {
  return useQuery({ queryKey: ["perpl-ticker", market?.id], enabled: Boolean(market), refetchInterval: 2_000, queryFn: async () => (await perplApi.ticker(market!.id)).ticker });
}

export function usePerplAccount(owner: Address | undefined, market: PerplMarket | null) {
  return useQuery({ queryKey: ["perpl-account", owner, market?.id], enabled: Boolean(owner) && Boolean(market), refetchInterval: 4_000, queryFn: () => readPerpl(owner!, [market!]) });
}
