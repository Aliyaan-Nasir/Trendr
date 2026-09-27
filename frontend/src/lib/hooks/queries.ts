"use client";
import { useQuery } from "@tanstack/react-query";
import { erc20Abi, formatUnits } from "viem";
import { system, trends } from "@/lib/api";
import { publicClient } from "@/lib/chain/client";
import { AUSD_DECIMALS, DEPLOYMENT } from "@/lib/config";

/** Shared queries: one cache entry per resource, refreshed at the pace its data moves. */

export function useTrends() {
  return useQuery({ queryKey: ["trends"], queryFn: () => trends.list(), refetchInterval: 15_000 });
}

export function useTrend(identifier: string) {
  return useQuery({ queryKey: ["trend", identifier], queryFn: () => trends.get(identifier), refetchInterval: 15_000 });
}

export function useUpcoming() {
  return useQuery({ queryKey: ["upcoming"], queryFn: () => trends.upcoming(), refetchInterval: 60_000 });
}

/** The account's AUSD (6 decimals), refreshed every few seconds while signed in. */
export function useAusdBalance(address: `0x${string}` | undefined) {
  return useQuery({
    queryKey: ["ausd", address],
    enabled: Boolean(address),
    refetchInterval: 4_000,
    queryFn: async () => {
      const raw = await publicClient.readContract({ address: DEPLOYMENT.ausd, abi: erc20Abi, functionName: "balanceOf", args: [address!] });
      return { raw, value: Number(formatUnits(raw, AUSD_DECIMALS)) };
    },
  });
}

export function useSystemStatus() {
  return useQuery({ queryKey: ["status"], queryFn: () => system.status(), refetchInterval: 30_000, retry: false });
}
