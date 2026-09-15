import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import type { Address, Hex } from "viem";

/** A series the market maker holds inventory or orders in. */
export interface HeldSeries {
  trendId: Hex;
  window: number;
  expiry: string;
  opening: string;
  up: Address;
  down: Address;
  upMarket: Address;
  downMarket: Address;
  /** Complete sets minted for it, in AUSD. */
  minted: number;
}

export interface MmState {
  /** Our order ids per market; Kuru cannot list orders by owner, so they are remembered here. */
  orders: Record<string, number[]>;
  series: Record<string, HeldSeries>;
  /** Equity at the first tick, for profit and loss. */
  baselineEquity: number | null;
}

const empty = (): MmState => ({ orders: {}, series: {}, baselineEquity: null });

/** Keeps state in a JSON file, written atomically, so a restart can still cancel its orders. */
export class StateStore {
  private cache: MmState | null = null;

  constructor(private readonly path: string) {}

  load(): MmState {
    if (this.cache) return this.cache;
    this.cache = existsSync(this.path) ? { ...empty(), ...(JSON.parse(readFileSync(this.path, "utf8")) as MmState) } : empty();
    return this.cache;
  }

  save(state: MmState): void {
    this.cache = state;
    const tmp = `${this.path}.tmp`;
    writeFileSync(tmp, JSON.stringify(state, null, 2));
    renameSync(tmp, this.path);
  }
}
