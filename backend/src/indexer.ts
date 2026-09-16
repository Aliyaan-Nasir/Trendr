import type { Sql } from "./db";

/**
 * Reads the Envio indexer's tables (its own Postgres schema, see indexer/README.md): track
 * records, the trader leaderboard, an account's trade history across products, and per-trend
 * volume, open interest and holders. Live balances come from the chain; this is the history.
 */

export interface AccountSummary {
  address: string;
  kind: string;
  isPasskey: boolean;
  firstSeenAt: number;
  lastActiveAt: number;
  outcomeHoldingCount: number;
  coinHoldingCount: number;
  perpOpenPositionCount: number;
  perplOpenPositionCount: number;
  curationClaimableAusd: number;
  stats: {
    volumeAusd: number;
    realizedPnlAusd: number;
    perProduct: { outcome: number; perp: number; coin: number; perpl: number };
    feesPaidAusd: number;
    tradeCount: number;
    closedTrades: number;
    wins: number;
    losses: number;
    winRate: number;
    bestTradeAusd: number | null;
    worstTradeAusd: number | null;
    liquidations: number;
  } | null;
}

export interface Activity {
  kind: "perp" | "coin" | "outcome" | "perpl";
  identifier: string | null;
  label: string;
  side: string;
  status: string;
  amountAusd: number | null;
  pnlAusd: number | null;
  /** Attention perps only: entry and exit index points, and leverage at open. */
  entry: number | null;
  exit: number | null;
  leverage: number | null;
  at: number;
  tx: string | null;
}

/**
 * A series the account holds UP or DOWN tokens of, as indexed. Balances are the indexer's view
 * (raw, 6 decimals) and may trail the chain by a few blocks; the app reads live balances on chain.
 */
export interface OutcomeHoldingRow {
  seriesId: string;
  trendId: string;
  identifier: string | null;
  /** The OutcomeMarkets contract that issued the series. */
  outcomeMarkets: string;
  window: number;
  openedAt: number;
  expiry: number;
  /** Points. */
  openingIndex: number;
  outcome: "open" | "up" | "down" | "void";
  /** Points, once settled on chain. */
  settlementIndex: number | null;
  up: string;
  down: string;
  upMarket: string | null;
  downMarket: string | null;
  upBalance: string;
  downBalance: string;
  /**
   * The indexer's book of each side at average cost (raw, 6 decimals): tokens it counts as the
   * account's position (Kuru-resting ones included), their AUSD cost, the AUSD realized so far,
   * and the block time of the last trade it applied (seconds).
   */
  upPosition: string;
  downPosition: string;
  upCostBasis: string;
  downCostBasis: string;
  upRealizedPnl: string;
  downRealizedPnl: string;
  upUpdatedAt: number;
  downUpdatedAt: number;
}

export interface TraderRow {
  address: string;
  realizedPnlAusd: number;
  volumeAusd: number;
  closedTrades: number;
  wins: number;
  losses: number;
  winRate: number;
}

export interface TrendStats {
  volumeAusd: number;
  volume24hAusd: number;
  tradeCount: number;
  traderCount: number;
  holderCount: number;
  perpLongOpenInterestAusd: number;
  perpShortOpenInterestAusd: number;
  perpOpenPositionCount: number;
  curationEarnedAusd: number;
  days: Array<{ date: number; volumeAusd: number; tradeCount: number; indexOpen: number | null; indexHigh: number | null; indexLow: number | null; indexClose: number | null }>;
}

/** Envio's progress on this chain: blocks processed against the newest block its source reported. */
export interface IndexerProgress {
  progressBlock: number;
  sourceBlock: number;
  startBlock: number;
  eventsProcessed: number;
  /** The processed block's time (ms). */
  progressBlockAt: number | null;
  /** When the indexer first caught up with the head (ms). */
  readyAt: number | null;
}

export interface IndexedOracle {
  /** The newest CRE report the indexer recorded: what it created, updated and settled (`at`: block time, seconds). */
  lastRun: { runId: number; created: number; updated: number; settled: number; rejected: number; at: number } | null;
  /** Block time (seconds) of the newest Up/Down series settlement. */
  lastSettlementAt: number | null;
  settlements24h: number;
}

const AUSD = 1e6;
const POINTS = 1e6;
const num = (v: unknown) => (v === null || v === undefined ? 0 : Number(v));
const ausd = (raw: unknown) => num(raw) / AUSD;
const maybe = (raw: unknown, scale: number) => (raw === null || raw === undefined ? null : Number(raw) / scale);

export class IndexerReader {
  private readonly t: (name: string) => string;

  constructor(
    private readonly sql: Sql,
    private readonly chainId: number,
    schema = "indexer",
  ) {
    if (!/^[a-z_][a-z0-9_]*$/.test(schema)) throw new Error("INDEXER_SCHEMA must be a plain identifier");
    this.t = (name) => `${schema}."${name}"`;
  }

  /** Whether the indexer has caught up far enough to answer (its tables exist and hold trends). */
  async ready(): Promise<boolean> {
    try {
      const rows = await this.sql.unsafe(`SELECT 1 FROM ${this.t("Trend")} WHERE chain_id = $1 LIMIT 1`, [this.chainId]);
      return rows.length > 0;
    } catch {
      return false;
    }
  }

  /** How far the indexer has processed the chain (Envio's own progress row), or null before it starts. */
  async progress(): Promise<IndexerProgress | null> {
    const rows = await this.sql.unsafe(
      `SELECT progress_block, source_block, events_processed, progress_block_time, ready_at, start_block FROM ${this.t("envio_chains")} WHERE id = $1`,
      [this.chainId],
    );
    const r = rows[0];
    if (!r) return null;
    const time = (v: unknown) => (v === null || v === undefined ? null : new Date(v as string | Date).getTime());
    return {
      progressBlock: num(r.progress_block),
      sourceBlock: num(r.source_block),
      startBlock: num(r.start_block),
      eventsProcessed: num(r.events_processed),
      progressBlockAt: time(r.progress_block_time),
      readyAt: time(r.ready_at),
    };
  }

  /** The newest oracle run the indexer saw and the newest series settlement, for health. */
  async oracle(nowSec = Math.floor(Date.now() / 1000)): Promise<IndexedOracle> {
    const [runs, settlements] = await Promise.all([
      this.sql.unsafe(
        `SELECT run_id, created, updated, settled, rejected, timestamp FROM ${this.t("OracleRun")} WHERE chain_id = $1 ORDER BY run_id DESC LIMIT 1`,
        [this.chainId],
      ),
      this.sql.unsafe(
        `SELECT MAX(timestamp) AS last, COUNT(*) FILTER (WHERE timestamp >= $2) AS day FROM ${this.t("Settlement")} WHERE chain_id = $1`,
        [this.chainId, nowSec - 86_400],
      ),
    ]);
    const run = runs[0];
    const s = settlements[0];
    return {
      lastRun: run ? { runId: num(run.run_id), created: num(run.created), updated: num(run.updated), settled: num(run.settled), rejected: num(run.rejected), at: num(run.timestamp) } : null,
      lastSettlementAt: s?.last === null || s?.last === undefined ? null : num(s.last),
      settlements24h: num(s?.day),
    };
  }

  async account(address: string): Promise<AccountSummary | null> {
    const rows = await this.sql.unsafe(
      `SELECT a.id, a.kind, a.is_passkey, a.first_seen_at, a.last_active_at, a.outcome_holding_count, a.coin_holding_count,
              a.perp_open_position_count, a.perpl_open_position_count, a.curation_claimable,
              s.id AS has_stats, s.volume, s.realized_pnl, s.outcome_realized_pnl, s.perp_realized_pnl, s.curve_realized_pnl,
              s.perpl_realized_pnl, s.fees_paid, s.trade_count, s.closed_trades, s.wins, s.losses, s.win_rate, s.best_trade,
              s.worst_trade, s.liquidations
         FROM ${this.t("Account")} a LEFT JOIN ${this.t("AccountStats")} s ON s.id = a.id AND s.chain_id = a.chain_id
        WHERE a.chain_id = $1 AND a.id = $2`,
      [this.chainId, address.toLowerCase()],
    );
    const r = rows[0];
    if (!r) return null;
    return {
      address: r.id,
      kind: r.kind,
      isPasskey: r.is_passkey,
      firstSeenAt: num(r.first_seen_at),
      lastActiveAt: num(r.last_active_at),
      outcomeHoldingCount: num(r.outcome_holding_count),
      coinHoldingCount: num(r.coin_holding_count),
      perpOpenPositionCount: num(r.perp_open_position_count),
      perplOpenPositionCount: num(r.perpl_open_position_count),
      curationClaimableAusd: ausd(r.curation_claimable),
      stats: r.has_stats
        ? {
            volumeAusd: ausd(r.volume),
            realizedPnlAusd: ausd(r.realized_pnl),
            perProduct: { outcome: ausd(r.outcome_realized_pnl), perp: ausd(r.perp_realized_pnl), coin: ausd(r.curve_realized_pnl), perpl: ausd(r.perpl_realized_pnl) },
            feesPaidAusd: ausd(r.fees_paid),
            tradeCount: num(r.trade_count),
            closedTrades: num(r.closed_trades),
            wins: num(r.wins),
            losses: num(r.losses),
            winRate: num(r.win_rate),
            bestTradeAusd: maybe(r.best_trade, AUSD),
            worstTradeAusd: maybe(r.worst_trade, AUSD),
            liquidations: num(r.liquidations),
          }
        : null,
    };
  }

  /** The newest trades of `address` across attention perps, coins, Kuru swaps and Perpl. */
  async activity(address: string, limit = 50): Promise<Activity[]> {
    const a = address.toLowerCase();
    const rows = await this.sql.unsafe(
      `SELECT * FROM (
         SELECT 'perp' AS kind, t.identifier, CASE WHEN p.is_long THEN 'long' ELSE 'short' END AS side, lower(p.status::text) AS status,
                p.margin AS amount, p.realized_pnl AS pnl, COALESCE(p.closed_at, p.opened_at) AS at, COALESCE(p.close_tx_hash, p.open_tx_hash) AS tx, NULL AS label,
                p.entry_index AS entry, p.exit_index AS exit, CASE WHEN p.margin - COALESCE(p.margin_added, 0) > 0 THEN p.notional / (p.margin - COALESCE(p.margin_added, 0)) END AS leverage
           FROM ${this.t("PerpPosition")} p JOIN ${this.t("Trend")} t ON t.id = p.trend_id AND t.chain_id = p.chain_id
          WHERE p.chain_id = $1 AND p.owner_id = $2
         UNION ALL
         SELECT 'coin', t.identifier, CASE WHEN c.is_buy THEN 'buy' ELSE 'sell' END, 'filled', c.quote_amount, NULL, c.timestamp, c.tx_hash, NULL, NULL, NULL, NULL
           FROM ${this.t("CurveTrade")} c JOIN ${this.t("Trend")} t ON t.id = c.trend_id AND t.chain_id = c.chain_id
          WHERE c.chain_id = $1 AND c.trader_id = $2
         UNION ALL
         SELECT CASE WHEN k.kind::text = 'TREND_COIN' THEN 'coin' ELSE 'outcome' END, t.identifier,
                CASE WHEN s.is_buy THEN 'buy' ELSE 'sell' END || CASE WHEN k.kind::text = 'UP' THEN ' up' WHEN k.kind::text = 'DOWN' THEN ' down' ELSE '' END,
                'filled', s.quote_amount, NULL, s.timestamp, s.tx_hash, NULL, NULL, NULL, NULL
           FROM ${this.t("SpotSwap")} s
           JOIN ${this.t("Token")} k ON k.id = s.token_id AND k.chain_id = s.chain_id
           LEFT JOIN ${this.t("Trend")} t ON t.id = s.trend_id AND t.chain_id = s.chain_id
          WHERE s.chain_id = $1 AND s.trader_id = $2
         UNION ALL
         SELECT 'perpl', NULL, CASE WHEN q.is_long THEN 'long' ELSE 'short' END, lower(q.status::text),
                q.deposit_cns, CASE WHEN q.status::text = 'OPEN' THEN NULL ELSE q.realized_pnl_cns END, COALESCE(q.closed_at, q.opened_at),
                COALESCE(q.close_tx_hash, q.open_tx_hash), m.symbol, NULL, NULL, NULL
           FROM ${this.t("PerplPosition")} q JOIN ${this.t("PerplMarket")} m ON m.id = q.market_id AND m.chain_id = q.chain_id
          WHERE q.chain_id = $1 AND q.owner_id = $2
       ) x ORDER BY at DESC NULLS LAST LIMIT $3`,
      [this.chainId, a, limit],
    );
    return rows.map((r) => ({
      kind: r.kind,
      identifier: r.identifier ?? null,
      label: r.label ?? r.identifier ?? "",
      side: r.side,
      status: r.status,
      amountAusd: r.amount === null ? null : ausd(r.amount),
      pnlAusd: r.pnl === null ? null : ausd(r.pnl),
      entry: maybe(r.entry, POINTS),
      exit: maybe(r.exit, POINTS),
      leverage: r.leverage === null || r.leverage === undefined ? null : Number(r.leverage),
      at: num(r.at),
      tx: r.tx ?? null,
    }));
  }

  /**
   * Every series `address` holds outcome tokens of, newest expiry first, including old ones the
   * chain's lens no longer lists (a settled series with winnings to redeem).
   */
  async outcomeHoldings(address: string, limit = 200): Promise<OutcomeHoldingRow[]> {
    const rows = await this.sql.unsafe(
      `WITH held AS (
         SELECT series_id,
                COALESCE(sum(balance) FILTER (WHERE side::text = 'UP'), 0) AS up_balance,
                COALESCE(sum(balance) FILTER (WHERE side::text = 'DOWN'), 0) AS down_balance,
                COALESCE(sum(position) FILTER (WHERE side::text = 'UP'), 0) AS up_position,
                COALESCE(sum(position) FILTER (WHERE side::text = 'DOWN'), 0) AS down_position,
                COALESCE(sum(cost_basis) FILTER (WHERE side::text = 'UP'), 0) AS up_cost_basis,
                COALESCE(sum(cost_basis) FILTER (WHERE side::text = 'DOWN'), 0) AS down_cost_basis,
                COALESCE(sum(realized_pnl) FILTER (WHERE side::text = 'UP'), 0) AS up_realized_pnl,
                COALESCE(sum(realized_pnl) FILTER (WHERE side::text = 'DOWN'), 0) AS down_realized_pnl,
                COALESCE(max(updated_at) FILTER (WHERE side::text = 'UP'), 0) AS up_updated_at,
                COALESCE(max(updated_at) FILTER (WHERE side::text = 'DOWN'), 0) AS down_updated_at
           FROM ${this.t("OutcomeTokenBalance")}
          WHERE chain_id = $1 AND account_id = $2 AND balance > 0
          GROUP BY series_id)
       SELECT s.id, s.trend_id, t.identifier, s.outcome_markets, s.window, s.opened_at, s.expiry, s.opening_index, s.outcome::text AS outcome,
              s.settlement_index, s.up_token_id, s.down_token_id, s.up_market_id, s.down_market_id, h.up_balance, h.down_balance,
              h.up_position, h.down_position, h.up_cost_basis, h.down_cost_basis, h.up_realized_pnl, h.down_realized_pnl, h.up_updated_at, h.down_updated_at
         FROM held h
         JOIN ${this.t("Series")} s ON s.id = h.series_id AND s.chain_id = $1
         LEFT JOIN ${this.t("Trend")} t ON t.id = s.trend_id AND t.chain_id = s.chain_id
        ORDER BY s.expiry DESC, s.id LIMIT $3`,
      [this.chainId, address.toLowerCase(), limit],
    );
    return rows.map((r) => ({
      seriesId: r.id,
      trendId: r.trend_id,
      identifier: r.identifier ?? null,
      outcomeMarkets: r.outcome_markets,
      window: num(r.window),
      openedAt: num(r.opened_at),
      expiry: num(r.expiry),
      openingIndex: num(r.opening_index) / POINTS,
      outcome: String(r.outcome).toLowerCase() as OutcomeHoldingRow["outcome"],
      settlementIndex: maybe(r.settlement_index, POINTS),
      up: r.up_token_id,
      down: r.down_token_id,
      upMarket: r.up_market_id ?? null,
      downMarket: r.down_market_id ?? null,
      upBalance: BigInt(r.up_balance).toString(),
      downBalance: BigInt(r.down_balance).toString(),
      upPosition: BigInt(r.up_position).toString(),
      downPosition: BigInt(r.down_position).toString(),
      upCostBasis: BigInt(r.up_cost_basis).toString(),
      downCostBasis: BigInt(r.down_cost_basis).toString(),
      upRealizedPnl: BigInt(r.up_realized_pnl).toString(),
      downRealizedPnl: BigInt(r.down_realized_pnl).toString(),
      upUpdatedAt: num(r.up_updated_at),
      downUpdatedAt: num(r.down_updated_at),
    }));
  }

  /** Traders ranked by realized PnL: people only, Trendr's own bots and protocol addresses excluded. */
  async traders(limit = 50): Promise<TraderRow[]> {
    const rows = await this.sql.unsafe(
      `SELECT s.id, s.realized_pnl, s.volume, s.closed_trades, s.wins, s.losses, s.win_rate
         FROM ${this.t("AccountStats")} s JOIN ${this.t("Account")} a ON a.id = s.id AND a.chain_id = s.chain_id
        WHERE s.chain_id = $1 AND a.kind::text IN ('USER', 'PASSKEY') AND s.closed_trades > 0
        ORDER BY s.realized_pnl DESC, s.volume DESC LIMIT $2`,
      [this.chainId, limit],
    );
    return rows.map((r) => ({ address: r.id, realizedPnlAusd: ausd(r.realized_pnl), volumeAusd: ausd(r.volume), closedTrades: num(r.closed_trades), wins: num(r.wins), losses: num(r.losses), winRate: num(r.win_rate) }));
  }

  async trend(identifier: string, nowSec = Math.floor(Date.now() / 1000)): Promise<TrendStats | null> {
    const rows = await this.sql.unsafe(
      `SELECT t.id AS trend_id, s.volume, s.trade_count, s.trader_count, s.holder_count, s.perp_long_open_interest, s.perp_short_open_interest,
              s.perp_open_position_count, s.curation_earned
         FROM ${this.t("Trend")} t JOIN ${this.t("TrendStats")} s ON s.trend_id = t.id AND s.chain_id = t.chain_id
        WHERE t.chain_id = $1 AND t.identifier = $2
        ORDER BY t.created_at DESC LIMIT 1`,
      [this.chainId, identifier.toLowerCase()],
    );
    const r = rows[0];
    if (!r) return null;
    const days = await this.sql.unsafe(
      `SELECT date, volume, trade_count, index_open, index_high, index_low, index_close FROM ${this.t("TrendDayData")}
        WHERE chain_id = $1 AND trend_id = $2 ORDER BY date DESC LIMIT 30`,
      [this.chainId, r.trend_id],
    );
    const dayStart = nowSec - (nowSec % 86_400);
    const today = days.find((d) => num(d.date) === dayStart);
    const yesterday = days.find((d) => num(d.date) === dayStart - 86_400);
    // The last 24 hours: today plus the share of yesterday still inside the window.
    const volume24h = ausd(today?.volume) + ausd(yesterday?.volume) * (1 - (nowSec - dayStart) / 86_400);
    return {
      volumeAusd: ausd(r.volume),
      volume24hAusd: volume24h,
      tradeCount: num(r.trade_count),
      traderCount: num(r.trader_count),
      holderCount: num(r.holder_count),
      perpLongOpenInterestAusd: ausd(r.perp_long_open_interest),
      perpShortOpenInterestAusd: ausd(r.perp_short_open_interest),
      perpOpenPositionCount: num(r.perp_open_position_count),
      curationEarnedAusd: ausd(r.curation_earned),
      days: days
        .map((d) => ({
          date: num(d.date),
          volumeAusd: ausd(d.volume),
          tradeCount: num(d.trade_count),
          indexOpen: maybe(d.index_open, POINTS),
          indexHigh: maybe(d.index_high, POINTS),
          indexLow: maybe(d.index_low, POINTS),
          indexClose: maybe(d.index_close, POINTS),
        }))
        .reverse(),
    };
  }
}
