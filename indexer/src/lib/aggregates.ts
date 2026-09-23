import type {
  Account,
  AccountDayData,
  AccountStats,
  EvmOnEventContext,
  Protocol,
  TrendAccount,
  TrendDayData,
  TrendStats,
} from "envio";
import { PROTOCOL_ID, ZERO_ADDRESS, isBotWallet, isInfrastructure } from "./constants";
import { ausd, dayStart, ratio, ZERO_DECIMAL } from "./units";

export type Context = EvmOnEventContext;

/** Trading products, each with its own volume column. */
export type Product = "outcomeMint" | "outcomeSpot" | "perp" | "curve" | "coinSpot" | "perpl";

/** Products whose realized PnL is reported separately in AccountStats. */
export type PnlProduct = "outcome" | "perp" | "curve" | "perpl";

const VOLUME_FIELD = {
  outcomeMint: "outcomeMintVolume",
  outcomeSpot: "outcomeSpotVolume",
  perp: "perpVolume",
  curve: "curveVolume",
  coinSpot: "coinSpotVolume",
  perpl: "perplVolume",
} as const;

const PNL_FIELD = {
  outcome: "outcomeRealizedPnl",
  perp: "perpRealizedPnl",
  curve: "curveRealizedPnl",
  perpl: "perplRealizedPnl",
} as const;

// ---------------------------------------------------------------------------------------------
// Protocol
// ---------------------------------------------------------------------------------------------

export async function loadProtocol(context: Context, timestamp: bigint): Promise<Protocol> {
  return context.Protocol.getOrCreate({
    id: PROTOCOL_ID,
    trendCount: 0,
    seriesCount: 0,
    kuruMarketCount: 0,
    curveCount: 0,
    graduationCount: 0,
    traderCount: 0,
    passkeyAccountCount: 0,
    perpOpenPositionCount: 0,
    outcomeMintVolume: 0n,
    outcomeSpotVolume: 0n,
    perpVolume: 0n,
    curveVolume: 0n,
    coinSpotVolume: 0n,
    perplVolume: 0n,
    volume: 0n,
    volumeAusd: ZERO_DECIMAL,
    tradeCount: 0,
    curationAccrued: 0n,
    curationClaimed: 0n,
    perpPoolDeposits: 0n,
    lastOracleRunId: undefined,
    lastOracleObservedAt: undefined,
    updatedAt: timestamp,
  });
}

/** Applies `change` to the Protocol row. */
export async function updateProtocol(
  context: Context,
  timestamp: bigint,
  change: (p: Protocol) => Partial<Protocol>,
): Promise<void> {
  const p = await loadProtocol(context, timestamp);
  context.Protocol.set({ ...p, ...change(p), updatedAt: timestamp });
}

// ---------------------------------------------------------------------------------------------
// Accounts
// ---------------------------------------------------------------------------------------------

/** True for addresses that never count as traders or holders. */
export function isProtocolAddress(chainId: number, address: string): boolean {
  return address === ZERO_ADDRESS || isInfrastructure(chainId, address);
}

export async function loadAccount(context: Context, address: string, timestamp: bigint): Promise<Account> {
  const chainId = context.chain.id;
  return context.Account.getOrCreate({
    id: address,
    kind: isProtocolAddress(chainId, address) ? "PROTOCOL" : isBotWallet(chainId, address) ? "BOT" : "USER",
    isPasskey: false,
    passkeyOwnerX: undefined,
    passkeyOwnerY: undefined,
    passkeyInitializedAt: undefined,
    firstSeenAt: timestamp,
    lastActiveAt: timestamp,
    outcomeHoldingCount: 0,
    outcomeTokensHeld: 0n,
    coinHoldingCount: 0,
    perpOpenPositionCount: 0,
    perpMarginLocked: 0n,
    perpOpenNotional: 0n,
    perplOpenPositionCount: 0,
    perplCollateral: 0n,
    curationClaimable: 0n,
    stats_id: undefined,
    perplAccount_id: undefined,
  });
}

/** Applies `change` to an account, creating it first if needed, and marks it active. */
export async function updateAccount(
  context: Context,
  address: string,
  timestamp: bigint,
  change: (a: Account) => Partial<Account>,
): Promise<Account> {
  const a = await loadAccount(context, address, timestamp);
  const next = { ...a, ...change(a), lastActiveAt: timestamp > a.lastActiveAt ? timestamp : a.lastActiveAt };
  context.Account.set(next);
  return next;
}

function newStats(address: string, timestamp: bigint): AccountStats {
  return {
    id: address,
    account_id: address,
    outcomeMintVolume: 0n,
    outcomeSpotVolume: 0n,
    perpVolume: 0n,
    curveVolume: 0n,
    coinSpotVolume: 0n,
    perplVolume: 0n,
    volume: 0n,
    volumeAusd: ZERO_DECIMAL,
    tradeCount: 0,
    realizedPnl: 0n,
    realizedPnlAusd: ZERO_DECIMAL,
    outcomeRealizedPnl: 0n,
    perpRealizedPnl: 0n,
    curveRealizedPnl: 0n,
    perplRealizedPnl: 0n,
    feesPaid: 0n,
    closedTrades: 0,
    wins: 0,
    losses: 0,
    winRate: ZERO_DECIMAL,
    bestTrade: undefined,
    worstTrade: undefined,
    liquidations: 0,
    firstTradeAt: timestamp,
    lastTradeAt: timestamp,
  };
}

/** Loads an account's track record, creating the account, the record and the trader count. */
async function loadStats(context: Context, address: string, timestamp: bigint): Promise<AccountStats> {
  const existing = await context.AccountStats.get(address);
  if (existing) return existing;
  const stats = newStats(address, timestamp);
  context.AccountStats.set(stats);
  await updateAccount(context, address, timestamp, () => ({ stats_id: address }));
  await updateProtocol(context, timestamp, (p) => ({ traderCount: p.traderCount + 1 }));
  return stats;
}

async function updateStats(
  context: Context,
  address: string,
  timestamp: bigint,
  change: (s: AccountStats) => Partial<AccountStats>,
): Promise<void> {
  const s = await loadStats(context, address, timestamp);
  context.AccountStats.set({ ...s, ...change(s) });
}

async function updateAccountDay(
  context: Context,
  address: string,
  timestamp: bigint,
  change: (d: AccountDayData) => Partial<AccountDayData>,
): Promise<void> {
  const date = dayStart(timestamp);
  const d = await context.AccountDayData.getOrCreate({
    id: `${address}-${date}`,
    account_id: address,
    date,
    volume: 0n,
    tradeCount: 0,
    realizedPnl: 0n,
    wins: 0,
    losses: 0,
  });
  context.AccountDayData.set({ ...d, ...change(d) });
}

async function updateTrendAccount(
  context: Context,
  trendId: string,
  address: string,
  timestamp: bigint,
  change: (t: TrendAccount) => Partial<TrendAccount>,
): Promise<TrendAccount> {
  const t = await context.TrendAccount.getOrCreate({
    id: `${trendId}-${address}`,
    trend_id: trendId,
    account_id: address,
    heldTokenCount: 0,
    volume: 0n,
    tradeCount: 0,
    realizedPnl: 0n,
    firstTradeAt: undefined,
    lastTradeAt: undefined,
  });
  const next = { ...t, ...change(t) };
  context.TrendAccount.set(next);
  return next;
}

/** Whether `address` takes part in track records (not a protocol contract). */
export function isTrader(context: Context, address: string): boolean {
  return !isProtocolAddress(context.chain.id, address);
}

export interface AccountVolume {
  account: string;
  trendId?: string;
  product: Product;
  /** AUSD, 6 decimals. */
  amount: bigint;
  timestamp: bigint;
}

/** Books one trade of `account`: volume, trade count and per-trend participation. */
export async function recordAccountTrade(context: Context, v: AccountVolume): Promise<void> {
  if (!isTrader(context, v.account)) return;
  const field = VOLUME_FIELD[v.product];
  await updateStats(context, v.account, v.timestamp, (s) => {
    const volume = s.volume + v.amount;
    return {
      [field]: s[field] + v.amount,
      volume,
      volumeAusd: ausd(volume),
      tradeCount: s.tradeCount + 1,
      lastTradeAt: v.timestamp,
    };
  });
  await updateAccount(context, v.account, v.timestamp, () => ({}));
  await updateAccountDay(context, v.account, v.timestamp, (d) => ({
    volume: d.volume + v.amount,
    tradeCount: d.tradeCount + 1,
  }));
  if (v.trendId) {
    const trendId = v.trendId;
    const before = await updateTrendAccount(context, trendId, v.account, v.timestamp, (t) => ({
      volume: t.volume + v.amount,
      tradeCount: t.tradeCount + 1,
      firstTradeAt: t.firstTradeAt ?? v.timestamp,
      lastTradeAt: v.timestamp,
    }));
    if (before.tradeCount === 1) {
      await updateTrendStats(context, trendId, v.timestamp, (s) => ({ traderCount: s.traderCount + 1 }));
    }
  }
}

export interface Realized {
  account: string;
  trendId?: string;
  product: PnlProduct;
  /** Signed AUSD, 6 decimals. */
  pnl: bigint;
  timestamp: bigint;
}

/** Adds realized PnL to an account's record (and its per-trend row). */
export async function recordRealizedPnl(context: Context, r: Realized): Promise<void> {
  if (r.pnl === 0n || !isTrader(context, r.account)) return;
  const field = PNL_FIELD[r.product];
  await updateStats(context, r.account, r.timestamp, (s) => {
    const realizedPnl = s.realizedPnl + r.pnl;
    return { [field]: s[field] + r.pnl, realizedPnl, realizedPnlAusd: ausd(realizedPnl) };
  });
  await updateAccountDay(context, r.account, r.timestamp, (d) => ({ realizedPnl: d.realizedPnl + r.pnl }));
  if (r.trendId) {
    await updateTrendAccount(context, r.trendId, r.account, r.timestamp, (t) => ({
      realizedPnl: t.realizedPnl + r.pnl,
    }));
  }
}

/** Counts one finished round trip with its total PnL as a win, a loss or neither. */
export async function recordClosedTrade(
  context: Context,
  account: string,
  pnl: bigint,
  timestamp: bigint,
  liquidated = false,
): Promise<void> {
  if (!isTrader(context, account)) return;
  const win = pnl > 0n ? 1 : 0;
  const loss = pnl < 0n ? 1 : 0;
  await updateStats(context, account, timestamp, (s) => {
    const closedTrades = s.closedTrades + 1;
    const wins = s.wins + win;
    return {
      closedTrades,
      wins,
      losses: s.losses + loss,
      winRate: ratio(BigInt(wins), BigInt(closedTrades), 6),
      bestTrade: s.bestTrade === undefined || pnl > s.bestTrade ? pnl : s.bestTrade,
      worstTrade: s.worstTrade === undefined || pnl < s.worstTrade ? pnl : s.worstTrade,
      liquidations: s.liquidations + (liquidated ? 1 : 0),
    };
  });
  await updateAccountDay(context, account, timestamp, (d) => ({ wins: d.wins + win, losses: d.losses + loss }));
}

export async function recordFees(context: Context, account: string, fee: bigint, timestamp: bigint): Promise<void> {
  if (fee === 0n || !isTrader(context, account)) return;
  await updateStats(context, account, timestamp, (s) => ({ feesPaid: s.feesPaid + fee }));
}

// ---------------------------------------------------------------------------------------------
// Trends
// ---------------------------------------------------------------------------------------------

export function newTrendStats(trendId: string, timestamp: bigint): TrendStats {
  return {
    id: trendId,
    trend_id: trendId,
    outcomeMintVolume: 0n,
    outcomeSpotVolume: 0n,
    perpVolume: 0n,
    curveVolume: 0n,
    coinSpotVolume: 0n,
    volume: 0n,
    volumeAusd: ZERO_DECIMAL,
    tradeCount: 0,
    traderCount: 0,
    holderCount: 0,
    seriesCount: 0,
    perpLongQty: 0n,
    perpShortQty: 0n,
    perpLongOpenInterest: 0n,
    perpShortOpenInterest: 0n,
    perpLongOpenInterestAusd: ZERO_DECIMAL,
    perpShortOpenInterestAusd: ZERO_DECIMAL,
    perpOpenPositionCount: 0,
    perpMark: undefined,
    perpFundingRatePerBlock: 0n,
    curationEarned: 0n,
    curationEarnedAusd: ZERO_DECIMAL,
    updatedAt: timestamp,
  };
}

export async function loadTrendStats(context: Context, trendId: string, timestamp: bigint): Promise<TrendStats> {
  return context.TrendStats.getOrCreate(newTrendStats(trendId, timestamp));
}

export async function updateTrendStats(
  context: Context,
  trendId: string,
  timestamp: bigint,
  change: (s: TrendStats) => Partial<TrendStats>,
): Promise<TrendStats> {
  const s = await loadTrendStats(context, trendId, timestamp);
  const next = { ...s, ...change(s), updatedAt: timestamp };
  context.TrendStats.set(next);
  return next;
}

export async function updateTrendDay(
  context: Context,
  trendId: string,
  timestamp: bigint,
  change: (d: TrendDayData) => Partial<TrendDayData>,
): Promise<void> {
  const date = dayStart(timestamp);
  const id = `${trendId}-${date}`;
  let d = await context.TrendDayData.get(id);
  if (!d) {
    // A new day starts from the open interest carried over from the previous update.
    const stats = await loadTrendStats(context, trendId, timestamp);
    d = {
      id,
      trend_id: trendId,
      date,
      outcomeMintVolume: 0n,
      outcomeSpotVolume: 0n,
      perpVolume: 0n,
      curveVolume: 0n,
      coinSpotVolume: 0n,
      volume: 0n,
      volumeAusd: ZERO_DECIMAL,
      tradeCount: 0,
      indexOpen: undefined,
      indexHigh: undefined,
      indexLow: undefined,
      indexClose: undefined,
      perpLongOpenInterest: stats.perpLongOpenInterest,
      perpShortOpenInterest: stats.perpShortOpenInterest,
      fundingMarkCount: 0,
      curationEarned: 0n,
    };
  }
  context.TrendDayData.set({ ...d, ...change(d) });
}

export interface MarketVolume {
  trendId?: string;
  product: Product;
  amount: bigint;
  timestamp: bigint;
}

/** Books one trade's volume once for the market side: protocol, trend and trend day. */
export async function recordMarketVolume(context: Context, v: MarketVolume): Promise<void> {
  const field = VOLUME_FIELD[v.product];
  await updateProtocol(context, v.timestamp, (p) => {
    const volume = p.volume + v.amount;
    return { [field]: p[field] + v.amount, volume, volumeAusd: ausd(volume), tradeCount: p.tradeCount + 1 };
  });
  if (!v.trendId || field === "perplVolume") return;
  const trendField = field;
  await updateTrendStats(context, v.trendId, v.timestamp, (s) => {
    const volume = s.volume + v.amount;
    return { [trendField]: s[trendField] + v.amount, volume, volumeAusd: ausd(volume), tradeCount: s.tradeCount + 1 };
  });
  await updateTrendDay(context, v.trendId, v.timestamp, (d) => {
    const volume = d.volume + v.amount;
    return { [trendField]: d[trendField] + v.amount, volume, volumeAusd: ausd(volume), tradeCount: d.tradeCount + 1 };
  });
}
