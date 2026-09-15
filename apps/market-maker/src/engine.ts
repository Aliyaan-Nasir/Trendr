import { type Alerts, type Chain, errorSummary, type Head, MonadRealtime, SimulationRevert } from "@trendr/chain";
import {
  type Deployment,
  iKuruMarginAccountAbi,
  iKuruOrderBookAbi,
  iKuruRouterAbi,
  outcomeMarketsAbi,
  trendRegistryAbi,
  trendrLensAbi,
} from "@trendr/contracts";
import { type Address, encodeFunctionData, erc20Abi, type Hex, isAddressEqual, parseAbi, type PublicClient } from "viem";
import { decodeL2, type Level, PRICE_PRECISION, SIZE_PRECISION, TAKER_FEE_BPS, withoutOwn } from "./book";
import { encodeRequote, placedOrders } from "./kuru";
import { type Checkpoint, type Dynamics, estimateDynamics, fairUp } from "./pricing";
import { clampToBook, type Holdings, type Ladder, findArbitrage, ladders, pickSeries, type QuoteParams, requoteUrgency } from "./strategy";
import { type MmState, StateStore } from "./store";

export interface EngineLog {
  info(fields: Record<string, unknown>, message: string): void;
  warn(fields: Record<string, unknown>, message: string): void;
  error(fields: Record<string, unknown>, message: string): void;
  debug(fields: Record<string, unknown>, message: string): void;
}

export interface EngineOptions {
  quote: QuoteParams;
  windows: readonly number[];
  setsPerSeries: number;
  marginAusd: number;
  requoteTicks: number;
  stopBeforeExpirySec: number;
  arbMinEdge: number;
  arbMaxTokens: number;
  quoteEveryBlocks: number;
  pollMs: number;
  /** WebSocket endpoints; without any, heads are polled over HTTP. */
  wsUrls?: readonly string[];
  killed: () => boolean;
  /** MON the key needs for a re-quote's gas; below it the maker reports unhealthy. */
  minBalanceWei?: bigint;
  /** Most series quoted at once; each costs gas on every re-quote. */
  maxSeries?: number;
  /** Least time between drift-only re-quotes of one market; fills and big moves re-quote at once. */
  minRequoteSec?: number;
}

const ZERO: Hex = `0x${"0".repeat(64)}`;
const UNIT = 1_000_000;
/** Raw token units per Kuru size unit (0.01 token of a 6-decimal token). */
const RAW_PER_SIZE = BigInt(UNIT / SIZE_PRECISION);
const MARGIN_ACCOUNT_ABI = parseAbi(["function marginAccountAddress() view returns (address)"]);
const CHECKPOINTS = 120;
const DYNAMICS_TTL_MS = 5 * 60_000;
const GAS = {
  approve: 100_000n,
  deposit: 300_000n,
  withdraw: 300_000n,
  mint: 400_000n,
  redeem: 300_000n,
  requote: 2_500_000n,
  swap: 1_200_000n,
} as const;

const raw = (amount: number) => BigInt(Math.floor(amount * UNIT));
const tokens = (rawAmount: bigint) => Number(rawAmount) / UNIT;

interface Quoted {
  seriesId: Hex;
  trendId: Hex;
  window: number;
  expiry: bigint;
  opening: bigint;
  up: Address;
  down: Address;
  upMarket: Address;
  downMarket: Address;
}

interface OwnOrders {
  live: (Level & { id: number; isBuy: boolean })[];
  /** Ours, live or filled; safe to name in a cancel. */
  cancellable: number[];
}

export interface EngineStatus {
  head: { number: bigint; seenAt: number };
  lastTick: { at: number; durationMs: number; quoted: number; requotes: number } | null;
  lastError: string | null;
  /** The key's MON, read every tick. */
  balanceWei: bigint;
  killed: boolean;
  equity: number;
  baselineEquity: number | null;
  series: Record<string, { fair: number; up: Ladder; down: Ladder }>;
  stats: { requotes: number; mints: number; arbitrages: number; redemptions: number; failures: number };
}

/**
 * Quotes every listed series around its fair value and keeps complete-set prices honest. One tick
 * reads the protocol and the books, then for each series mints inventory when it has none,
 * re-quotes a market only when its resting orders drifted, takes any complete-set arbitrage
 * other traders leave, and after settlement pulls everything back and redeems.
 */
export class MarketMaker {
  private marginAccount: Address | null = null;
  private ticking: Promise<void> | null = null;
  private dirty = true;
  private realtime: MonadRealtime | null = null;
  private timers: ReturnType<typeof setInterval>[] = [];
  private readonly dynamics = new Map<Hex, { at: number; value: Dynamics }>();
  private lastTickBlock = 0n;
  /** Each trend's current index, refreshed every tick. */
  private index = new Map<Hex, bigint>();
  /** When each market was last re-quoted (milliseconds). */
  private readonly lastRequote = new Map<Address, number>();
  /** Reads within one tick; any transaction clears them, since it may change what they saw. */
  private readonly cache = new Map<string, Promise<unknown>>();
  readonly status: EngineStatus = {
    head: { number: 0n, seenAt: 0 },
    lastTick: null,
    lastError: null,
    balanceWei: 0n,
    killed: false,
    equity: 0,
    baselineEquity: null,
    series: {},
    stats: { requotes: 0, mints: 0, arbitrages: 0, redemptions: 0, failures: 0 },
  };

  constructor(
    private readonly client: PublicClient,
    private readonly chain: Chain,
    private readonly d: Deployment,
    private readonly store: StateStore,
    private readonly alerts: Alerts,
    private readonly log: EngineLog,
    private readonly opts: EngineOptions,
  ) {}

  get me(): Address {
    return this.chain.senders()[0]!;
  }

  async start(): Promise<void> {
    if (this.opts.wsUrls && this.opts.wsUrls.length > 0) {
      this.realtime = new MonadRealtime(this.opts.wsUrls, { log: (level, message, fields) => this.log[level](fields ?? {}, message) })
        .onHeads((h) => this.onHead(h))
        .onLogs({ address: [this.d.trendRegistry, this.d.outcomeMarkets] }, () => {
          this.dirty = true;
        })
        .start();
    }
    this.timers.push(
      setInterval(() => {
        if (this.realtime?.status.connected) return;
        this.client
          .getBlockNumber()
          .then((number) => {
            if (number > this.status.head.number) this.onHead({ number } as Head);
          })
          .catch((e) => this.log.warn({ error: errorSummary(e) }, "head poll failed"));
      }, this.opts.pollMs),
    );
    this.log.info({ maker: this.me, windows: this.opts.windows }, "market maker started");
  }

  stop(): void {
    this.realtime?.stop();
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
  }

  /** Runs one tick and waits for it. */
  async tick(): Promise<void> {
    if (this.ticking) {
      this.dirty = true;
      return this.ticking;
    }
    this.ticking = this.doTick().finally(() => {
      this.ticking = null;
    });
    return this.ticking;
  }

  private onHead(head: Head): void {
    this.status.head = { number: head.number, seenAt: Date.now() };
    const due = head.number - this.lastTickBlock >= BigInt(this.opts.quoteEveryBlocks);
    if ((this.dirty || due) && !this.ticking) void this.tick();
  }

  private async doTick(): Promise<void> {
    const started = Date.now();
    this.dirty = false;
    this.cache.clear();
    let requotes = 0;
    try {
      this.marginAccount ??= await this.client.readContract({ address: this.d.kuruRouter, abi: MARGIN_ACCOUNT_ABI, functionName: "marginAccountAddress" });
      const state = this.store.load();
      const block = await this.client.getBlock({ blockTag: "latest" });
      this.lastTickBlock = block.number;
      this.status.balanceWei = await this.client.getBalance({ address: this.me });
      const broke = this.status.balanceWei < this.minBalanceWei;
      this.alerts.set("balance-low", broke, `maker ${this.me} holds ${this.status.balanceWei} wei of MON, below the ${this.minBalanceWei} a re-quote needs`);
      // Every action needs gas: wait for a top-up instead of sending transactions that cannot pay.
      if (broke) return;
      const now = block.timestamp;
      const killed = this.opts.killed();
      this.status.killed = killed;
      this.alerts.set("kill-switch", killed, "kill switch is on: all quotes pulled");

      const { quotable, held } = await this.discover(state, now);
      this.status.series = {};

      // Settled series: pull everything and redeem.
      for (const s of held) {
        if (s.outcome !== 0) await this.windDown(state, s.quoted);
      }

      const quotedNow = killed ? [] : pickSeries(quotable, this.index, this.opts.maxSeries ?? Number.MAX_SAFE_INTEGER);
      const quotedIds = new Set(quotedNow.map((q) => q.seriesId));
      // Open series we stopped quoting (near expiry, stale index, kill switch): pull the orders.
      for (const s of held) {
        if (s.outcome === 0 && !quotedIds.has(s.quoted.seriesId)) {
          for (const m of [s.quoted.upMarket, s.quoted.downMarket]) requotes += await this.requote(state, m, { bids: [], asks: [] }, true);
        }
      }

      const bidBacking = quotedNow.length > 0 ? await this.topUpMargin(state, quotedNow) : 0n;
      const share = quotedNow.length > 0 ? tokens(bidBacking) / quotedNow.length : 0;
      for (const q of quotedNow) {
        if (!state.series[q.seriesId]) state.series[q.seriesId] = { ...q, expiry: q.expiry.toString(), opening: q.opening.toString(), minted: 0 };
        await this.ensureInventory(state, q);
        requotes += await this.quoteSeries(state, q, now, share);
        await this.arbitrage(q);
      }

      this.status.equity = await this.equity(state);
      if (state.baselineEquity === null) state.baselineEquity = this.status.equity;
      this.status.baselineEquity = state.baselineEquity;
      this.store.save(state);
      this.status.lastTick = { at: Date.now(), durationMs: Date.now() - started, quoted: quotedNow.length, requotes };
      this.status.lastError = null;
    } catch (e) {
      this.status.lastError = errorSummary(e);
      this.status.stats.failures++;
      this.log.error({ error: this.status.lastError }, "tick failed");
      this.dirty = true;
    }
  }

  /** Series worth quoting now, and every series the maker holds inventory or orders in. */
  private async discover(state: MmState, now: bigint) {
    const total = await this.client.readContract({ address: this.d.trendRegistry, abi: trendRegistryAbi, functionName: "trendCount" });
    const trends = [];
    for (let start = 0n; start < total; start += 100n) {
      trends.push(...(await this.client.readContract({ address: this.d.trendRegistry, abi: trendRegistryAbi, functionName: "trends", args: [start, 100n] })));
    }
    const staleness = BigInt(await this.client.readContract({ address: this.d.trendRegistry, abi: trendRegistryAbi, functionName: "stalenessLimit" }));
    const fresh = new Map(trends.map((t) => [t.id, t.trend.status === 1 && now - BigInt(t.trend.updatedAt) <= staleness]));
    const index = new Map(trends.map((t) => [t.id, BigInt(t.trend.index)]));
    this.index = index;

    const active = trends.filter((t) => t.trend.status === 1).map((t) => t.id);
    const quotable: Quoted[] = [];
    for (let i = 0; i < active.length; i += 40) {
      const views = await this.client.readContract({ address: this.d.trendrLens, abi: trendrLensAbi, functionName: "series", args: [active.slice(i, i + 40)] });
      for (const v of views) {
        if (v.seriesId === ZERO || !v.listed || v.outcome !== 0 || !this.opts.windows.includes(Number(v.window))) continue;
        if (!fresh.get(v.trendId)) continue;
        if (BigInt(v.expiry) - now <= BigInt(this.opts.stopBeforeExpirySec)) continue;
        quotable.push({
          seriesId: v.seriesId,
          trendId: v.trendId,
          window: Number(v.window),
          expiry: BigInt(v.expiry),
          opening: BigInt(v.openingIndex),
          up: v.up,
          down: v.down,
          upMarket: v.upMarket,
          downMarket: v.downMarket,
        });
      }
    }

    const held = await Promise.all(
      Object.entries(state.series).map(async ([seriesId, s]) => {
        const onChain = await this.client.readContract({ address: this.d.outcomeMarkets, abi: outcomeMarketsAbi, functionName: "seriesOf", args: [seriesId as Hex] });
        const quoted: Quoted = { ...s, seriesId: seriesId as Hex, expiry: BigInt(s.expiry), opening: BigInt(s.opening) };
        return { quoted, outcome: Number(onChain.outcome) };
      }),
    );
    return { quotable, held };
  }

  private cached<T>(key: string, read: () => Promise<T>): Promise<T> {
    let hit = this.cache.get(key) as Promise<T> | undefined;
    if (!hit) {
      hit = read();
      this.cache.set(key, hit);
      hit.catch(() => this.cache.delete(key));
    }
    return hit;
  }

  private ownOrders(state: MmState, market: Address): Promise<OwnOrders> {
    return this.cached(`orders:${market}`, () => this.readOwnOrders(state, market));
  }

  /**
   * Our orders in `market`. Kuru fills each price level first come first served and marks orders
   * filled lazily: an order still rests only while its level's head has not moved past it. A filled
   * order keeps its record until we cancel it, and cancelling it is still allowed, so every order
   * whose record names us is cancellable; ids whose record is gone are forgotten.
   */
  private async readOwnOrders(state: MmState, market: Address): Promise<OwnOrders> {
    const ids = state.orders[market] ?? [];
    if (ids.length === 0) return { live: [], cancellable: [] };
    const records = await this.client.multicall({
      allowFailure: false,
      contracts: ids.map((id) => ({ address: market, abi: iKuruOrderBookAbi, functionName: "s_orders" as const, args: [id] as const })),
    });
    const ours = records
      .map((r, i) => ({ id: ids[i]!, owner: r[0], size: r[1], price: Number(r[5]), isBuy: r[7] }))
      .filter((o) => isAddressEqual(o.owner, this.me));
    const heads = await this.client.multicall({
      allowFailure: false,
      contracts: ours.map((o) => ({
        address: market,
        abi: iKuruOrderBookAbi,
        functionName: o.isBuy ? ("s_buyPricePoints" as const) : ("s_sellPricePoints" as const),
        args: [BigInt(o.price)] as const,
      })),
    });
    const live: OwnOrders["live"] = [];
    ours.forEach((o, i) => {
      const head = Number(heads[i]![0]);
      const resting = o.price !== 0 && head !== 0 && head <= o.id && o.size > 0n;
      if (resting) live.push({ id: o.id, price: o.price, size: o.size, isBuy: o.isBuy });
    });
    const cancellable = ours.map((o) => o.id);
    // Records that are gone can never be named again.
    state.orders[market] = cancellable;
    return { live, cancellable };
  }

  /** Re-quotes `market` to `want` when the resting orders drifted, or always when `force`. */
  private async requote(state: MmState, market: Address, want: Ladder, force = false): Promise<number> {
    const own = await this.ownOrders(state, market);
    const live: Ladder = {
      bids: own.live.filter((o) => o.isBuy).sort((a, b) => b.price - a.price),
      asks: own.live.filter((o) => !o.isBuy).sort((a, b) => a.price - b.price),
    };
    const empty = want.bids.length === 0 && want.asks.length === 0;
    if (empty && own.cancellable.length === 0) return 0;
    if (!force) {
      const urgency = requoteUrgency(live, want, this.opts.requoteTicks);
      if (urgency === "none") return 0;
      const since = Date.now() - (this.lastRequote.get(market) ?? 0);
      if (urgency === "drift" && since < (this.opts.minRequoteSec ?? 0) * 1000) return 0;
    }
    try {
      const sent = await this.transact(market, encodeRequote(own.cancellable, want.bids, want.asks), GAS.requote);
      if (sent.status !== "success") throw new Error(`re-quote reverted in ${sent.hash}`);
      const placed = placedOrders(sent.logs, market).filter((o) => isAddressEqual(o.owner, this.me));
      state.orders[market] = placed.map((o) => o.id);
      this.lastRequote.set(market, Date.now());
      this.status.stats.requotes++;
      this.log.info({ market, cancelled: own.cancellable.length, bids: want.bids, asks: want.asks, hash: sent.hash }, "re-quoted");
      return 1;
    } catch (e) {
      this.status.stats.failures++;
      this.log.warn({ market, reason: e instanceof SimulationRevert ? e.reason : errorSummary(e) }, "re-quote failed");
      return 0;
    }
  }

  private balance(token: Address): Promise<bigint> {
    return this.cached(`balance:${token}`, () => this.client.readContract({ address: token, abi: erc20Abi, functionName: "balanceOf", args: [this.me] }));
  }

  private margin(token: Address): Promise<bigint> {
    return this.cached(`margin:${token}`, () =>
      this.client.readContract({ address: this.marginAccount!, abi: iKuruMarginAccountAbi, functionName: "getBalance", args: [this.me, token] }),
    );
  }

  /** Every transaction goes through here, so cached reads never outlive what they describe. */
  private async transact(to: Address, data: Hex, gasCap: bigint) {
    try {
      return await this.chain.send({ to, data, gasCap });
    } finally {
      this.cache.clear();
    }
  }

  private async send(to: Address, data: Hex, gasCap: bigint, what: string) {
    const sent = await this.transact(to, data, gasCap);
    if (sent.status !== "success") throw new Error(`${what} reverted in ${sent.hash}`);
    return sent;
  }

  /** Approves exactly `amount` and deposits it into Kuru's MarginAccount. */
  private async deposit(token: Address, amount: bigint) {
    if (amount <= 0n) return;
    await this.send(token, encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [this.marginAccount!, amount] }), GAS.approve, "approve");
    await this.send(
      this.marginAccount!,
      encodeFunctionData({ abi: iKuruMarginAccountAbi, functionName: "deposit", args: [this.me, token, amount] }),
      GAS.deposit,
      "deposit",
    );
  }

  /**
   * Keeps MARGIN_AUSD of AUSD in the MarginAccount, counting AUSD resting in our bids, and returns
   * the total backing bids. Every series gets an equal share of it for the whole tick, so a
   * series' budget never depends on the order the series are quoted in.
   */
  private async topUpMargin(state: MmState, quoted: Quoted[]): Promise<bigint> {
    let locked = 0n;
    for (const q of quoted) {
      for (const m of [q.upMarket, q.downMarket]) {
        for (const o of (await this.ownOrders(state, m)).live) if (o.isBuy) locked += (BigInt(o.price) * o.size * RAW_PER_SIZE) / BigInt(PRICE_PRECISION);
      }
    }
    const have = (await this.margin(this.d.ausd)) + locked;
    const want = raw(this.opts.marginAusd);
    if (have >= want) return have;
    const wallet = await this.balance(this.d.ausd);
    const amount = want - have < wallet ? want - have : wallet;
    if (amount <= 0n) return have;
    await this.deposit(this.d.ausd, amount);
    this.log.info({ amount: tokens(amount) }, "topped up margin AUSD");
    return have + amount;
  }

  /** Mints the series' complete sets once and moves both sides into the MarginAccount. */
  private async ensureInventory(state: MmState, q: Quoted) {
    const entry = state.series[q.seriesId]!;
    if (entry.minted > 0) return;
    const amount = raw(this.opts.setsPerSeries);
    const wallet = await this.balance(this.d.ausd);
    if (wallet < amount) {
      this.alerts.set("ausd-low", true, `wallet holds ${tokens(wallet)} AUSD, below the ${this.opts.setsPerSeries} needed to mint a series`);
      return;
    }
    this.alerts.set("ausd-low", false, "");
    await this.send(this.d.ausd, encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [this.d.outcomeMarkets, amount] }), GAS.approve, "approve");
    await this.send(
      this.d.outcomeMarkets,
      encodeFunctionData({ abi: outcomeMarketsAbi, functionName: "mint", args: [q.seriesId, amount, this.me] }),
      GAS.mint,
      "mint",
    );
    entry.minted = this.opts.setsPerSeries;
    this.status.stats.mints++;
    await this.deposit(q.up, await this.balance(q.up));
    await this.deposit(q.down, await this.balance(q.down));
    this.log.info({ series: q.seriesId, sets: this.opts.setsPerSeries }, "minted inventory");
  }

  private async fair(q: Quoted, now: bigint): Promise<number> {
    const cached = this.dynamics.get(q.trendId);
    let dynamics = cached?.value;
    if (!cached || Date.now() - cached.at > DYNAMICS_TTL_MS) {
      const count = await this.client.readContract({ address: this.d.trendRegistry, abi: trendRegistryAbi, functionName: "checkpointCount", args: [q.trendId] });
      const from = count > BigInt(CHECKPOINTS) ? count - BigInt(CHECKPOINTS) : 0n;
      const ids = [];
      for (let i = from; i < count; i++) ids.push(i);
      const points = await this.client.multicall({
        allowFailure: false,
        contracts: ids.map((i) => ({ address: this.d.trendRegistry, abi: trendRegistryAbi, functionName: "checkpointAt" as const, args: [q.trendId, i] as const })),
      });
      const history: Checkpoint[] = points.map(([at, idx]) => ({ at: Number(at), index: Number(idx) / 1e6 }));
      dynamics = estimateDynamics(history);
      this.dynamics.set(q.trendId, { at: Date.now(), value: dynamics });
    }
    const index = Number(this.index.get(q.trendId) ?? q.opening) / 1e6;
    return fairUp({ index, opening: Number(q.opening) / 1e6, tau: Number(q.expiry - now), dynamics: dynamics! });
  }

  private async quoteSeries(state: MmState, q: Quoted, now: bigint, ausdShare: number): Promise<number> {
    const p = await this.fair(q, now);
    const [upOwn, downOwn] = [await this.ownOrders(state, q.upMarket), await this.ownOrders(state, q.downMarket)];
    const restingTokens = (o: OwnOrders) => o.live.filter((x) => !x.isBuy).reduce((a, x) => a + x.size, 0n) * RAW_PER_SIZE;
    const holdings: Holdings = {
      up: tokens((await this.margin(q.up)) + restingTokens(upOwn)),
      down: tokens((await this.margin(q.down)) + restingTokens(downOwn)),
      ausd: ausdShare,
    };
    const quoted = ladders(p, holdings, this.opts.quote);
    // Other traders' resting orders: our post-only levels may not cross them.
    const others = async (market: Address, own: OwnOrders) => withoutOwn(await this.book(market), own.live);
    const want = { up: clampToBook(quoted.up, await others(q.upMarket, upOwn)), down: clampToBook(quoted.down, await others(q.downMarket, downOwn)) };
    this.status.series[q.seriesId] = { fair: p, up: want.up, down: want.down };
    return (await this.requote(state, q.upMarket, want.up)) + (await this.requote(state, q.downMarket, want.down));
  }

  /** A market's top five levels per side, read once per tick (any transaction clears the cache). */
  private book(market: Address) {
    return this.cached(`book:${market}`, async () => decodeL2(await this.client.readContract({ address: market, abi: iKuruOrderBookAbi, functionName: "getL2Book", args: [5, 5] })));
  }

  /** Takes complete-set arbitrage that other traders' orders leave open. */
  private async arbitrage(q: Quoted) {
    const read = (market: Address) => this.book(market);
    const state = this.store.load();
    const [upOwn, downOwn] = [await this.ownOrders(state, q.upMarket), await this.ownOrders(state, q.downMarket)];
    const up = withoutOwn(await read(q.upMarket), upOwn.live);
    const down = withoutOwn(await read(q.downMarket), downOwn.live);
    const arb = findArbitrage(up, down, this.opts.arbMinEdge, this.opts.arbMaxTokens);
    if (!arb) return;
    const swap = (market: Address, isBuy: boolean, debit: Address, credit: Address, amount: bigint, minOut: bigint) =>
      encodeFunctionData({ abi: iKuruRouterAbi, functionName: "anyToAnySwap", args: [[market], [isBuy], [false], debit, credit, amount, minOut] });
    const approve = (token: Address, amount: bigint) =>
      this.send(token, encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [this.d.kuruRouter, amount] }), GAS.approve, "approve");
    const fee = 1 - TAKER_FEE_BPS / 10_000;
    try {
      if (arb.kind === "buyBoth") {
        const n = arb.tokens;
        const upCost = raw(arb.upCost);
        const downCost = raw(arb.downCost);
        if ((await this.balance(this.d.ausd)) < upCost + downCost) return;
        const minOut = raw(n * fee * 0.999);
        await approve(this.d.ausd, upCost);
        await this.send(this.d.kuruRouter, swap(q.upMarket, true, this.d.ausd, q.up, upCost, minOut), GAS.swap, "buy UP");
        await approve(this.d.ausd, downCost);
        await this.send(this.d.kuruRouter, swap(q.downMarket, true, this.d.ausd, q.down, downCost, minOut), GAS.swap, "buy DOWN");
        const pairs = [await this.balance(q.up), await this.balance(q.down)].reduce((a, b) => (a < b ? a : b));
        await this.send(
          this.d.outcomeMarkets,
          encodeFunctionData({ abi: outcomeMarketsAbi, functionName: "redeemSets", args: [q.seriesId, pairs, this.me] }),
          GAS.redeem,
          "redeem sets",
        );
      } else {
        const n = raw(arb.tokens);
        if ((await this.balance(this.d.ausd)) < n) return;
        await this.send(this.d.ausd, encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [this.d.outcomeMarkets, n] }), GAS.approve, "approve");
        await this.send(this.d.outcomeMarkets, encodeFunctionData({ abi: outcomeMarketsAbi, functionName: "mint", args: [q.seriesId, n, this.me] }), GAS.mint, "mint");
        await approve(q.up, n);
        await this.send(this.d.kuruRouter, swap(q.upMarket, false, q.up, this.d.ausd, n, raw(arb.upProceeds * 0.999)), GAS.swap, "sell UP");
        await approve(q.down, n);
        await this.send(this.d.kuruRouter, swap(q.downMarket, false, q.down, this.d.ausd, n, raw(arb.downProceeds * 0.999)), GAS.swap, "sell DOWN");
      }
      this.status.stats.arbitrages++;
      this.log.info({ series: q.seriesId, ...arb }, "complete-set arbitrage");
    } catch (e) {
      this.status.stats.failures++;
      this.log.warn({ series: q.seriesId, kind: arb.kind, reason: e instanceof SimulationRevert ? e.reason : errorSummary(e) }, "arbitrage failed");
    }
  }

  /** After settlement: cancel, withdraw both sides from the MarginAccount and redeem. */
  private async windDown(state: MmState, q: Quoted) {
    for (const m of [q.upMarket, q.downMarket]) await this.requote(state, m, { bids: [], asks: [] }, true);
    const marketsClear = (state.orders[q.upMarket]?.length ?? 0) + (state.orders[q.downMarket]?.length ?? 0) === 0;
    if (!marketsClear) return;
    for (const token of [q.up, q.down]) {
      const amount = await this.margin(token);
      if (amount > 0n) {
        await this.send(this.marginAccount!, encodeFunctionData({ abi: iKuruMarginAccountAbi, functionName: "withdraw", args: [amount, token] }), GAS.withdraw, "withdraw");
      }
    }
    const [up, down] = [await this.balance(q.up), await this.balance(q.down)];
    if (up + down > 0n) {
      await this.send(
        this.d.outcomeMarkets,
        encodeFunctionData({ abi: outcomeMarketsAbi, functionName: "redeemWinnings", args: [q.seriesId, up, down, this.me] }),
        GAS.redeem,
        "redeem winnings",
      );
      this.status.stats.redemptions++;
    }
    delete state.series[q.seriesId];
    delete state.orders[q.upMarket];
    delete state.orders[q.downMarket];
    this.log.info({ series: q.seriesId }, "series wound down");
  }

  /** AUSD everywhere plus held tokens at fair value, in AUSD. */
  private async equity(state: MmState): Promise<number> {
    let total = tokens((await this.balance(this.d.ausd)) + (await this.margin(this.d.ausd)));
    for (const [seriesId, s] of Object.entries(state.series)) {
      const p = this.status.series[seriesId]?.fair ?? 0.5;
      for (const [token, market, weight] of [
        [s.up, s.upMarket, p],
        [s.down, s.downMarket, 1 - p],
      ] as const) {
        const own = await this.ownOrders(state, market);
        const resting = own.live.reduce((a, o) => a + (o.isBuy ? 0n : o.size * RAW_PER_SIZE), 0n);
        const bids = own.live.reduce((a, o) => a + (o.isBuy ? (BigInt(o.price) * o.size * RAW_PER_SIZE) / BigInt(PRICE_PRECISION) : 0n), 0n);
        total += tokens((await this.balance(token)) + (await this.margin(token)) + resting) * weight + tokens(bids);
      }
    }
    return total;
  }

  /** Our live orders in `market`, read fresh. */
  async restingOrders(market: Address): Promise<OwnOrders["live"]> {
    return (await this.readOwnOrders(this.store.load(), market)).live;
  }

  private get minBalanceWei(): bigint {
    return this.opts.minBalanceWei ?? 0n;
  }

  /** Ticks complete, the last one succeeded, and the key can pay for a re-quote. */
  healthy(): boolean {
    const ticking = this.status.lastTick !== null && Date.now() - this.status.lastTick.at < 120_000;
    return ticking && this.status.lastError === null && this.status.balanceWei >= this.minBalanceWei;
  }
}
