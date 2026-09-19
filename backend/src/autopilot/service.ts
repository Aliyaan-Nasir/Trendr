import { type BacktestResult, backtest, type Candle, type Point, type Rule } from "@trendr/autopilot";
import { fetchCandles, fetchContext, fetchTicker, type PerplContext, type PerplMarket, type PerplNetwork, type PerplTicker } from "@trendr/perpl";
import type { Hex } from "viem";
import type { ChainReader, ChainTrend } from "../chain";
import type { Sql } from "../db";
import type { IndexHistory } from "../history";
import type { Fetch } from "../sources/http";
import { baseOf } from "../identifiers";

/**
 * Autopilot reads: Perpl's markets, the trend a rule follows, and backtests built from the trend's
 * registry checkpoints, smart-money readings and Perpl candles.
 */

export const MAX_BACKTEST_DAYS = 30;
/** Perpl returns at most 1,024 candles per request. */
const CANDLES_PER_REQUEST = 1000;
/**
 * Candle pages are cached so backtests share upstream requests: a page wholly in the past never
 * changes, so it is kept longer; the page holding the current candle is refetched after a minute.
 */
export const LIVE_CANDLE_PAGE_MS = 60_000;
export const PAST_CANDLE_PAGE_MS = 15 * 60_000;

export class AutopilotService {
  private context: { at: number; value: PerplContext } | null = null;
  private tickers = new Map<number, { at: number; value: Promise<PerplTicker> }>();
  private candlePages = new Map<string, { expires: number; value: Promise<Candle[]> }>();

  constructor(
    private readonly sql: Sql,
    private readonly chain: ChainReader,
    private readonly history: IndexHistory,
    readonly perpl: PerplNetwork,
    private readonly opts: { takerFeeBps: number; slippageBps: number },
    private readonly fetchImpl: Fetch = fetch,
    private readonly now: () => number = Date.now,
  ) {}

  /** Perpl's public context (instance minimums and markets), cached for ten minutes. */
  async perplContext(): Promise<PerplContext> {
    if (!this.context || this.now() - this.context.at > 600_000) {
      this.context = { at: this.now(), value: await fetchContext(this.perpl, this.fetchImpl as typeof fetch) };
    }
    return this.context.value;
  }

  /** Perpl's open markets. */
  async markets(): Promise<PerplMarket[]> {
    return (await this.perplContext()).markets.filter((m) => m.isOpen);
  }

  /** A market's prices, cached for two seconds so the app's tickers share one upstream request. */
  async ticker(market: PerplMarket): Promise<PerplTicker> {
    const hit = this.tickers.get(market.id);
    if (hit && this.now() - hit.at < 2_000) return hit.value;
    const value = fetchTicker(this.perpl, market, this.fetchImpl as typeof fetch);
    this.tickers.set(market.id, { at: this.now(), value });
    value.catch(() => this.tickers.delete(market.id));
    return value;
  }

  async market(symbol: string): Promise<PerplMarket | null> {
    return (await this.markets()).find((m) => m.symbol.toUpperCase() === symbol.toUpperCase()) ?? null;
  }

  /** The trend a rule follows: the newest listing of its base identifier, live ones first. */
  async trendFor(identifier: string): Promise<ChainTrend | null> {
    const base = baseOf(identifier.toLowerCase());
    const matches = (await this.chain.trends()).filter((t) => baseOf(t.identifier) === base);
    const live = matches.filter((t) => t.status !== "Retired");
    return (live.length > 0 ? live : matches).sort((a, b) => b.createdAt - a.createdAt)[0] ?? null;
  }

  async attention(trendId: Hex, sinceSec: number, untilSec?: number): Promise<Point[]> {
    return this.history.points(trendId, sinceSec, untilSec);
  }

  async netflow(identifier: string, sinceSec: number): Promise<Point[]> {
    const rows = await this.sql<{ value: number; observed_at: Date }[]>`
      SELECT value, observed_at FROM measurements
       WHERE identifier = ${baseOf(identifier)} AND source = 'nansen' AND observed_at >= to_timestamp(${sinceSec})
       ORDER BY observed_at`;
    return rows.map((r) => ({ t: Math.floor(r.observed_at.getTime() / 1000), v: r.value }));
  }

  async candles(market: PerplMarket, fromSec: number, toSec: number): Promise<{ candles: Candle[]; resolutionSec: number }> {
    // Five-minute candles for up to about a month, coarser beyond, about ten requests at most.
    const span = toSec - fromSec;
    const resolutionSec = [300, 900, 3600].find((r) => span / r <= CANDLES_PER_REQUEST * 10) ?? 3600;
    // Pages sit on a fixed grid, so backtests of any length and start share them.
    const pageSec = resolutionSec * CANDLES_PER_REQUEST;
    const pages: Promise<Candle[]>[] = [];
    for (let p = Math.floor(fromSec / pageSec); p * pageSec < toSec; p++) pages.push(this.candlePage(market, resolutionSec, p * pageSec, (p + 1) * pageSec));
    const seen = new Set<number>();
    const candles = (await Promise.all(pages))
      .flat()
      .filter((c) => c.t >= fromSec && c.t <= toSec && !seen.has(c.t) && seen.add(c.t))
      .sort((a, b) => a.t - b.t);
    return { candles, resolutionSec };
  }

  /** One page of candles, shared by every caller while it is fresh; a failed read is not kept. */
  private candlePage(market: PerplMarket, resolutionSec: number, startSec: number, endSec: number): Promise<Candle[]> {
    const key = `${market.id}:${resolutionSec}:${startSec}`;
    const now = this.now();
    const hit = this.candlePages.get(key);
    if (hit && hit.expires > now) return hit.value;
    for (const [k, v] of this.candlePages) if (v.expires <= now) this.candlePages.delete(k);
    // Perpl refuses a range that ends in the future (HTTP 400): the page still filling in is read up to now.
    const value = fetchCandles(this.perpl, market, resolutionSec, startSec, Math.min(endSec, Math.floor(now / 1000)), this.fetchImpl as typeof fetch).then((page) =>
      page.map((c) => ({ t: c.t, o: c.o, h: c.h, l: c.l, c: c.c })),
    );
    const entry = { expires: now + (endSec * 1000 > now ? LIVE_CANDLE_PAGE_MS : PAST_CANDLE_PAGE_MS), value };
    this.candlePages.set(key, entry);
    value.catch(() => {
      if (this.candlePages.get(key) === entry) this.candlePages.delete(key);
    });
    return value;
  }

  /** Replays `rule` over the last `days` days. */
  async backtest(rule: Rule, days: number, nowSec = Math.floor(Date.now() / 1000)): Promise<BacktestResult & { trendId: Hex | null; resolutionSec: number }> {
    const market = await this.market(rule.market);
    if (!market) throw new Error(`Perpl has no open ${rule.market} market on this network`);
    const from = nowSec - Math.min(days, MAX_BACKTEST_DAYS) * 86_400;
    const trend = await this.trendFor(rule.trend);
    // Index history from before the window lets the first candles see a full lookback.
    const lookback = rule.entry.windowMin * 60;
    const [attention, netflow, priced] = await Promise.all([
      trend ? this.attention(trend.id, from - lookback, nowSec) : Promise.resolve([]),
      this.netflow(rule.trend, from - 86_400),
      this.candles(market, from, nowSec),
    ]);
    const result = backtest({
      rule,
      candles: priced.candles,
      resolutionSec: priced.resolutionSec,
      attention,
      netflow,
      feeBps: this.opts.takerFeeBps,
      slippageBps: this.opts.slippageBps,
    });
    if (!trend) result.warnings.unshift(`no trend ${rule.trend} is listed yet`);
    return { ...result, trendId: trend?.id ?? null, resolutionSec: priced.resolutionSec };
  }
}
