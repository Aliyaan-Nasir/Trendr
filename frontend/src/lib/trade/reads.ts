"use client";
import { attentionPerpAbi, bondingCurveAbi, curationFeesAbi, decodeL2, iKuruOrderBookAbi, OUTCOME_MARKET, type OrderBook, outcomeMarketsAbi, trendrLensAbi } from "@trendr/contracts";
import { exchangeAbi, fromPriceUnits, fromSizeUnits, type PerplMarket } from "@trendr/perpl";
import { type Address, erc20Abi, type Hex, zeroAddress } from "viem";
import { publicClient } from "@/lib/chain/client";
import { DEPLOYMENT } from "@/lib/config";

/** Chain reads for tickets and the portfolio, batched through Multicall3. */

const d = DEPLOYMENT;
export const INDEX_SCALE = 1_000_000;
export const AUSD = 1_000_000n;

export interface SeriesView {
  trendId: Hex;
  window: number;
  seriesId: Hex;
  openedAt: number;
  expiry: number;
  /** Points. */
  openingIndex: number;
  /** 0 open, 1 UP won, 2 DOWN won, 3 void. */
  outcome: number;
  settleable: boolean;
  up: Address;
  down: Address;
  upMarket: Address;
  downMarket: Address;
  listed: boolean;
}

export async function readSeries(trendId: Hex): Promise<SeriesView[]> {
  const rows = await publicClient.readContract({ address: d.trendrLens, abi: trendrLensAbi, functionName: "series", args: [[trendId]] });
  return rows
    .filter((r) => r.seriesId !== "0x0000000000000000000000000000000000000000000000000000000000000000")
    .map((r) => ({
      trendId: r.trendId,
      window: Number(r.window),
      seriesId: r.seriesId,
      openedAt: Number(r.openedAt),
      expiry: Number(r.expiry),
      openingIndex: Number(r.openingIndex) / INDEX_SCALE,
      outcome: Number(r.outcome),
      settleable: r.settleable,
      up: r.up,
      down: r.down,
      upMarket: r.upMarket,
      downMarket: r.downMarket,
      listed: r.listed,
    }));
}

/** A Kuru order book (top levels), decoded. */
export async function readBook(market: Address, levels = 8): Promise<OrderBook | null> {
  if (market === zeroAddress) return null;
  const raw = await publicClient.readContract({ address: market, abi: iKuruOrderBookAbi, functionName: "getL2Book", args: [levels, levels] });
  return decodeL2(raw as Hex);
}

/** Mid price of a book in AUSD per token (book prices are in 1/10,000 AUSD), or the side that exists. */
export function mid(book: OrderBook | null): number | null {
  if (!book) return null;
  const bid = book.bids[0]?.price;
  const ask = book.asks[0]?.price;
  const p = bid !== undefined && ask !== undefined ? (bid + ask) / 2 : (bid ?? ask);
  return p === undefined ? null : p / OUTCOME_MARKET.pricePrecision;
}

export async function tokenBalances(owner: Address, tokens: readonly Address[]): Promise<bigint[]> {
  if (tokens.length === 0) return [];
  const results = await publicClient.multicall({ allowFailure: true, contracts: tokens.map((t) => ({ address: t, abi: erc20Abi, functionName: "balanceOf" as const, args: [owner] as const })) });
  return results.map((r) => (r.status === "success" ? (r.result as bigint) : 0n));
}

export interface PerpMarketView {
  longQty: bigint;
  shortQty: bigint;
  /** Signed funding rate per block (1e18 scale), positive when longs pay. */
  fundingPerBlock: bigint;
  maxOpenInterestPerSide: bigint;
  minMargin: bigint;
  unit: bigint;
}

export async function readPerpMarket(trendId: Hex): Promise<PerpMarketView> {
  const [m, rate, maxOi, minMargin, unit] = await Promise.all([
    publicClient.readContract({ address: d.attentionPerp, abi: attentionPerpAbi, functionName: "markets", args: [trendId] }),
    publicClient.readContract({ address: d.attentionPerp, abi: attentionPerpAbi, functionName: "fundingRatePerBlock", args: [trendId] }),
    publicClient.readContract({ address: d.attentionPerp, abi: attentionPerpAbi, functionName: "maxOpenInterestPerSide" }),
    publicClient.readContract({ address: d.attentionPerp, abi: attentionPerpAbi, functionName: "minMargin" }),
    publicClient.readContract({ address: d.attentionPerp, abi: attentionPerpAbi, functionName: "unit" }),
  ]);
  const [longQty, shortQty] = m as readonly [bigint, bigint, bigint, bigint, bigint, bigint];
  return { longQty, shortQty, fundingPerBlock: rate as bigint, maxOpenInterestPerSide: maxOi as bigint, minMargin: minMargin as bigint, unit: unit as bigint };
}

export interface PerpPositionView {
  id: bigint;
  owner: Address;
  trendId: Hex;
  isLong: boolean;
  /** Points. */
  entryIndex: number;
  index: number;
  qty: bigint;
  margin: bigint;
  equity: bigint;
  maintenance: bigint;
  liquidatable: boolean;
  retired: boolean;
}

/** Every open perp position of `owner`, scanning the lens in pages. */
export async function readPerpPositions(owner: Address): Promise<PerpPositionView[]> {
  const out: PerpPositionView[] = [];
  let from = 1n;
  for (let page = 0; page < 50; page++) {
    const [rows, next] = (await publicClient.readContract({ address: d.trendrLens, abi: trendrLensAbi, functionName: "positions", args: [from, 200n] })) as readonly [
      ReadonlyArray<{ id: bigint; owner: Address; trendId: Hex; isLong: boolean; entryIndex: bigint; index: bigint; qty: bigint; margin: bigint; equity: bigint; maintenance: bigint; liquidatable: boolean; retired: boolean }>,
      bigint,
    ];
    for (const r of rows) {
      if (r.owner.toLowerCase() !== owner.toLowerCase()) continue;
      out.push({ ...r, entryIndex: Number(r.entryIndex) / INDEX_SCALE, index: Number(r.index) / INDEX_SCALE });
    }
    if (next <= from) break;
    from = next;
    const total = await publicClient.readContract({ address: d.attentionPerp, abi: attentionPerpAbi, functionName: "nextPositionId" });
    if (from >= (total as bigint)) break;
  }
  return out;
}

export interface CurveView {
  coin: Address;
  /** 0 none, 1 open, 2 ready to graduate, 3 graduated. */
  state: number;
  reserve: bigint;
  graduationReserve: bigint;
  spotPrice: bigint;
  market: Address;
}

export async function readCurve(trendId: Hex): Promise<CurveView | null> {
  const [c, grad, spotPrice] = await Promise.all([
    publicClient.readContract({ address: d.bondingCurve, abi: bondingCurveAbi, functionName: "curveOf", args: [trendId] }),
    publicClient.readContract({ address: d.bondingCurve, abi: bondingCurveAbi, functionName: "graduationReserve" }),
    publicClient.readContract({ address: d.bondingCurve, abi: bondingCurveAbi, functionName: "spotPrice", args: [trendId] }).catch(() => 0n),
  ]);
  const curve = c as { coin: Address; state: number; reserve: bigint; market: Address };
  if (curve.coin === zeroAddress) return null;
  return { coin: curve.coin, state: Number(curve.state), reserve: curve.reserve, graduationReserve: grad as bigint, spotPrice: spotPrice as bigint, market: curve.market };
}

export async function readCuration(account: Address) {
  const [claimable, earned] = await Promise.all([
    publicClient.readContract({ address: d.curationFees, abi: curationFeesAbi, functionName: "claimable", args: [account] }),
    publicClient.readContract({ address: d.curationFees, abi: curationFeesAbi, functionName: "earnedByAccount", args: [account] }),
  ]);
  return { claimable: claimable as bigint, earned: earned as bigint };
}

export async function readOutcomeSeries(seriesId: Hex) {
  return publicClient.readContract({ address: d.outcomeMarkets, abi: outcomeMarketsAbi, functionName: "seriesOf", args: [seriesId] });
}

export interface PerplHolding {
  market: PerplMarket;
  side: "long" | "short";
  size: number;
  entryPrice: number;
  marginAusd: number;
  markPrice: number | null;
}

/** The account's Perpl account and positions, straight from the Exchange. */
export async function readPerpl(owner: Address, markets: readonly PerplMarket[]): Promise<{ accountId: bigint | null; balanceAusd: number; holdings: PerplHolding[] }> {
  let info: { accountId: bigint; balanceCNS: bigint } | null = null;
  try {
    info = (await publicClient.readContract({ address: d.perplExchange, abi: exchangeAbi, functionName: "getAccountByAddr", args: [owner] })) as { accountId: bigint; balanceCNS: bigint };
  } catch {
    // The Exchange reverts for wallets without an account.
    return { accountId: null, balanceAusd: 0, holdings: [] };
  }
  if (!info.accountId) return { accountId: null, balanceAusd: 0, holdings: [] };
  const results = await publicClient.multicall({
    allowFailure: true,
    contracts: markets.map((m) => ({ address: d.perplExchange, abi: exchangeAbi, functionName: "getPosition" as const, args: [BigInt(m.id), info!.accountId] as const })),
  });
  const holdings: PerplHolding[] = [];
  markets.forEach((m, i) => {
    const r = results[i];
    if (r?.status !== "success") return;
    const [p, mark, valid] = r.result as readonly [{ positionType: number; depositCNS: bigint; pricePNS: bigint; lotLNS: bigint }, bigint, boolean];
    if (p.lotLNS === 0n) return;
    holdings.push({ market: m, side: p.positionType === 1 ? "short" : "long", size: fromSizeUnits(m, p.lotLNS), entryPrice: fromPriceUnits(m, p.pricePNS), marginAusd: Number(p.depositCNS) / 1e6, markPrice: valid ? fromPriceUnits(m, mark) : null });
  });
  return { accountId: info.accountId, balanceAusd: Number(info.balanceCNS) / 1e6, holdings };
}
