"use client";
import { bondingCurveAbi, decodeL2, iKuruOrderBookAbi, legacyOutcomeMarkets, type OrderBook, outcomeListingAbi, outcomeMarketsAbi, trendRegistryAbi, trendrLensAbi } from "@trendr/contracts";
import type { PerplMarket } from "@trendr/perpl";
import { type Address, erc20Abi, type Hex, parseAbi, zeroAddress } from "viem";
import type { IndexedOutcomeHolding, Trend } from "@/lib/api";
import { publicClient } from "@/lib/chain/client";
import { DEPLOYMENT } from "@/lib/config";
import { INDEX_SCALE, mid, readBook, readPerpl, readPerpPositions, type PerpPositionView, type PerplHolding } from "@/lib/trade/reads";
import { rememberedSeries, rememberSeries } from "./ledger";
import { type Outcome, outcomeValue, perpNumbers, type PerpNumbers, settledOutcome, toTokens } from "./math";

/** Everything the portfolio reads from Monad, batched through Multicall3 where it can be. */

const d = DEPLOYMENT;
const ZERO_ID = "0x0000000000000000000000000000000000000000000000000000000000000000";
/** OutcomeMarkets.VOID_GRACE: an unsettled series turns void this long after expiry. */
const VOID_GRACE = 2 * 86_400;
/** Every OutcomeMarkets whose series the portfolio shows: this deployment's, then replaced ones that only redeem. */
const ISSUERS: readonly Address[] = [d.outcomeMarkets, ...legacyOutcomeMarkets(d.chainId)];
const isCurrent = (markets: Address) => markets.toLowerCase() === d.outcomeMarkets.toLowerCase();

// ---------------------------------------------------------------------------------------------
// Outcome tokens
// ---------------------------------------------------------------------------------------------

export interface OutcomeHolding {
  seriesId: Hex;
  /** The OutcomeMarkets that issued the series, and the one to redeem through. */
  outcomeMarkets: Address;
  /** Issued by a replaced OutcomeMarkets: it only redeems, and only with the passkey. */
  legacy: boolean;
  trendId: Hex;
  trend: Trend | null;
  window: number;
  openedAt: number;
  expiry: number;
  /** Points. */
  openingIndex: number;
  /** The settlement value once the registry has one (points), else null. */
  settlementIndex: number | null;
  /** Settled on chain (OutcomeMarkets), or decided by the registry and redeemable now, or open. */
  outcome: Outcome | null;
  settledOnChain: boolean;
  /** "open" trades, "settling" waits for the oracle, "settled" redeems. */
  phase: "open" | "settling" | "settled";
  up: Address;
  down: Address;
  upMarket: Address | null;
  downMarket: Address | null;
  upBalance: bigint;
  downBalance: bigint;
  upBook: OrderBook | null;
  downBook: OrderBook | null;
  upMid: number | null;
  downMid: number | null;
  /** Complete sets held (raw). */
  sets: bigint;
  /** AUSD, or null when an unpaired side has no price. */
  value: number | null;
}

/** A series and the OutcomeMarkets that issued it. */
export interface SeriesRef {
  seriesId: Hex;
  outcomeMarkets: Address;
}

interface SeriesRow {
  seriesId: Hex;
  outcomeMarkets: Address;
  trendId: Hex;
  window: number;
  openedAt: number;
  expiry: number;
  openingIndex: number;
  outcome: number;
  settlementIndex: number | null;
  up: Address;
  down: Address;
  upMarket: Address;
  downMarket: Address;
  listed: boolean;
}

type LensSeries = { trendId: Hex; window: number; seriesId: Hex; openedAt: bigint; expiry: bigint; openingIndex: bigint; outcome: number; up: Address; down: Address; upMarket: Address; downMarket: Address; listed: boolean };

async function latestSeries(trendIds: readonly Hex[]): Promise<SeriesRow[]> {
  const out: SeriesRow[] = [];
  for (let i = 0; i < trendIds.length; i += 40) {
    const rows = (await publicClient.readContract({ address: d.trendrLens, abi: trendrLensAbi, functionName: "series", args: [trendIds.slice(i, i + 40)] })) as readonly LensSeries[];
    for (const r of rows) {
      if (r.seriesId === ZERO_ID) continue;
      out.push({ seriesId: r.seriesId, outcomeMarkets: d.outcomeMarkets, trendId: r.trendId, window: Number(r.window), openedAt: Number(r.openedAt), expiry: Number(r.expiry), openingIndex: Number(r.openingIndex) / INDEX_SCALE, outcome: Number(r.outcome), settlementIndex: null, up: r.up, down: r.down, upMarket: r.upMarket, downMarket: r.downMarket, listed: r.listed });
    }
  }
  return out;
}

type ChainSeries = { trendId: Hex; openedAt: bigint; expiry: bigint; openingIndex: bigint; settlementIndex: bigint; window: number; outcome: number; up: Address; down: Address };

/** Series no longer latest (from the ledger and the indexer), with their Kuru markets. */
async function olderSeries(refs: readonly SeriesRef[]): Promise<SeriesRow[]> {
  if (refs.length === 0) return [];
  const results = await publicClient.multicall({
    allowFailure: true,
    contracts: refs.flatMap((r) => [
      { address: r.outcomeMarkets, abi: outcomeMarketsAbi, functionName: "seriesOf" as const, args: [r.seriesId] as const },
      { address: d.outcomeListing, abi: outcomeListingAbi, functionName: "marketsOf" as const, args: [r.seriesId] as const },
    ]),
  });
  const out: SeriesRow[] = [];
  refs.forEach((ref, i) => {
    const s = results[i * 2];
    // The listing knows this deployment's series only; a replaced one's never trade here.
    const m = isCurrent(ref.outcomeMarkets) ? results[i * 2 + 1] : undefined;
    if (s?.status !== "success") return;
    const v = s.result as unknown as ChainSeries;
    if (v.up === zeroAddress) return;
    const [upMarket, downMarket, upListed, downListed] = m?.status === "success" ? (m.result as unknown as readonly [Address, Address, boolean, boolean]) : [zeroAddress, zeroAddress, false, false];
    out.push({
      seriesId: ref.seriesId,
      outcomeMarkets: ref.outcomeMarkets,
      trendId: v.trendId,
      window: Number(v.window),
      openedAt: Number(v.openedAt),
      expiry: Number(v.expiry),
      openingIndex: Number(v.openingIndex) / INDEX_SCALE,
      outcome: Number(v.outcome),
      settlementIndex: Number(v.outcome) === 1 || Number(v.outcome) === 2 ? Number(v.settlementIndex) / INDEX_SCALE : null,
      up: v.up,
      down: v.down,
      upMarket,
      downMarket,
      listed: upListed && downListed,
    });
  });
  return out;
}

const refKey = (r: SeriesRef) => `${r.outcomeMarkets.toLowerCase()}:${r.seriesId.toLowerCase()}`;
const current = (seriesId: Hex): SeriesRef => ({ seriesId, outcomeMarkets: d.outcomeMarkets });

/**
 * Series to read beyond each trend's latest (`latest` holds their ids): the ones this device
 * remembers, all of this deployment, and the ones the indexer says the account holds (on a new
 * device the only record of old ones, and of a replaced deployment's), each once.
 */
export function seriesBeyondLatest(remembered: readonly Hex[], indexed: readonly SeriesRef[], latest: ReadonlySet<string>): SeriesRef[] {
  const seen = new Set([...latest].map((id) => refKey(current(id as Hex))));
  const out: SeriesRef[] = [];
  for (const ref of [...remembered.map(current), ...indexed]) {
    const k = refKey(ref);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(ref);
  }
  return out;
}

/**
 * Indexed holdings in series this app's OutcomeMarkets issued, or a replaced one it still redeems
 * through. Balances and states are read on chain, never taken from the indexer.
 */
export function indexedSeries(rows: readonly IndexedOutcomeHolding[], issuers: readonly Address[] = ISSUERS): SeriesRef[] {
  return rows.flatMap((r) => {
    const issuer = issuers.find((a) => a.toLowerCase() === r.outcomeMarkets.toLowerCase());
    return issuer && /^0x[0-9a-f]{64}$/i.test(r.seriesId) ? [{ seriesId: r.seriesId, outcomeMarkets: issuer }] : [];
  });
}

/** A book read that never throws: markets that are not deployed yet read as no book. */
async function safeBook(market: Address | null): Promise<OrderBook | null> {
  if (!market || market === zeroAddress) return null;
  try {
    return await readBook(market, 10);
  } catch {
    return null;
  }
}

/**
 * The account's outcome holdings and, in the same multicall, its AUSD: one snapshot, so the
 * portfolio's totals never count a trade's tokens and its spent cash at different moments.
 * `indexed` adds series the indexer says the account holds, which the chain's lens and this
 * device may not know of.
 */
export async function readOutcomeHoldings(
  owner: Address,
  trends: readonly Trend[],
  indexed: readonly SeriesRef[] = [],
  nowSec = Math.floor(Date.now() / 1000),
): Promise<{ holdings: OutcomeHolding[]; cash: bigint }> {
  const byId = new Map(trends.map((t) => [t.id.toLowerCase(), t]));
  const latest = await latestSeries(trends.map((t) => t.id));
  const older = await olderSeries(seriesBeyondLatest(rememberedSeries(owner), indexed, new Set(latest.map((s) => s.seriesId.toLowerCase()))));
  const rows = [...latest, ...older];

  const balances = await publicClient.multicall({
    allowFailure: false,
    contracts: [
      { address: d.ausd, abi: erc20Abi, functionName: "balanceOf" as const, args: [owner] as const },
      ...rows.flatMap((r) => [
        { address: r.up, abi: erc20Abi, functionName: "balanceOf" as const, args: [owner] as const },
        { address: r.down, abi: erc20Abi, functionName: "balanceOf" as const, args: [owner] as const },
      ]),
    ],
  });
  const cash = balances[0] as bigint;
  const held = rows.map((r, i) => ({ r, up: balances[1 + i * 2] as bigint, down: balances[2 + i * 2] as bigint })).filter((h) => h.up > 0n || h.down > 0n);
  if (held.length === 0) return { holdings: [], cash };
  // A replaced deployment's series come from the indexer; the device remembers this one's.
  rememberSeries(owner, ...held.filter((h) => isCurrent(h.r.outcomeMarkets)).map((h) => h.r.seriesId));

  // Expired series not yet settled on chain: the registry may already know the outcome. Replaced
  // OutcomeMarkets settle against the same registry (redeploys keep it).
  const pending = held.filter((h) => h.r.outcome === 0 && nowSec >= h.r.expiry);
  const settlements = pending.length
    ? await publicClient.multicall({
        allowFailure: true,
        contracts: pending.map((h) => ({ address: d.trendRegistry, abi: trendRegistryAbi, functionName: "settlementOf" as const, args: [h.r.trendId, BigInt(h.r.expiry)] as const })),
      })
    : [];
  const decided = new Map<string, number | null>();
  pending.forEach((h, i) => {
    const s = settlements[i];
    const [finalized, value] = s?.status === "success" ? (s.result as unknown as readonly [boolean, bigint]) : [false, 0n];
    decided.set(h.r.seriesId, finalized ? Number(value) / INDEX_SCALE : null);
  });

  const holdings = await Promise.all(
    held.map(async ({ r, up, down }): Promise<OutcomeHolding> => {
      const onChain = r.outcome !== 0;
      let outcome: Outcome | null = onChain ? (r.outcome as Outcome) : null;
      let settlementIndex = r.settlementIndex;
      if (!onChain && nowSec >= r.expiry) {
        const value = decided.get(r.seriesId) ?? null;
        if (value !== null) {
          outcome = settledOutcome(r.openingIndex, value);
          settlementIndex = value;
        } else if (nowSec >= r.expiry + VOID_GRACE) outcome = 3;
      }
      const phase = outcome !== null ? "settled" : nowSec >= r.expiry ? "settling" : "open";
      // Books only matter while a price is the best guess of value.
      const priced = phase !== "settled" && r.listed;
      const [upBook, downBook] = priced ? await Promise.all([safeBook(up > 0n ? r.upMarket : null), safeBook(down > 0n ? r.downMarket : null)]) : [null, null];
      const upMid = mid(upBook);
      const downMid = mid(downBook);
      const { value, sets } = outcomeValue({ up, down, outcome, upMid, downMid });
      return {
        seriesId: r.seriesId,
        outcomeMarkets: r.outcomeMarkets,
        legacy: !isCurrent(r.outcomeMarkets),
        trendId: r.trendId,
        trend: byId.get(r.trendId.toLowerCase()) ?? null,
        window: r.window,
        openedAt: r.openedAt,
        expiry: r.expiry,
        openingIndex: r.openingIndex,
        settlementIndex,
        outcome,
        settledOnChain: onChain,
        phase,
        up: r.up,
        down: r.down,
        upMarket: r.listed ? r.upMarket : null,
        downMarket: r.listed ? r.downMarket : null,
        upBalance: up,
        downBalance: down,
        upBook,
        downBook,
        upMid,
        downMid,
        sets,
        value,
      };
    }),
  );
  return { holdings, cash };
}

// ---------------------------------------------------------------------------------------------
// Attention perps
// ---------------------------------------------------------------------------------------------

export interface PerpHolding extends PerpPositionView, PerpNumbers {
  trend: Trend | null;
  unit: bigint;
}

let unitCache: bigint | null = null;

export async function readPerpHoldings(owner: Address, trends: readonly Trend[]): Promise<PerpHolding[]> {
  const byId = new Map(trends.map((t) => [t.id.toLowerCase(), t]));
  unitCache ??= (await publicClient.readContract({ address: d.attentionPerp, abi: parseAbi(["function unit() view returns (uint256)"]), functionName: "unit" })) as bigint;
  const unit = unitCache;
  const rows = await readPerpPositions(owner);
  return rows.map((p) => ({ ...p, ...perpNumbers({ isLong: p.isLong, qty: p.qty, unit, index: p.index, margin: p.margin, equity: p.equity }), trend: byId.get(p.trendId.toLowerCase()) ?? null, unit })).sort((a, b) => Number(b.id - a.id));
}

// ---------------------------------------------------------------------------------------------
// Trend coins
// ---------------------------------------------------------------------------------------------

export interface CoinHolding {
  trendId: Hex;
  trend: Trend | null;
  coin: Address;
  /** 1 open on the curve, 2 full and waiting to graduate, 3 graduated to Kuru. */
  state: number;
  balance: bigint;
  /** AUSD per coin: the curve's spot price, or the Kuru mid once graduated. */
  price: number | null;
  value: number | null;
  /** Share of the graduation reserve filled, 0 to 1. */
  progress: number;
  market: Address;
  kuru: KuruParams | null;
  book: OrderBook | null;
}

export interface KuruParams {
  pricePrecision: number;
  sizePrecision: number;
  baseDecimals: number;
  quoteDecimals: number;
  takerFeeBps: number;
}

type CurveRow = { coin: Address; state: number; reserve: bigint; market: Address };
const kuruParamsAbi = parseAbi(["function getMarketParams() view returns (uint32, uint96, address, uint256, address, uint256, uint32, uint96, uint96, uint256, uint256)"]);

export async function readCoinHoldings(owner: Address, trends: readonly Trend[]): Promise<CoinHolding[]> {
  if (trends.length === 0) return [];
  const curves = await publicClient.multicall({ allowFailure: true, contracts: trends.map((t) => ({ address: d.bondingCurve, abi: bondingCurveAbi, functionName: "curveOf" as const, args: [t.id] as const })) });
  const withCoin = trends.map((t, i) => ({ t, c: curves[i]?.status === "success" ? (curves[i]!.result as unknown as CurveRow) : null })).filter((x): x is { t: Trend; c: CurveRow } => x.c !== null && x.c.coin !== zeroAddress);
  if (withCoin.length === 0) return [];
  const balances = await publicClient.multicall({ allowFailure: true, contracts: withCoin.map((x) => ({ address: x.c.coin, abi: erc20Abi, functionName: "balanceOf" as const, args: [owner] as const })) });
  const held = withCoin.map((x, i) => ({ ...x, balance: balances[i]?.status === "success" ? (balances[i]!.result as bigint) : 0n })).filter((x) => x.balance > 0n);
  if (held.length === 0) return [];
  const graduation = (await publicClient.readContract({ address: d.bondingCurve, abi: bondingCurveAbi, functionName: "graduationReserve" })) as bigint;
  return Promise.all(
    held.map(async ({ t, c, balance }): Promise<CoinHolding> => {
      const state = Number(c.state);
      let price: number | null = null;
      let kuru: KuruParams | null = null;
      let book: OrderBook | null = null;
      if (state === 3 && c.market !== zeroAddress) {
        try {
          const [pp, sp, , bd, , qd, , , , fee] = await publicClient.readContract({ address: c.market, abi: kuruParamsAbi, functionName: "getMarketParams" });
          kuru = { pricePrecision: Number(pp), sizePrecision: Number(sp), baseDecimals: Number(bd), quoteDecimals: Number(qd), takerFeeBps: Number(fee) };
          const raw = await publicClient.readContract({ address: c.market, abi: iKuruOrderBookAbi, functionName: "getL2Book", args: [10, 10] });
          book = decodeL2(raw as Hex);
          const bid = book.bids[0]?.price;
          const ask = book.asks[0]?.price;
          const m = bid !== undefined && ask !== undefined ? (bid + ask) / 2 : (bid ?? ask);
          price = m === undefined ? null : m / kuru.pricePrecision;
        } catch {
          price = null;
        }
      } else {
        const spot = (await publicClient.readContract({ address: d.bondingCurve, abi: bondingCurveAbi, functionName: "spotPrice", args: [t.id] }).catch(() => 0n)) as bigint;
        price = Number(spot) / 1e18 / 1e6;
      }
      return {
        trendId: t.id,
        trend: t,
        coin: c.coin,
        state,
        balance,
        price,
        value: price === null ? null : toTokens(balance, 18) * price,
        progress: graduation > 0n ? Math.min(1, Number(c.reserve) / Number(graduation)) : 0,
        market: c.market,
        kuru,
        book,
      };
    }),
  );
}

// ---------------------------------------------------------------------------------------------
// Perpl
// ---------------------------------------------------------------------------------------------

export interface PerplPosition extends PerplHolding {
  /** Mark (or entry, when the mark is unavailable) PnL, AUSD. */
  pnl: number;
  pnlPct: number;
  notional: number;
  leverage: number;
}

export async function readPerplHoldings(owner: Address, markets: readonly PerplMarket[]) {
  if (!d.perplExchange || markets.length === 0) return { accountId: null, balance: 0, positions: [] as PerplPosition[] };
  const r = await readPerpl(owner, markets);
  const positions = r.holdings.map((h): PerplPosition => {
    const mark = h.markPrice ?? h.entryPrice;
    const pnl = (mark - h.entryPrice) * h.size * (h.side === "long" ? 1 : -1);
    const notional = mark * h.size;
    return { ...h, pnl, pnlPct: h.marginAusd > 0 ? (pnl / h.marginAusd) * 100 : 0, notional, leverage: h.marginAusd > 0 ? notional / h.marginAusd : 0 };
  });
  return { accountId: r.accountId, balance: r.balanceAusd, positions };
}
