import { type Book, type Level, MIN_SIZE, PRICE_PRECISION, SIZE_PRECISION, TAKER_FEE_BPS, TICK } from "./book";

export interface QuoteParams {
  /** Distance from fair value to the first bid and ask, as a price (0.02 = 2 cents). */
  halfSpread: number;
  /** Extra distance per further level. */
  levelStep: number;
  levels: number;
  /** Tokens per level. */
  levelTokens: number;
  /** Largest shift of the quotes against net inventory, as a price. */
  maxSkew: number;
  /** Net UP minus DOWN tokens at which the skew is largest and the side adding to it stops. */
  inventoryLimit: number;
}

export interface Ladder {
  bids: Level[];
  asks: Level[];
}

export interface Holdings {
  /** Tokens the market maker holds or has resting in asks, per side. */
  up: number;
  down: number;
  /** AUSD available to back bids in this series. */
  ausd: number;
}

const toBidUnits = (p: number) => Math.floor((p * PRICE_PRECISION) / TICK + 1e-9) * TICK;
const toAskUnits = (p: number) => Math.ceil((p * PRICE_PRECISION) / TICK - 1e-9) * TICK;
const LOWEST = TICK;
const HIGHEST = PRICE_PRECISION - TICK;
const tokensToSize = (t: number) => BigInt(Math.floor(t * SIZE_PRECISION));

/**
 * Bid and ask ladders for UP around `p` and for DOWN around 1 - p, skewed against net inventory.
 * The asks of the two sides always sum to more than 1 AUSD and the bids to less, so the quotes
 * never offer a complete set below or above its redemption value.
 */
export function ladders(p: number, h: Holdings, q: QuoteParams): { up: Ladder; down: Ladder } {
  const net = h.up - h.down;
  const pressure = Math.max(-1, Math.min(1, net / q.inventoryLimit));
  const skew = -q.maxSkew * pressure;
  const side = (center: number, held: number, budget: number, buyAllowed: boolean): Ladder => {
    const bids: Level[] = [];
    const asks: Level[] = [];
    let ausdLeft = budget;
    let tokensLeft = held;
    for (let i = 0; i < q.levels; i++) {
      const off = q.halfSpread + i * q.levelStep;
      const bid = toBidUnits(center - off);
      const ask = toAskUnits(center + off);
      const bidCost = (bid / PRICE_PRECISION) * q.levelTokens;
      if (buyAllowed && bid >= LOWEST && bidCost <= ausdLeft) {
        bids.push({ price: bid, size: tokensToSize(q.levelTokens) });
        ausdLeft -= bidCost;
      }
      const askTokens = Math.min(q.levelTokens, tokensLeft);
      if (ask <= HIGHEST && tokensToSize(askTokens) >= MIN_SIZE) {
        asks.push({ price: ask, size: tokensToSize(askTokens) });
        tokensLeft -= askTokens;
      }
    }
    return { bids, asks };
  };
  // Long UP: stop buying more UP; long DOWN: stop buying more DOWN.
  const up = side(p + skew, h.up, h.ausd / 2, net < q.inventoryLimit);
  const down = side(1 - p - skew, h.down, h.ausd / 2, -net < q.inventoryLimit);
  return { up, down };
}

/**
 * Keeps a ladder off other traders' prices: Kuru rejects a post-only batch whose bid would cross
 * the best ask (or ask the best bid) with PostOnlyError, which would leave the market unquoted.
 * Levels that would cross are dropped; the book's own price wins until it moves.
 */
export function clampToBook(want: Ladder, others: Book): Ladder {
  const bestAsk = others.asks[0]?.price;
  const bestBid = others.bids[0]?.price;
  return {
    bids: bestAsk === undefined ? want.bids : want.bids.filter((l) => l.price < bestAsk),
    asks: bestBid === undefined ? want.asks : want.asks.filter((l) => l.price > bestBid),
  };
}

export type Urgency = "none" | "drift" | "urgent";

/**
 * How badly resting orders need a re-quote. Urgent: a level appeared or vanished, a level is less
 * than half filled-in (someone traded), or a price is off by twice the threshold, so the quotes
 * are mispriced. Drift: a price is off by the threshold or more, worth fixing but not at any
 * cost, so the engine spaces drift re-quotes out.
 */
export function requoteUrgency(live: Ladder, want: Ladder, thresholdTicks: number): Urgency {
  let drift = false;
  for (const [a, b] of [[live.bids, want.bids], [live.asks, want.asks]] as const) {
    if (a.length !== b.length) return "urgent";
    for (const [i, l] of a.entries()) {
      const off = Math.abs(l.price - b[i]!.price);
      if (l.size * 2n < b[i]!.size || off >= 2 * thresholdTicks * TICK) return "urgent";
      if (off >= thresholdTicks * TICK) drift = true;
    }
  }
  return drift ? "drift" : "none";
}

/** Whether resting orders have drifted far enough from the wanted ladder to pay for a re-quote. */
export function needsRequote(live: Ladder, want: Ladder, thresholdTicks: number): boolean {
  return requoteUrgency(live, want, thresholdTicks) !== "none";
}

/**
 * The series worth quoting when gas limits how many: 24-hour windows before longer ones (most
 * trading happens there), then by attention, highest first, keeping the order stable.
 */
export function pickSeries<T extends { window: number; trendId: string }>(series: readonly T[], index: ReadonlyMap<string, bigint>, max: number): T[] {
  return [...series]
    .sort((a, b) => {
      if (a.window !== b.window) return a.window - b.window;
      const ia = index.get(a.trendId) ?? 0n;
      const ib = index.get(b.trendId) ?? 0n;
      return ia === ib ? 0 : ia > ib ? -1 : 1;
    })
    .slice(0, max);
}

export type Arbitrage =
  | { kind: "buyBoth"; tokens: number; upCost: number; downCost: number; edge: number }
  | { kind: "sellBoth"; tokens: number; upProceeds: number; downProceeds: number; edge: number };

const FEE = TAKER_FEE_BPS / 10_000;

/**
 * Finds a complete-set arbitrage against other traders' orders: buying UP and DOWN for less than
 * 1 AUSD a pair and redeeming, or minting a pair for 1 AUSD and selling both for more. Kuru takes
 * its taker fee from what the taker receives. Returns the largest size whose last pair still
 * clears `minEdge`, capped at `maxTokens`.
 */
export function findArbitrage(up: Book, down: Book, minEdge: number, maxTokens: number): Arbitrage | null {
  const walk = (a: Level[], b: Level[], profitable: (pa: number, pb: number) => boolean) => {
    let i = 0;
    let j = 0;
    let ra = a[0] ? Number(a[0].size) / SIZE_PRECISION : 0;
    let rb = b[0] ? Number(b[0].size) / SIZE_PRECISION : 0;
    let tokens = 0;
    let costA = 0;
    let costB = 0;
    while (i < a.length && j < b.length && tokens < maxTokens) {
      const pa = a[i]!.price / PRICE_PRECISION;
      const pb = b[j]!.price / PRICE_PRECISION;
      if (!profitable(pa, pb)) break;
      const take = Math.min(ra, rb, maxTokens - tokens);
      tokens += take;
      costA += take * pa;
      costB += take * pb;
      ra -= take;
      rb -= take;
      if (ra <= 1e-9 && ++i < a.length) ra = Number(a[i]!.size) / SIZE_PRECISION;
      if (rb <= 1e-9 && ++j < b.length) rb = Number(b[j]!.size) / SIZE_PRECISION;
    }
    return { tokens, costA, costB };
  };

  // Buying gives (1 - fee) tokens per token paid for; a pair redeems for 1.
  const buy = walk(up.asks, down.asks, (pa, pb) => (1 - FEE) - (pa + pb) >= minEdge);
  if (buy.tokens >= 1) {
    return { kind: "buyBoth", tokens: buy.tokens, upCost: buy.costA, downCost: buy.costB, edge: buy.tokens * (1 - FEE) - buy.costA - buy.costB };
  }
  // Selling a minted pair returns (1 - fee) of both bids.
  const sell = walk(up.bids, down.bids, (pa, pb) => (pa + pb) * (1 - FEE) - 1 >= minEdge);
  if (sell.tokens >= 1) {
    return {
      kind: "sellBoth",
      tokens: sell.tokens,
      upProceeds: sell.costA * (1 - FEE),
      downProceeds: sell.costB * (1 - FEE),
      edge: (sell.costA + sell.costB) * (1 - FEE) - sell.tokens,
    };
  }
  return null;
}
