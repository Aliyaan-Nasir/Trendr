/**
 * Fair value of an UP token: the probability that a trend's attention index ends above the
 * series' opening index, since UP pays 1 AUSD then and DOWN pays 1 AUSD otherwise (ties go DOWN).
 *
 * The index is modelled as a mixture. With probability q = exp(-lambda * tau) it does not change
 * again before expiry, and UP wins exactly when it is already above the opening level. Otherwise it
 * diffuses in log terms with variance rate sigma^2, and UP wins with probability
 * N(ln(I / I0) / (sigma * sqrt(tau))). Both rates are estimated from the registry's checkpoints and
 * shrunk towards a prior, so a young trend with little history is priced conservatively.
 *
 * contracts/src/spot/AttentionPricing.sol is this model with DEFAULT_PRIOR fixed, the anchor
 * TrendrSpot holds session trades to; change the two together.
 */

/** Standard normal CDF (Abramowitz and Stegun 7.1.26, error below 1.5e-7). */
export function normCdf(x: number): number {
  const t = 1 / (1 + 0.3275911 * Math.abs(x) / Math.SQRT2);
  const poly = t * (0.254829592 + t * (-0.284496736 + t * (1.421413741 + t * (-1.453152027 + t * 1.061405429))));
  const erf = 1 - poly * Math.exp(-(x * x) / 2);
  return x >= 0 ? 0.5 * (1 + erf) : 0.5 * (1 - erf);
}

export interface Checkpoint {
  /** Seconds. */
  at: number;
  /** Index points (registry units / 1e6). */
  index: number;
}

export interface Dynamics {
  /** Log-variance per second while the index moves. */
  variancePerSec: number;
  /** Index changes per second. */
  changesPerSec: number;
}

export interface DynamicsPrior extends Dynamics {
  /** How many seconds of history the prior is worth. */
  weightSec: number;
}

/** Roughly 60% daily log volatility and a change every ten minutes, worth six hours of data. */
export const DEFAULT_PRIOR: DynamicsPrior = { variancePerSec: 0.36 / 86_400, changesPerSec: 1 / 600, weightSec: 6 * 3600 };

/** Estimates the index dynamics from checkpoints in time order, shrunk towards `prior`. */
export function estimateDynamics(history: readonly Checkpoint[], prior: DynamicsPrior = DEFAULT_PRIOR): Dynamics {
  let sumSq = 0;
  let changes = 0;
  let span = 0;
  for (let i = 1; i < history.length; i++) {
    const a = history[i - 1]!;
    const b = history[i]!;
    const dt = b.at - a.at;
    if (dt <= 0 || a.index <= 0 || b.index <= 0) continue;
    const r = Math.log(b.index / a.index);
    sumSq += r * r;
    if (r !== 0) changes++;
    span += dt;
  }
  return {
    variancePerSec: (sumSq + prior.variancePerSec * prior.weightSec) / (span + prior.weightSec),
    changesPerSec: (changes + prior.changesPerSec * prior.weightSec) / (span + prior.weightSec),
  };
}

export interface FairInput {
  index: number;
  opening: number;
  /** Seconds to expiry. */
  tau: number;
  dynamics: Dynamics;
}

/** Bounds keep quotes away from prices that only make sense with certainty. */
export const MIN_PROBABILITY = 0.02;
export const MAX_PROBABILITY = 0.98;

/** Probability that UP wins, bounded away from 0 and 1. */
export function fairUp({ index, opening, tau, dynamics }: FairInput): number {
  const above = index > opening ? 1 : 0;
  let p: number;
  if (tau <= 0) {
    p = above;
  } else {
    const stay = Math.exp(-dynamics.changesPerSec * tau);
    const sd = Math.sqrt(dynamics.variancePerSec * tau);
    const diffuse = sd > 0 ? normCdf(Math.log(index / opening) / sd) : above;
    p = stay * above + (1 - stay) * diffuse;
  }
  return Math.min(MAX_PROBABILITY, Math.max(MIN_PROBABILITY, p));
}
