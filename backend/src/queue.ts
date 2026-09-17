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

export interface QueueOptions {
  nowSec: number;
  /** Net smart-money inflow (USD, 24h) a crypto candidate needs, as the workflow requires. */
  confirmNetflowUsd: number;
  /** Tickers Perpl lists, upper case. */
  tradable: ReadonlySet<string>;
}

/**
 * Approved candidates the workflow could list now, in priority order: assets Perpl lists first
 * (their cards trade them), then the most-mentioned (on X, or on Bluesky while Elfa is silent). The workflow takes the queue in turns, so the
 * order decides who goes first in each turn and the filter keeps turns for candidates that can win.
 */
export function rankQueue(approved: readonly Candidate[], latest: ReadonlyMap<string, Partial<Record<SourceName, Reading>>>, opts: QueueOptions): Candidate[] {
  return approved
    .map((c) => {
      const r = latest.get(c.identifier) ?? {};
      const read = (s: SourceName) => usable(r[s], s, opts.nowSec);
      const measurable = ATTENTION.some((s) => (read(s) ?? 0) > 0);
      const confirmed = c.assetClass !== CRYPTO || (read("nansen") ?? 0) >= Math.max(opts.confirmNetflowUsd, 1e-9);
      const perpl = c.assetClass === CRYPTO && c.ticker !== null && opts.tradable.has(c.ticker.toUpperCase()) ? 1 : 0;
      // Elfa's count when it has one, else Bluesky's scaled to X, so ranking survives an Elfa outage.
      const bluesky = read("bluesky");
      const mentions = read("elfa") ?? (bluesky !== null ? bluesky * BLUESKY_TO_X : (r.elfa?.value ?? 0));
      return { c, ok: measurable && confirmed, perpl, mentions };
    })
    .filter((x) => x.ok)
    .sort((x, y) => y.perpl - x.perpl || y.mentions - x.mentions || x.c.identifier.localeCompare(y.c.identifier))
    .map((x) => x.c);
}
