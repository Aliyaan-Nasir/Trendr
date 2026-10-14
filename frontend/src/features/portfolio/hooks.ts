"use client";
import { keepPreviousData, useQuery, useQueryClient } from "@tanstack/react-query";
import type { PerplMarket } from "@trendr/perpl";
import { useCallback, useEffect, useMemo, useRef } from "react";
import { useAccount } from "@/lib/account/AccountProvider";
import { autopilot, type IndexedOutcomeHolding, type RuleDetail, type StoredRule, trends as trendsApi } from "@/lib/api";
import { useHead } from "@/lib/chain/client";
import { useAusdBalance } from "@/lib/hooks/queries";
import { readCuration } from "@/lib/trade/reads";
import { indexedOutcomesQuery } from "./cost-basis";
import { portfolioKey } from "./keys";
import { type PerplMarketList, perplMarketsQuery } from "@/lib/perpl-markets";
import { indexedSeries, readCoinHoldings, readOutcomeHoldings, readPerpHoldings, readPerplHoldings } from "./reads";

/**
 * The portfolio's data. Chain reads refresh as blocks arrive: positions and books every eight
 * blocks (about three seconds), slow-moving holdings every forty, and once more right after a
 * trade. The public RPC allows about 15 requests a second per address, shared by every tab.
 */

const FAST = "fast";
const SLOW = "slow";
/** Blocks between refreshes (Monad makes one every 400 ms). */
const FAST_BLOCKS = 8n;
const SLOW_BLOCKS = 40n;

export { portfolioKey } from "./keys";

export function useAllTrends() {
  return useQuery({ queryKey: ["trends", "all"], queryFn: () => trendsApi.list(true), refetchInterval: 30_000, placeholderData: keepPreviousData });
}

/** Perpl's full market specs from the backend (Perpl's own API may refuse browser origins). */
const allMarkets = (list: PerplMarketList): PerplMarket[] => list.markets;

export function usePerplMarkets() {
  return useQuery({ ...perplMarketsQuery, select: allMarkets });
}

const seriesOf = (rows: readonly IndexedOutcomeHolding[]) => indexedSeries(rows);

/**
 * Series the indexer says the account holds outcome tokens of. On a new device this is the only
 * record of old series (a settled one with winnings to redeem) that the chain's lens no longer
 * lists. Without the indexer, the portfolio still shows what the lens and this device know.
 */
export function useIndexedSeries(address: string | undefined) {
  return useQuery({
    ...indexedOutcomesQuery(address),
    select: seriesOf,
  });
}

/** Refreshes the portfolio's chain reads every few blocks; falls back to a timer without the head stream. */
export function useBlockRefresh(address: string | undefined) {
  const qc = useQueryClient();
  const head = useHead();
  const last = useRef({ fast: 0n, slow: 0n });
  const n = head?.number ?? null;
  useEffect(() => {
    if (n === null || !address) return;
    const key = portfolioKey(address);
    if (n - last.current.fast >= FAST_BLOCKS) {
      last.current.fast = n;
      void qc.invalidateQueries({ queryKey: [...key, FAST] }, { cancelRefetch: false });
    }
    if (n - last.current.slow >= SLOW_BLOCKS) {
      last.current.slow = n;
      void qc.invalidateQueries({ queryKey: [...key, SLOW] }, { cancelRefetch: false });
    }
  }, [n, address, qc]);
  return head;
}

/** Without a head stream (a dropped socket), poll instead. */
function useFallbackInterval(ms: number) {
  const head = useHead();
  return head ? false : ms;
}

export function usePortfolioData() {
  const account = useAccount();
  const address = account.address;
  const trends = useAllTrends();
  const list = trends.data?.trends;
  const trendKey = useMemo(() => (list ?? []).map((t) => t.id).join(","), [list]);
  const key = portfolioKey(address);
  const fastPoll = useFallbackInterval(3_000);
  const slowPoll = useFallbackInterval(12_000);
  const enabled = Boolean(address) && Boolean(list);
  const perplMarkets = usePerplMarkets();

  const cash = useAusdBalance(address);
  const indexed = useIndexedSeries(address).data;
  const outcomes = useQuery({
    // The indexed list changes rarely; its size in the key reads a newly found series at once.
    queryKey: [...key, FAST, "outcomes", trendKey, indexed?.length ?? 0],
    enabled,
    refetchInterval: fastPoll,
    placeholderData: keepPreviousData,
    queryFn: () => readOutcomeHoldings(address!, list!, indexed ?? []),
  });
  const perps = useQuery({ queryKey: [...key, FAST, "perps", trendKey], enabled, refetchInterval: fastPoll, placeholderData: keepPreviousData, queryFn: () => readPerpHoldings(address!, list!) });
  const coins = useQuery({ queryKey: [...key, SLOW, "coins", trendKey], enabled, refetchInterval: slowPoll, placeholderData: keepPreviousData, queryFn: () => readCoinHoldings(address!, list!) });
  const perpl = useQuery({
    queryKey: [...key, FAST, "perpl", perplMarkets.data?.length ?? 0],
    enabled: Boolean(address) && Boolean(perplMarkets.data),
    refetchInterval: fastPoll,
    placeholderData: keepPreviousData,
    queryFn: () => readPerplHoldings(address!, perplMarkets.data!),
  });
  const curation = useQuery({ queryKey: [...key, SLOW, "curation"], enabled: Boolean(address), refetchInterval: slowPoll, placeholderData: keepPreviousData, queryFn: () => readCuration(address!) });

  // Autopilot: public performance, and (signed in to the backend) rules and follows to label positions.
  const performance = useQuery({ queryKey: [...key, "performance"], enabled: Boolean(address), refetchInterval: 60_000, queryFn: () => autopilot.performance(address!) });
  const automation = useQuery({
    queryKey: [...key, "automation"],
    enabled: Boolean(address) && account.backendReady,
    refetchInterval: 30_000,
    queryFn: async (): Promise<{ rules: StoredRule[]; details: RuleDetail[]; following: boolean }> => {
      const [{ rules }, { follows }] = await Promise.all([autopilot.rules(), autopilot.follows()]);
      // Rules that ever traded or still might; stopped rules keep their history.
      const details = await Promise.all(rules.slice(0, 12).map((r) => autopilot.rule(r.id).catch(() => null)));
      return { rules, details: details.filter((x): x is RuleDetail => x !== null), following: follows.some((f) => f.status !== "stopped") };
    },
  });

  return { account, address, trends, cash, outcomes, perps, coins, perpl, perplMarkets, curation, performance, automation };
}

/** Refreshes everything the portfolio shows right away (after a trade fills). */
export function useRefreshPortfolio() {
  const qc = useQueryClient();
  const { address } = useAccount();
  return useCallback(() => {
    void qc.invalidateQueries({ queryKey: portfolioKey(address) }, { cancelRefetch: false });
    void qc.invalidateQueries({ queryKey: ["ausd"] });
  }, [qc, address]);
}

export type PortfolioData = ReturnType<typeof usePortfolioData>;
