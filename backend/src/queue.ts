import { CRYPTO } from "./identifiers";
import type { Candidate, Reading, SourceName } from "./store";

/**
 * The CRE workflow's candidate queue. The workflow measures candidates through the collector and
 * ignores a reading older than its source's `maxAgeSec`, so a candidate is offered only while it
 * has a reading the workflow can use: one it cannot measure, or crypto smart money has not
 * confirmed, would be turned down and only cost a run its turn.
 */

/** The workflow's `sources.<name>.maxAgeSec` (apps/cre-oracle configs; a test keeps them equal). */
export const READING_MAX_AGE_SEC: Readonly<Record<SourceName, number>> = {
  elfa: 43_200,
  gdelt: 7_200,
  nansen: 43_200,
  wikipedia: 172_800,
  bluesky: 7_200,
  hn: 10_800,
};

/**
 * Sources that measure attention on their own. Smart money only shapes an index alongside them,
 * and Hacker News only lifts one (it counts for tech topics and is silent on the rest).
 */
const ATTENTION: readonly SourceName[] = ["elfa", "gdelt", "wikipedia", "bluesky"];

/** Bluesky carries about a tenth of X's posts: a Bluesky count times this ranks with Elfa's. */
export const BLUESKY_TO_X = 10;

/** A reading's value while the workflow still accepts it, otherwise null. */
export function usable(r: Reading | undefined, source: SourceName, nowSec: number): number | null {
  return r !== undefined && nowSec - r.observedAt <= READING_MAX_AGE_SEC[source] ? r.value : null;
}

/**
 * A topic's mentions in the last day, on one scale: Elfa's X and Telegram count when it has a
 * usable one, else Bluesky's scaled to X, else Elfa's last count however old. The queue ranks
 * candidates by it, and rotation compares a live trend with the queue by it.
 */
export function mentionsOf(r: Partial<Record<SourceName, Reading>> | undefined, nowSec: number): number {
  const elfa = usable(r?.elfa, "elfa", nowSec);
  if (elfa !== null) return elfa;
  const bluesky = usable(r?.bluesky, "bluesky", nowSec);
  return bluesky !== null ? bluesky * BLUESKY_TO_X : (r?.elfa?.value ?? 0);
}

export interface QueueOptions {
  nowSec: number;
  /** Net smart-money inflow (USD, 24h) a crypto candidate needs, as the workflow requires. */
  confirmNetflowUsd: number;
  /** Tickers Perpl lists, upper case. */
  tradable: ReadonlySet<string>;
  /**
   * Topics an admin kept live (base identifiers). Pins go only on live trends, so a pinned topic
   * waiting here was retired and lists again: it goes first and, if crypto, needs no smart-money
   * inflow (the workflow vouches for it on the pin).
   */
  pinned?: ReadonlySet<string>;
}

/**
 * Approved candidates the workflow could list now, in priority order: kept (pinned) topics, then assets Perpl lists
 * (their cards trade them), then the most-mentioned (on X, or on Bluesky while Elfa is silent). The workflow takes the queue in turns, so the
 * order decides who goes first in each turn and the filter keeps turns for candidates that can win.
 */
export function rankQueue(approved: readonly Candidate[], latest: ReadonlyMap<string, Partial<Record<SourceName, Reading>>>, opts: QueueOptions): Candidate[] {
  return approved
    .map((c) => {
      const r = latest.get(c.identifier) ?? {};
      const read = (s: SourceName) => usable(r[s], s, opts.nowSec);
      const measurable = ATTENTION.some((s) => (read(s) ?? 0) > 0);
      const kept = opts.pinned?.has(c.identifier) ? 1 : 0;
      const confirmed = c.assetClass !== CRYPTO || kept === 1 || (read("nansen") ?? 0) >= Math.max(opts.confirmNetflowUsd, 1e-9);
      const perpl = c.assetClass === CRYPTO && c.ticker !== null && opts.tradable.has(c.ticker.toUpperCase()) ? 1 : 0;
      // Elfa's count when it has one, else Bluesky's scaled to X, so ranking survives an Elfa outage.
      return { c, ok: measurable && confirmed, kept, perpl, mentions: mentionsOf(r, opts.nowSec) };
    })
    .filter((x) => x.ok)
    .sort((x, y) => y.kept - x.kept || y.perpl - x.perpl || y.mentions - x.mentions || x.c.identifier.localeCompare(y.c.identifier))
    .map((x) => x.c);
}
