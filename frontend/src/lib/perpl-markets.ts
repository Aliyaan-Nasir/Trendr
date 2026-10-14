import type { PerplMarket } from "@trendr/perpl";
import { autopilot, perplApi } from "@/lib/api";

export interface PerplMarketList {
  markets: PerplMarket[];
  minAccountOpen?: string;
  minDeposit?: string;
}

/**
 * Perpl's market list as the backend serves it, cached once under one key. Every reader shares this
 * query and narrows it with `select`, so the cache entry never holds two shapes (a trade ticket and
 * the portfolio reading different shapes under one key broke the portfolio after a Perpl trade).
 */
export const perplMarketsQuery = {
  queryKey: ["perpl-markets-full"],
  staleTime: 600_000,
  queryFn: async (): Promise<PerplMarketList> => {
    try {
      return await perplApi.markets();
    } catch {
      // Older backends: the Autopilot list has what reading positions needs.
      const { markets } = await autopilot.markets();
      return { markets: markets.map((m) => ({ ...m, maintenanceMargin: 0, defaultMnp: 0, maxSlippageBps: 0, orderTtlBlocks: 20, isOpen: true })) };
    }
  },
};
