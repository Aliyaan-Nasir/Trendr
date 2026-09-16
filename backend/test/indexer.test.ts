import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Sql } from "../src/db";
import { IndexerReader } from "../src/indexer";
import { testDb } from "./helpers";

/**
 * The indexer reader's SQL against a minimal copy of the Envio tables it reads (same names and
 * columns, enums as text), so a schema drift in the indexer shows up here.
 */

const S = "indexer_test";
const CHAIN = 10143;
const ME = "0x00000000000000000000000000000000000000aa";
const BOT = "0x00000000000000000000000000000000000000bb";
const TREND = "0x01";
const DAY = 1_791_504_000; // a UTC midnight
let sql: Sql;

beforeAll(async () => {
  sql = await testDb();
  await sql.unsafe(`DROP SCHEMA IF EXISTS ${S} CASCADE; CREATE SCHEMA ${S};`);
  await sql.unsafe(`
    CREATE TABLE ${S}."Account" (id text, chain_id int, kind text, is_passkey boolean, first_seen_at numeric, last_active_at numeric, outcome_holding_count int,
      coin_holding_count int, perp_open_position_count int, perpl_open_position_count int, curation_claimable numeric);
    CREATE TABLE ${S}."AccountStats" (id text, chain_id int, volume numeric, realized_pnl numeric, outcome_realized_pnl numeric, perp_realized_pnl numeric,
      curve_realized_pnl numeric, perpl_realized_pnl numeric, fees_paid numeric, trade_count int, closed_trades int, wins int, losses int, win_rate numeric,
      best_trade numeric, worst_trade numeric, liquidations int);
    CREATE TABLE ${S}."Trend" (id text, chain_id int, identifier text, created_at numeric);
    CREATE TABLE ${S}."TrendStats" (trend_id text, chain_id int, volume numeric, trade_count int, trader_count int, holder_count int,
      perp_long_open_interest numeric, perp_short_open_interest numeric, perp_open_position_count int, curation_earned numeric);
    CREATE TABLE ${S}."TrendDayData" (trend_id text, chain_id int, date numeric, volume numeric, trade_count int, index_open numeric, index_high numeric,
      index_low numeric, index_close numeric);
    CREATE TABLE ${S}."PerpPosition" (owner_id text, chain_id int, trend_id text, is_long boolean, status text, margin numeric, margin_added numeric, notional numeric,
      entry_index numeric, exit_index numeric, realized_pnl numeric, opened_at numeric, closed_at numeric, open_tx_hash text, close_tx_hash text);
    CREATE TABLE ${S}."CurveTrade" (trader_id text, chain_id int, trend_id text, is_buy boolean, quote_amount numeric, timestamp numeric, tx_hash text);
    CREATE TABLE ${S}."Token" (id text, chain_id int, kind text);
    CREATE TABLE ${S}."SpotSwap" (trader_id text, chain_id int, token_id text, trend_id text, is_buy boolean, quote_amount numeric, timestamp numeric, tx_hash text);
    CREATE TABLE ${S}."PerplMarket" (id text, chain_id int, symbol text);
    CREATE TABLE ${S}."PerplPosition" (owner_id text, chain_id int, market_id text, is_long boolean, status text, deposit_cns numeric, realized_pnl_cns numeric,
      opened_at numeric, closed_at numeric, open_tx_hash text, close_tx_hash text);
    CREATE TABLE ${S}."Series" (id text, chain_id int, trend_id text, outcome_markets text, "window" int, opened_at numeric, expiry numeric, opening_index numeric,
      outcome text, settlement_index numeric, up_token_id text, down_token_id text, up_market_id text, down_market_id text);
    CREATE TABLE ${S}."OutcomeTokenBalance" (id text, chain_id int, account_id text, token_id text, series_id text, side text, balance numeric, position numeric,
      cost_basis numeric, realized_pnl numeric, updated_at numeric);
  `);
  await sql.unsafe(`
    INSERT INTO ${S}."Account" VALUES ('${ME}', ${CHAIN}, 'PASSKEY', true, 100, 500, 1, 0, 1, 0, 2500000), ('${BOT}', ${CHAIN}, 'BOT', false, 100, 400, 0, 0, 0, 1, 0);
    INSERT INTO ${S}."AccountStats" VALUES ('${ME}', ${CHAIN}, 150000000, 4500000, 1000000, 3000000, 500000, 0, 160000, 6, 3, 2, 1, 0.666, 3000000, -500000, 0),
                                          ('${BOT}', ${CHAIN}, 900000000, 9000000, 0, 0, 0, 9000000, 0, 9, 4, 4, 0, 1, 3000000, 1000000, 0);
    INSERT INTO ${S}."Trend" VALUES ('${TREND}', ${CHAIN}, 'crypto:eth', 10);
    INSERT INTO ${S}."TrendStats" VALUES ('${TREND}', ${CHAIN}, 300000000, 12, 4, 3, 50000000, 20000000, 2, 150000);
    INSERT INTO ${S}."TrendDayData" VALUES ('${TREND}', ${CHAIN}, ${DAY - 86_400}, 100000000, 5, 80000000, 86000000, 79000000, 84000000),
                                           ('${TREND}', ${CHAIN}, ${DAY}, 40000000, 2, 84000000, 85000000, 66000000, 84900000);
    INSERT INTO ${S}."PerpPosition" VALUES ('${ME}', ${CHAIN}, '${TREND}', true, 'CLOSED', 12000000, 2000000, 20000000, 60000000, 69000000, 3000000, 200, 300, '0xa1', '0xa2');
    INSERT INTO ${S}."CurveTrade" VALUES ('${ME}', ${CHAIN}, '${TREND}', true, 5000000, 250, '0xb1');
    INSERT INTO ${S}."Token" VALUES ('0xt1', ${CHAIN}, 'UP');
    INSERT INTO ${S}."SpotSwap" VALUES ('${ME}', ${CHAIN}, '0xt1', '${TREND}', true, 3000000, 400, '0xc1');
    INSERT INTO ${S}."PerplMarket" VALUES ('m32', ${CHAIN}, 'ETH');
    INSERT INTO ${S}."PerplPosition" VALUES ('${ME}', ${CHAIN}, 'm32', false, 'OPEN', 20000000, 0, 450, NULL, '0xd1', NULL);
    -- An old series settled UP that still holds winnings, a live one, one sold out, and someone else's.
    INSERT INTO ${S}."Series" VALUES
      ('0xs1', ${CHAIN}, '${TREND}', '0xom', 86400, 1000, 87400, 60000000, 'UP', 66500000, '0xu1', '0xd1', '0xmu1', '0xmd1'),
      ('0xs2', ${CHAIN}, '${TREND}', '0xom', 3600, 90000, 93600, 70000000, 'OPEN', NULL, '0xu2', '0xd2', NULL, NULL),
      ('0xs3', ${CHAIN}, '${TREND}', '0xom', 3600, 80000, 83600, 70000000, 'DOWN', 61000000, '0xu3', '0xd3', NULL, NULL);
    -- Bought 12.5 UP at 0.40 and 2 DOWN at 0.55 in 0xs1 after selling some DOWN at a loss; 5 DOWN at 0.48 in 0xs2,
    -- 2 of them resting on Kuru (position over balance).
    INSERT INTO ${S}."OutcomeTokenBalance" VALUES
      ('0xu1-me', ${CHAIN}, '${ME}', '0xu1', '0xs1', 'UP', 12500000, 12500000, 5000000, 0, 1100),
      ('0xd1-me', ${CHAIN}, '${ME}', '0xd1', '0xs1', 'DOWN', 2000000, 2000000, 1100000, -300000, 1200),
      ('0xd2-me', ${CHAIN}, '${ME}', '0xd2', '0xs2', 'DOWN', 3000000, 5000000, 2400000, 0, 90500),
      ('0xu3-me', ${CHAIN}, '${ME}', '0xu3', '0xs3', 'UP', 0, 0, 0, 700000, 81000),
      ('0xu1-bot', ${CHAIN}, '${BOT}', '0xu1', '0xs1', 'UP', 9000000, 9000000, 4000000, 0, 1300);
  `);
});
afterAll(async () => {
  await sql.unsafe(`DROP SCHEMA IF EXISTS ${S} CASCADE`);
  await sql.end();
});

describe("IndexerReader", () => {
  const reader = () => new IndexerReader(sql, CHAIN, S);

  test("an account's summary and track record, in AUSD", async () => {
    const a = (await reader().account(ME.toUpperCase().replace("0X", "0x")))!;
    expect(a).toMatchObject({ kind: "PASSKEY", isPasskey: true, perpOpenPositionCount: 1, curationClaimableAusd: 2.5 });
    expect(a.stats).toMatchObject({ volumeAusd: 150, realizedPnlAusd: 4.5, perProduct: { outcome: 1, perp: 3, coin: 0.5, perpl: 0 }, closedTrades: 3, wins: 2, bestTradeAusd: 3, worstTradeAusd: -0.5 });
    expect(await reader().account("0x00000000000000000000000000000000000000cc")).toBeNull();
  });

  test("trade history across products, newest first", async () => {
    const items = await reader().activity(ME);
    expect(items.map((i) => [i.kind, i.side, i.status, i.amountAusd, i.pnlAusd, i.at, i.label])).toEqual([
      ["perpl", "short", "open", 20, null, 450, "ETH"],
      ["outcome", "buy up", "filled", 3, null, 400, "crypto:eth"],
      ["perp", "long", "closed", 12, 3, 300, "crypto:eth"],
      ["coin", "buy", "filled", 5, null, 250, "crypto:eth"],
    ]);
    // A perp carries its entry, exit and opening leverage (notional over the margin it opened with).
    expect(items[2]).toMatchObject({ entry: 60, exit: 69, leverage: 2 });
    expect(items[0]).toMatchObject({ entry: null, exit: null, leverage: null });
  });

  test("every series an account holds tokens of, newest expiry first, settled ones included, with each side's cost book", async () => {
    const rows = await reader().outcomeHoldings(ME.toUpperCase().replace("0X", "0x"));
    expect(rows).toEqual([
      {
        seriesId: "0xs2",
        trendId: TREND,
        identifier: "crypto:eth",
        outcomeMarkets: "0xom",
        window: 3600,
        openedAt: 90000,
        expiry: 93600,
        openingIndex: 70,
        outcome: "open",
        settlementIndex: null,
        up: "0xu2",
        down: "0xd2",
        upMarket: null,
        downMarket: null,
        upBalance: "0",
        downBalance: "3000000",
        upPosition: "0",
        downPosition: "5000000",
        upCostBasis: "0",
        downCostBasis: "2400000",
        upRealizedPnl: "0",
        downRealizedPnl: "0",
        upUpdatedAt: 0,
        downUpdatedAt: 90500,
      },
      {
        seriesId: "0xs1",
        trendId: TREND,
        identifier: "crypto:eth",
        outcomeMarkets: "0xom",
        window: 86400,
        openedAt: 1000,
        expiry: 87400,
        openingIndex: 60,
        outcome: "up",
        settlementIndex: 66.5,
        up: "0xu1",
        down: "0xd1",
        upMarket: "0xmu1",
        downMarket: "0xmd1",
        upBalance: "12500000",
        downBalance: "2000000",
        upPosition: "12500000",
        downPosition: "2000000",
        upCostBasis: "5000000",
        downCostBasis: "1100000",
        upRealizedPnl: "0",
        downRealizedPnl: "-300000",
        upUpdatedAt: 1100,
        downUpdatedAt: 1200,
      },
    ]);
    expect(await reader().outcomeHoldings("0x00000000000000000000000000000000000000cc")).toEqual([]);
  });

  test("the trader leaderboard leaves Trendr's bots out", async () => {
    expect((await reader().traders()).map((t) => [t.address, t.realizedPnlAusd])).toEqual([[ME, 4.5]]);
  });

  test("a trend's volume, open interest and daily candles; 24h volume blends yesterday", async () => {
    const s = (await reader().trend("crypto:eth", DAY + 43_200))!;
    expect(s).toMatchObject({ volumeAusd: 300, tradeCount: 12, holderCount: 3, perpLongOpenInterestAusd: 50, perpShortOpenInterestAusd: 20, curationEarnedAusd: 0.15 });
    // Half of yesterday's 100 is still inside the window, plus today's 40.
    expect(s.volume24hAusd).toBeCloseTo(90, 6);
    expect(s.days.map((d) => [d.date, d.indexLow, d.indexClose])).toEqual([[DAY - 86_400, 79, 84], [DAY, 66, 84.9]]);
    expect(await reader().trend("topic:none")).toBeNull();
  });

  test("refuses a schema name that is not a plain identifier", () => {
    expect(() => new IndexerReader(sql, CHAIN, 'indexer"; DROP TABLE x; --')).toThrow("plain identifier");
  });
});
