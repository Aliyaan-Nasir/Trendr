"use client";
import { zeroAddress } from "viem";
import { Card, CardHeader, ExplorerLink } from "@/components/ui";
import type { Trend } from "@/lib/api";
import { DEPLOYMENT, explorerAddress, explorerToken } from "@/lib/config";
import { shortAddress } from "@/lib/format";
import { useCurve, usePerplMarket, useSeries, useSymbol } from "./data";

/**
 * Where this trend lives on Monad: the registry that records its index, the tokens and books of
 * its current series, the perp and curve contracts, and its coin. Each links to Monadscan, where
 * every Trendr contract is verified.
 */

interface Item {
  label: string;
  note: string;
  address: `0x${string}`;
  token?: boolean;
}

export default function OnChain({ trend }: { trend: Trend }) {
  const series = useSeries(trend.id);
  const curve = useCurve(trend.id);
  const coin = curve.data?.coin;
  const symbol = useSymbol(coin);
  const { market: perpl } = usePerplMarket(trend.ticker);
  const current = [...(series.data ?? [])].sort((a, b) => (a.window === 86_400 ? -1 : b.window === 86_400 ? 1 : a.window - b.window))[0];

  const items: Item[] = [
    { label: "Attention index", note: "TrendRegistry, written by the CRE oracle", address: DEPLOYMENT.trendRegistry },
    ...(current
      ? [
          { label: "Up token", note: "Current series, each pays 1 AUSD if Up wins", address: current.up, token: true },
          { label: "Down token", note: "Current series, each pays 1 AUSD if Down wins", address: current.down, token: true },
          ...(current.listed && current.upMarket !== zeroAddress ? [{ label: "Up order book", note: "Kuru market", address: current.upMarket }] : []),
          ...(current.listed && current.downMarket !== zeroAddress ? [{ label: "Down order book", note: "Kuru market", address: current.downMarket }] : []),
        ]
      : []),
    { label: "Outcome markets", note: "Mints, redeems and settles every series", address: DEPLOYMENT.outcomeMarkets },
    { label: "Attention perps", note: "Positions, margin and funding", address: DEPLOYMENT.attentionPerp },
    ...(coin ? [{ label: symbol.data ? `$${symbol.data}` : "Trend coin", note: "This trend's coin", address: coin, token: true }] : []),
    { label: "Bonding curve", note: "Launches and prices trend coins", address: DEPLOYMENT.bondingCurve },
    ...(perpl ? [{ label: "Perpl exchange", note: `${perpl.symbol} perpetuals`, address: DEPLOYMENT.perplExchange }] : []),
    { label: "AUSD", note: "Settles every market", address: DEPLOYMENT.ausd, token: true },
  ];

  return (
    <Card data-testid="trend-onchain">
      <CardHeader title="On chain" subtitle="Every contract is verified on Monadscan" />
      <ul className="mt-2 divide-y divide-line px-5 pb-2">
        {items.map((it) => (
          <li key={`${it.label}-${it.address}`} className="flex items-center gap-4 py-3">
            <div className="min-w-0 flex-1">
              <p className="truncate font-strong text-[13.5px] text-text">{it.label}</p>
              <p className="truncate text-[12px] text-text-3">{it.note}</p>
            </div>
            <ExplorerLink href={it.token ? explorerToken(it.address) : explorerAddress(it.address)} className="num shrink-0 font-mono text-[12.5px] text-text-2" testId="onchain-link">
              {shortAddress(it.address)}
            </ExplorerLink>
          </li>
        ))}
      </ul>
    </Card>
  );
}
