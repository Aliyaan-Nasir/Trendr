import { type ActivationTicket, type OwnerAction, type OwnerApproval, type OwnerChallenge, type OwnerRequest, ownerRequests } from "@trendr/contracts";
import type { PerplMarket, PerplTicker } from "@trendr/perpl";
import type { BacktestResult, FollowSettings, RuleInput, Stats } from "./types";
import { api } from "./client";

export { ApiError, hasUserToken, setReauth, setUserToken } from "./client";
import { ApiError } from "./client";
export type * from "./types";

/** Typed calls to the backend, one per endpoint the app uses. */

/**
 * The account passkey's approval of one request (one prompt), which the account layer provides.
 * Following, resuming a follow, enabling a rule and linking a caller identity need it; pausing,
 * stopping and unfollowing do not.
 */
export type Approve = (request: OwnerRequest) => Promise<OwnerApproval>;

export const ownerApprovals = {
  /** A single-use nonce for the signed-in account to approve one action with. */
  challenge: (action: OwnerAction) => api<OwnerChallenge>("/v1/owner-approvals", { body: { action }, auth: true }),
};

export type SourceName = "elfa" | "bluesky" | "gdelt" | "hn" | "nansen" | "wikipedia";
export interface Reading {
  value: number;
  windowSec: number;
  observedAt: number;
}

export interface Trend {
  id: `0x${string}`;
  identifier: string;
  displayName: string | null;
  summary: string | null;
  assetClass: string;
  status: "active" | "cooling" | "retired" | "none";
  index: number;
  peakIndex: number;
  createdAt: number;
  updatedAt: number;
  surfacer: string;
  keywords: string[];
  article: string | null;
  ticker: string | null;
  readings: Record<SourceName, Reading | null>;
  /** Index change over the last 24 hours, percent (list only). */
  change24h?: number | null;
  /** Hourly index values over the last 24 hours (list only). */
  spark?: number[];
}

export interface TrendDetail {
  trend: Trend;
  index: Array<{ t: number; v: number }>;
  history: Array<{ source: SourceName; value: number; observedAt: number }>;
  /** A retired listing whose topic listed again: the live listing's identifier (older APIs omit it). */
  relistedAs?: string | null;
}

export interface Candidate {
  id: number;
  identifier: string;
  displayName: string;
  summary: string | null;
  assetClass: string;
  keywords: string[];
  source: string;
  /** The credit the source's terms require next to its data (CoinGecko, GeckoTerminal), else null (older APIs omit it). */
  attribution?: { text: string; url: string } | null;
  surfacer: string;
  status: string;
  createdAt: string;
}

export const trends = {
  list: (all = false) => api<{ lastRunId: number; trends: Trend[] }>(`/v1/trends${all ? "?all=1" : ""}`),
  get: (identifier: string) => api<TrendDetail>(`/v1/trends/${encodeURIComponent(identifier)}`),
  upcoming: () => api<{ candidates: Candidate[] }>("/v1/candidates"),
  thread: (identifier: string) => api<{ posts: Post[]; calls: Call[] }>(`/v1/trends/${encodeURIComponent(identifier)}/thread`),
};

export interface LinkResult {
  requestId: number;
  status: "approved" | "pending" | "rejected" | "live" | "failed";
  identifier?: string;
  displayName?: string;
  summary?: string;
  reason: string;
  firstSurfacer?: boolean;
}
export const links = {
  /** Signed in only: the proposer (and first curator, if it lists) is the signed-in account. */
  propose: (url: string) => api<LinkResult>("/v1/links", { body: { url }, auth: true }),
};

export interface PerplMarketInfo {
  id: number;
  symbol: string;
  name: string;
  maxLeverage: number;
  priceDecimals: number;
  sizeDecimals: number;
}

/** Perpl through the backend: market specs, live prices, and the account's next order id. */
export const perplApi = {
  /** Open markets and the instance minimums (raw AUSD) for opening an account and depositing. */
  markets: () => api<{ markets: PerplMarket[]; minAccountOpen: string; minDeposit: string }>("/v1/perpl/markets"),
  ticker: (id: number) => api<{ ticker: PerplTicker }>(`/v1/perpl/markets/${id}/ticker`),
  /** The next small, sequential order id for the signed-in account (shared with Autopilot). */
  requestId: async () => BigInt((await api<{ requestId: string }>("/v1/perpl/request-id", { body: {}, auth: true })).requestId),
};

export interface StoredRule {
  id: number;
  owner: string;
  rule: RuleInput;
  /** Which rule exactly: backtests and approvals to enable name it. */
  ruleHash: string;
  status: "draft" | "enabled" | "paused" | "stopped";
  statusReason: string | null;
  venue: "api" | "session";
  backtestId: number | null;
  createdAt: string;
  updatedAt: string;
}

export interface RuleDetail {
  rule: StoredRule;
  stats: Stats;
  equity: Array<{ t: number; v: number }>;
  positions: Array<{
    id: string;
    market: string;
    side: "long" | "short";
    status: string;
    size: number;
    entry_price: number | null;
    margin_ausd: number;
    leverage: number;
    opened_at: string | null;
    closed_at: string | null;
    exit_price: number | null;
    pnl_ausd: number | null;
    fees_ausd: number;
    close_reason: string | null;
  }>;
  audit: Array<{ id: string; at: string; event: string; detail: Record<string, unknown> }>;
  backtest: { id: number; createdAt: string; stats: Stats; warnings: string[] } | null;
}

export interface Grant {
  sessionKey: string;
  status: "pending" | "active" | "revoked" | "expired";
  validUntil: number;
  dailyLimit: string;
  /** A replacement key requested while this grant is active; the grant switches to it once it is on chain. */
  nextSessionKey?: string | null;
}

export interface GrantRequest {
  session: { key: `0x${string}`; validUntil: number; dailyLimit: string; permissions: Array<{ target: `0x${string}`; selector: `0x${string}`; recipientArg: number; guard: `0x${string}` }> };
}

export interface Follow {
  id: number;
  follower: string;
  leader: string;
  settings: FollowSettings;
  status: "active" | "paused" | "stopped";
  statusReason: string | null;
  createdAt: string;
}

export const autopilot = {
  markets: () => api<{ markets: PerplMarketInfo[] }>("/v1/autopilot/markets"),
  performance: (owner: string) => api<{ owner: string; stats: Stats; equity: Array<{ t: number; v: number }>; followers: number }>(`/v1/autopilot/performance/${owner}`),
  backtest: (rule: RuleInput, days: number) => api<{ id: number; ruleHash: string; result: BacktestResult & { resolutionSec: number } }>("/v1/autopilot/backtests", { body: { rule, days }, auth: true }),
  rules: () => api<{ rules: StoredRule[] }>("/v1/autopilot/rules", { auth: true }),
  rule: (id: number) => api<RuleDetail>(`/v1/autopilot/rules/${id}`, { auth: true }),
  create: (rule: RuleInput) => api<{ rule: StoredRule }>("/v1/autopilot/rules", { body: { rule }, auth: true }),
  update: (id: number, rule: RuleInput) => api<{ rule: StoredRule }>(`/v1/autopilot/rules/${id}`, { method: "PUT", body: { rule }, auth: true }),
  /** Pausing or stopping: no prompt. */
  setStatus: (id: number, status: "paused" | "stopped") => api<{ rule: StoredRule }>(`/v1/autopilot/rules/${id}/status`, { body: { status }, auth: true }),
  /** Enabling or resuming: the passkey approves exactly this rule first. */
  enable: async (rule: Pick<StoredRule, "id" | "ruleHash">, approve: Approve) => {
    const approval = await approve(ownerRequests.enableRule(rule.id, rule.ruleHash));
    return api<{ rule: StoredRule }>(`/v1/autopilot/rules/${rule.id}/status`, { body: { status: "enabled", ruleHash: rule.ruleHash, approval }, auth: true });
  },
  grant: () => api<{ grant: Grant | null }>("/v1/autopilot/grant", { auth: true }),
  /** The executor's public key, which the app seals grant keys to. */
  sealKey: () => api<{ publicKey: string }>("/v1/autopilot/grant/seal-key"),
  /** A key made on this device: the server gets its address and the box only the executor opens. */
  requestGrant: (dailyLimit: bigint, validDays: number, key: { sessionKey: `0x${string}`; sealedKey: string }) =>
    api<GrantRequest>("/v1/autopilot/grant", { body: { dailyLimit: dailyLimit.toString(), validDays, sessionKey: key.sessionKey, sealedKey: key.sealedKey }, auth: true }),
  confirmGrant: () => api<{ grant: Grant }>("/v1/autopilot/grant/confirm", { body: {}, auth: true }),
  follows: () => api<{ follows: Follow[] }>("/v1/follows", { auth: true }),
  /** Following or changing caps: the passkey approves the leader and these settings first. */
  follow: async (leader: string, settings: FollowSettings, approve: Approve) => {
    const approval = await approve(ownerRequests.follow(leader, settings));
    return api<{ follow: Follow }>("/v1/follows", { body: { leader, settings, approval }, auth: true });
  },
  /** Resuming a paused follow: the passkey approves it first. */
  resumeFollow: async (id: number, approve: Approve) => {
    const approval = await approve(ownerRequests.resumeFollow(id));
    return api<{ ok: true }>(`/v1/follows/${id}/status`, { body: { status: "active", approval }, auth: true });
  },
  /** Pausing or unfollowing: no prompt. */
  setFollowStatus: (id: number, status: "paused" | "stopped") => api<{ ok: true }>(`/v1/follows/${id}/status`, { body: { status }, auth: true }),
};

export interface Call {
  id: number;
  caller: string;
  handle?: string | null;
  identifier?: string;
  direction: "up" | "down";
  horizon_sec: number;
  note: string | null;
  called_at: number;
  opening_index: number;
  resolves_at: number;
  closing_index: number | null;
  outcome: "open" | "hit" | "miss" | "void";
}

/** What the backend answers when a call is made. */
export interface CallCreated {
  id: number;
  caller: string;
  identifier: string;
  direction: "up" | "down";
  horizonSec: number;
  openingIndex: number;
  calledAt: number;
  resolvesAt: number;
}

export interface Post {
  id: number;
  caller: string;
  handle: string | null;
  body: string;
  reply_to: number | null;
  call_id: number | null;
  created_at: string;
}

export interface CallerRow {
  address: string;
  handle: string | null;
  linked_account: string | null;
  hits: number;
  misses: number;
  open: number;
  resolved: number;
  hitRate: number;
  score: number;
}

interface CallerProfileView {
  caller: { address: string; handle: string | null; bio: string | null; linked_account: string | null; created_at: string };
  stats: { hits: number; misses: number; open: number; hitRate: number; score: number };
  calls: Call[];
}

export const social = {
  call: (body: { caller: string; identifier: string; direction: "up" | "down"; horizonSec: number; note: string; issuedAt: number; signature: string }) => api<{ call: CallCreated }>("/v1/calls", { body }),
  post: (body: { caller: string; identifier: string; body: string; replyTo: number | null; callId: number | null; issuedAt: number; signature: string }) => api<{ post: { id: number } }>("/v1/posts", { body }),
  leaderboard: () => api<{ callers: CallerRow[] }>("/v1/callers/leaderboard"),
  /** A caller's profile; no profile yet throws a 404 ApiError (asked as optional, so the browser logs no failed request). */
  caller: async (idOrHandle: string) => {
    const r = await api<CallerProfileView | { caller: null }>(`/v1/callers/${encodeURIComponent(idOrHandle)}?optional=1`);
    if (!r.caller) throw new ApiError(404, "no such caller");
    return r as CallerProfileView;
  },
  profile: (body: { caller: string; handle: string; bio: string; issuedAt: number; signature: string }) => api<{ caller: { address: string; handle: string } }>("/v1/callers/me", { method: "PUT", body }),
  /** Linking: the caller identity signs, and the account's passkey approves (one prompt). */
  link: async (body: { identity: string; account: string; issuedAt: number; identitySignature: string }, approve: Approve) => {
    const approval = await approve(ownerRequests.linkIdentity(body.identity));
    return api<{ caller: string; linkedAccount: string }>("/v1/callers/link", { body: { ...body, approval } });
  },
  identitySession: (identity: string, issuedAt: number, signature: string) => api<{ token: string; expiresAt: number }>("/v1/identity/session", { body: { identity, issuedAt, signature } }),
};

export interface VaultItem {
  kind: "strategy" | "note";
  item_id: string;
  ciphertext: string;
  iv: string;
  version: number;
  updated_at: string;
}
export const vault = {
  list: (token: string, kind?: "strategy" | "note") => api<{ items: VaultItem[] }>(`/v1/vault${kind ? `?kind=${kind}` : ""}`, { token }),
  put: (token: string, kind: "strategy" | "note", id: string, item: { ciphertext: string; iv: string; version: number }) => api<{ ok: true; version: number }>(`/v1/vault/${kind}/${id}`, { method: "PUT", body: item, token }),
  remove: (token: string, kind: "strategy" | "note", id: string) => api<{ ok: true }>(`/v1/vault/${kind}/${id}`, { method: "DELETE", token }),
};

export const push = {
  vapid: () => api<{ publicKey: string }>("/v1/push/vapid"),
  subscribe: (sub: { endpoint: string; keys: { p256dh: string; auth: string }; topics?: string[] }) => api<{ ok: true }>("/v1/push/subscriptions", { body: sub, auth: true }),
  unsubscribe: (endpoint: string) => api<{ ok: true }>("/v1/push/subscriptions", { method: "DELETE", body: { endpoint }, auth: true }),
};

export interface SystemStatus {
  ok: boolean;
  services: Array<{ name: string; ok: boolean; latencyMs: number | null }>;
  oracle: { ok: boolean; lastRunAgeSec: number | null; staleTrends: number };
  chain: { ok: boolean; ageSec: number | null; number: string | null };
  at: number;
}
export const system = {
  /** The system status; a 503 still carries the status body, which names what is down. */
  status: () =>
    api<SystemStatus>("/v1/status").catch((e: unknown) => {
      if (e instanceof ApiError && e.status === 503 && e.body && typeof e.body === "object" && "services" in e.body) return e.body as SystemStatus;
      throw e;
    }),
};

/** History from the Envio indexer: track records, trade history, the trader leaderboard and trend stats. */
export interface AccountHistory {
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
export interface ActivityItem {
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
/** A series the indexer says the account holds outcome tokens of; balances are raw (6 decimals) and may trail the chain. */
export interface IndexedOutcomeHolding {
  seriesId: `0x${string}`;
  trendId: `0x${string}`;
  identifier: string | null;
  /** The OutcomeMarkets contract that issued the series. */
  outcomeMarkets: `0x${string}`;
  window: number;
  openedAt: number;
  expiry: number;
  openingIndex: number;
  outcome: "open" | "up" | "down" | "void";
  settlementIndex: number | null;
  up: `0x${string}`;
  down: `0x${string}`;
  upMarket: `0x${string}` | null;
  downMarket: `0x${string}` | null;
  upBalance: string;
  downBalance: string;
  /**
   * The indexer's book of each side at average cost, raw (6 decimals): the position it counts
   * (Kuru-resting tokens included), its AUSD cost, the AUSD realized, and the block time of the
   * last trade it applied (seconds). Absent from older backends.
   */
  upPosition?: string;
  downPosition?: string;
  upCostBasis?: string;
  downCostBasis?: string;
  upRealizedPnl?: string;
  downRealizedPnl?: string;
  upUpdatedAt?: number;
  downUpdatedAt?: number;
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
export const history = {
  /** An account's record; no activity yet throws a 404 ApiError (asked as optional, so the browser logs no failed request). */
  account: async (address: string) => {
    const r = await api<{ account: AccountHistory | null }>(`/v1/accounts/${address}?optional=1`);
    if (!r.account) throw new ApiError(404, "no activity yet");
    return { account: r.account };
  },
  activity: (address: string, limit = 50) => api<{ items: ActivityItem[] }>(`/v1/accounts/${address}/activity?limit=${limit}`),
  outcomes: (address: string) => api<{ holdings: IndexedOutcomeHolding[] }>(`/v1/accounts/${address}/outcomes`),
  traders: () => api<{ traders: TraderRow[] }>("/v1/leaderboard/traders"),
  /** Null until the listing has traded (older APIs answered 404 instead). */
  trend: (identifier: string) => api<{ stats: TrendStats | null }>(`/v1/trends/${encodeURIComponent(identifier)}/stats`),
};

/** Any-chain deposits through Aurora Intents (live deposit addresses on Mainnet only). */
export interface DepositChain {
  blockchain: string;
  name: string;
  tokens: Array<{ assetId: string; symbol: string; decimals: number; price: number }>;
}
export interface DepositView {
  id: number | null;
  state: {
    phase: "quoted" | "awaiting_deposit" | "deposit_detected" | "incomplete_deposit" | "processing" | "succeeded" | "refunded" | "failed" | "expired";
    origin: { symbol: string; blockchain: string; decimals: number };
    destination: { symbol: string; blockchain: string; decimals: number };
    depositAddress?: string;
    depositMemo?: string;
    amountInFormatted: string;
    amountOutFormatted: string;
    minAmountOut: string;
    refundTo: string;
    deadline?: string;
    timeEstimateSeconds: number;
    depositTxHashes: string[];
  };
  message: { title: string; body: string; requirements: string[]; action: string; links: string[]; support?: { depositAddress?: string; txHashes: string[] } };
}
export interface DepositRequest {
  originAssetId: string;
  amount: string;
  refundTo: string;
  account: string;
}
export const deposits = {
  tokens: () => api<{ live: boolean; chains: DepositChain[] }>("/v1/deposits/tokens"),
  quote: (body: DepositRequest) => api<DepositView>("/v1/deposits/quote", { body }),
  create: (body: DepositRequest) => api<DepositView>("/v1/deposits", { body, auth: true }),
  get: (id: number) => api<DepositView>(`/v1/deposits/${id}`, { auth: true }),
  list: () => api<{ deposits: DepositView[] }>("/v1/deposits", { auth: true }),
  submitTx: (id: number, txHash: string) => api<DepositView>(`/v1/deposits/${id}/tx`, { body: { txHash }, auth: true }),
};

/** The Mainnet waitlist. The answer is the same for a new email and a listed one. */
export const waitlist = {
  join: (body: { email: string; account: string | null; consent: true; website: string }) => api<{ ok: true }>("/v1/waitlist", { body: { ...body, source: "app" } }),
};

export const faucet = {
  info: () => api<{ available: boolean; amount: string | null }>("/v1/faucet"),
  drip: () => api<{ hash: string; amount: string }>("/v1/faucet", { body: {}, auth: true }),
};

/**
 * Sign-up: the relayer pays for an account's activation only with the API's ticket for it. Null
 * when the API has no ticket key (a local setup), so the relayer decides; refusals (the sign-up
 * caps, an account already active) throw with the API's message.
 */
export const activation = {
  ticket: async (account: string): Promise<ActivationTicket | null> => {
    try {
      return await api<ActivationTicket>("/v1/activation-ticket", { body: { account } });
    } catch (e) {
      if (e instanceof ApiError && (e.status === 404 || (e.status === 503 && e.message === "activation tickets are not configured"))) return null;
      throw e;
    }
  },
};

export const auth = {
  session: (account: string, signer: string, issuedAt: number, signature: string) => api<{ token: string; account: string; expiresAt: number }>("/v1/auth/session", { body: { account, signer, issuedAt, signature } }),
  revoke: (token: string) => api<{ ok: true }>("/v1/auth/session/revoke", { body: {}, token }),
};
