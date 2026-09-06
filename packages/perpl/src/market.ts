import type { PerplNetwork } from "./networks";

/** One Perpl market as the public context describes it. */
export interface PerplMarket {
  /** Market id in the API, which is also the on-chain perpetual id. */
  id: number;
  name: string;
  symbol: string;
  priceDecimals: number;
  sizeDecimals: number;
  /** Highest leverage, from the initial margin setting (hundredths: 1500 is 15x). */
  maxLeverage: number;
  /** Maintenance margin as a fraction of notional. */
  maintenanceMargin: number;
  /** Default max negative PnL collateralization, in basis points. */
  defaultMnp: number;
  /** Largest slippage a market order may accept, in basis points. */
  maxSlippageBps: number;
  isOpen: boolean;
  /** Orders must expire within this many blocks of the head. */
  orderTtlBlocks: number;
}

export interface PerplContext {
  chainId: number;
  instanceId: number;
  minAccountOpen: bigint;
  minDeposit: bigint;
  markets: PerplMarket[];
}

/** Last, mark and index prices of a market, already scaled to decimals. */
export interface PerplTicker {
  block: number;
  at: number;
  index: number;
  mark: number;
  last: number;
  bid: number;
  ask: number;
}

type Raw = Record<string, unknown>;
const num = (v: unknown, fallback = 0) => (typeof v === "number" ? v : typeof v === "string" && v !== "" ? Number(v) : fallback);

/**
 * Reads the public context: instances and markets. Field names follow Perpl's MarketConfig; the
 * margin fractions read as maximum leverage in hundredths, as the live values show.
 */
export async function fetchContext(n: PerplNetwork, fetchFn: typeof fetch = fetch): Promise<PerplContext> {
  const res = await fetchFn(`${n.rest}/v1/pub/context`);
  if (!res.ok) throw new Error(`Perpl context: HTTP ${res.status}`);
  const body = (await res.json()) as { instances?: Raw[]; markets?: Raw[] };
  const instance = body.instances?.[0] ?? {};
  const markets = (body.markets ?? []).map((m): PerplMarket => {
    const cfg = (m.config ?? {}) as Raw;
    const im = num(cfg.initial_margin);
    const mm = num(cfg.maintenance_margin);
    const name = String(m.name ?? "");
    return {
      id: num(m.perpetual_id ?? m.id),
      name,
      // Some Mainnet markets leave the symbol empty; the size unit names the asset.
      symbol: String(m.symbol || m.size_units || name.replace(/ Perp$/, "")),
      priceDecimals: num(cfg.price_decimals),
      sizeDecimals: num(cfg.size_decimals),
      maxLeverage: im > 0 ? im / 100 : 1,
      maintenanceMargin: mm > 0 ? 100 / mm : 0,
      defaultMnp: num(m.order_max_neg_pnl_collat_bps),
      maxSlippageBps: num(m.order_max_market_slippage_bps),
      orderTtlBlocks: num(m.order_ttl_blocks, 20),
      isOpen: cfg.is_open !== false,
    };
  });
  return {
    chainId: n.chainId,
    instanceId: num(instance.id),
    minAccountOpen: BigInt(String(instance.min_account_open_amount ?? "0")),
    minDeposit: BigInt(String(instance.min_deposit_amount ?? "0")),
    markets,
  };
}

/** Ticker of one market, scaled to prices. */
export async function fetchTicker(n: PerplNetwork, market: PerplMarket, fetchFn: typeof fetch = fetch): Promise<PerplTicker> {
  const res = await fetchFn(`${n.rest}/v1/market-data/${market.id}/ticker`);
  if (!res.ok) throw new Error(`Perpl ticker ${market.id}: HTTP ${res.status}`);
  const body = (await res.json()) as { d: Record<string, Raw> };
  const t = body.d[String(market.id)];
  if (!t) throw new Error(`Perpl ticker ${market.id}: missing`);
  const scale = 10 ** market.priceDecimals;
  const at = t.at as { b: number; t: number };
  return { block: at.b, at: at.t, index: num(t.orl) / scale, mark: num(t.mrk) / scale, last: num(t.lst) / scale, bid: num(t.bid) / scale, ask: num(t.ask) / scale };
}

export interface CandleSeriesPoint {
  /** Seconds. */
  t: number;
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
}

/** Candles (up to 1024) between `from` and `to`, seconds; resolution in seconds. */
export async function fetchCandles(
  n: PerplNetwork,
  market: PerplMarket,
  resolution: number,
  from: number,
  to: number,
  fetchFn: typeof fetch = fetch,
): Promise<CandleSeriesPoint[]> {
  const res = await fetchFn(`${n.rest}/v1/market-data/${market.id}/candles/${resolution}/${from * 1000}-${to * 1000}`);
  if (!res.ok) throw new Error(`Perpl candles ${market.id}: HTTP ${res.status}`);
  const body = (await res.json()) as { d?: Raw[] };
  const scale = 10 ** market.priceDecimals;
  return (body.d ?? []).map((c) => ({
    t: Math.floor(num(c.t) / 1000),
    o: num(c.o) / scale,
    h: num(c.h) / scale,
    l: num(c.l) / scale,
    c: num(c.c) / scale,
    v: num(c.v),
  }));
}

/** Price to Perpl's scaled integer for `market`, rounded to the nearest tick. */
export const toPriceUnits = (market: PerplMarket, price: number) => BigInt(Math.round(price * 10 ** market.priceDecimals));
/** Size to Perpl's scaled integer for `market`, rounded down to whole lots. */
export const toSizeUnits = (market: PerplMarket, size: number) => BigInt(Math.floor(size * 10 ** market.sizeDecimals + 1e-9));
export const fromPriceUnits = (market: PerplMarket, units: bigint | number) => Number(units) / 10 ** market.priceDecimals;
export const fromSizeUnits = (market: PerplMarket, units: bigint | number) => Number(units) / 10 ** market.sizeDecimals;
