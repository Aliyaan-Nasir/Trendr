"use client";
import { useQueries, useQuery } from "@tanstack/react-query";
import { withFollowDefaults } from "@trendr/autopilot";
import { deploymentPerplPermissions, passkeyAccountAbi } from "@trendr/contracts";
import { getAddress, isAddressEqual } from "viem";
import { useAccount } from "@/lib/account/AccountProvider";
import { BOT_ADDRESS } from "@/lib/bot";
import { ApiError, autopilot, type Grant, history, perplApi, social } from "@/lib/api";
import { publicClient } from "@/lib/chain/client";
import { DEPLOYMENT } from "@/lib/config";
import { type PerplMarketList, perplMarketsQuery } from "@/lib/perpl-markets";

/** Queries for Autopilot, copy-trading and the caller screens, keyed by account. */

export { BOT_ADDRESS };
export const isBot = (address: string | null | undefined) => Boolean(address) && address!.toLowerCase() === BOT_ADDRESS;

/** Perpl's open markets with their full specs (leverage cap, maintenance margin). */
const openMarkets = (list: PerplMarketList) => ({ markets: list.markets.filter((m) => m.isOpen) });

export function usePerplMarkets() {
  return useQuery({ ...perplMarketsQuery, select: openMarkets });
}

/** Perpl's live mark price for a market, every few seconds. */
export function usePerplTicker(marketId: number | null | undefined) {
  return useQuery({ queryKey: ["perpl-ticker", marketId], queryFn: () => perplApi.ticker(marketId!), enabled: typeof marketId === "number", refetchInterval: 4_000 });
}

export function useRules() {
  const { address, backendReady } = useAccount();
  return useQuery({ queryKey: ["ap-rules", address], queryFn: () => autopilot.rules(), enabled: backendReady && Boolean(address), refetchInterval: 20_000 });
}

export function useRuleDetail(id: number | null) {
  const { address, backendReady } = useAccount();
  return useQuery({
    queryKey: ["ap-rule", address, id],
    queryFn: () => autopilot.rule(id!),
    enabled: backendReady && id !== null && Number.isInteger(id),
    refetchInterval: 10_000,
    retry: (n, e) => !(e instanceof ApiError && e.status === 404) && n < 1,
  });
}

/** Details (stats, last audit event) for each rule in a list, refreshed together. */
export function useRuleDetails(ids: number[]) {
  const { address, backendReady } = useAccount();
  return useQueries({
    queries: ids.map((id) => ({ queryKey: ["ap-rule", address, id], queryFn: () => autopilot.rule(id), enabled: backendReady, refetchInterval: 20_000 })),
  });
}

export function usePerformance(owner: string | null | undefined) {
  return useQuery({
    queryKey: ["ap-performance", owner?.toLowerCase()],
    queryFn: () => autopilot.performance(owner!.toLowerCase()),
    enabled: Boolean(owner),
    refetchInterval: 30_000,
  });
}

export function useFollows() {
  const { address, backendReady } = useAccount();
  return useQuery({
    queryKey: ["follows", address],
    queryFn: () => autopilot.follows(),
    // Follows stored before slippage and the loss cap read with their defaults.
    select: (d) => ({ follows: d.follows.map((f) => ({ ...f, settings: withFollowDefaults(f.settings) })) }),
    enabled: backendReady && Boolean(address),
    refetchInterval: 20_000,
  });
}

export function useLeaderboard() {
  return useQuery({ queryKey: ["callers-leaderboard"], queryFn: () => social.leaderboard(), refetchInterval: 30_000 });
}

/** Traders across every product, by realized PnL (from the indexer; 503 while it is not set up). */
export function useTraders() {
  return useQuery({ queryKey: ["leaderboard-traders"], queryFn: () => history.traders(), refetchInterval: 60_000, retry: (n, e) => !(e instanceof ApiError && e.status === 503) && n < 1 });
}

/** One account's record across every product, from the indexer. */
export function useAccountHistory(address: string | null | undefined) {
  return useQuery({
    queryKey: ["account-history", address?.toLowerCase()],
    queryFn: () => history.account(address!.toLowerCase()),
    enabled: Boolean(address),
    refetchInterval: 60_000,
    retry: (n, e) => !(e instanceof ApiError && (e.status === 503 || e.status === 404)) && n < 1,
  });
}

export function useCaller(idOrHandle: string | null | undefined) {
  return useQuery({
    queryKey: ["caller", idOrHandle?.toLowerCase()],
    queryFn: () => social.caller(idOrHandle!.toLowerCase()),
    enabled: Boolean(idOrHandle),
    refetchInterval: 30_000,
    retry: (n, e) => !(e instanceof ApiError && e.status === 404) && n < 1,
  });
}

/**
 * Autopilot's access to the account, as the chain sees it: the backend records the grant, the
 * account holds the session key. A key revoked or expired on chain no longer trades, whatever the
 * backend's record says.
 */
export type GrantState = "none" | "active" | "expired" | "revoked";
export interface GrantView {
  state: GrantState;
  sessionKey: `0x${string}` | null;
  validUntil: number;
  /** AUSD the key may move per UTC day. */
  dailyLimit: number;
  /** AUSD moved so far today. */
  spentToday: number;
  /**
   * The key's Perpl orders name a replaced order guard, which keeps its older rules (no leverage
   * cap): it still trades, but one passkey prompt should renew it before anything new starts.
   */
  outdated: boolean;
  backend: Grant | null;
}

const NONE: GrantView = { state: "none", sessionKey: null, validUntil: 0, dailyLimit: 0, spentToday: 0, outdated: false, backend: null };

/**
 * Whether a key's Perpl orders go through the deployment's current order guard. A failed read (a
 * version 1 account, which has no guards and upgrades first, or the RPC) flags nothing.
 */
async function onCurrentGuard(account: `0x${string}`, key: `0x${string}`): Promise<boolean> {
  const order = deploymentPerplPermissions(DEPLOYMENT)[0];
  if (!order) return true;
  const guard = await publicClient
    .readContract({ address: account, abi: passkeyAccountAbi, functionName: "guardOf", args: [getAddress(key), order.target, order.selector] })
    .catch(() => null);
  return guard === null || isAddressEqual(guard, order.guard);
}

async function readSession(account: `0x${string}`, key: `0x${string}`) {
  const s = await publicClient.readContract({ address: account, abi: passkeyAccountAbi, functionName: "sessionOf", args: [getAddress(key)] });
  return { validUntil: Number(s.validUntil), day: Number(s.day), dailyLimit: Number(s.dailyLimit) / 1e6, spentToday: Number(s.spentToday) / 1e6, active: s.active };
}

export async function loadGrant(account: `0x${string}`): Promise<GrantView> {
  const stored = (await autopilot.grant()).grant;
  if (!stored) return NONE;
  let grant: Grant = stored;
  const now = Math.floor(Date.now() / 1000);
  // A grant (or a replacement key) added on chain whose confirmation never reached the backend: finish it now.
  const waiting = (grant.status === "pending" ? grant.sessionKey : grant.nextSessionKey) as `0x${string}` | null | undefined;
  if (waiting) {
    const s = await readSession(account, waiting);
    if (s.active && s.validUntil > now) {
      grant = await autopilot
        .confirmGrant()
        .then((r) => r.grant)
        .catch(() => stored);
    }
  }
  const key = grant.sessionKey as `0x${string}`;
  const onchain = await readSession(account, key);
  if (grant.status === "pending" || onchain.validUntil === 0) return { ...NONE, backend: grant };
  const today = Math.floor(now / 86_400);
  const base = { sessionKey: key, validUntil: onchain.validUntil, dailyLimit: onchain.dailyLimit, spentToday: onchain.day === today ? onchain.spentToday : 0, outdated: false, backend: grant };
  if (!onchain.active || grant.status === "revoked") return { ...base, state: "revoked" };
  if (onchain.validUntil <= now || grant.status === "expired") return { ...base, state: "expired" };
  return { ...base, state: "active", outdated: !(await onCurrentGuard(account, key)) };
}

export function useGrant() {
  const { address, backendReady } = useAccount();
  return useQuery({ queryKey: ["ap-grant", address], queryFn: () => loadGrant(address!), enabled: backendReady && Boolean(address), refetchInterval: 30_000 });
}

/** Autopilot refuses to enable rules on a grant with less than an hour left; an outdated key renews first. */
export const grantUsable = (g: GrantView | undefined) => g?.state === "active" && !g.outdated && g.validUntil > Date.now() / 1000 + 3600;
