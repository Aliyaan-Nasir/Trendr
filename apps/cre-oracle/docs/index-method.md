# Attention index method

This is how the CRE workflow turns raw attention into the index that TrendRegistry stores.
Every DON node computes it independently, and consensus takes the median of the nodes' results.
The code lives in `attention-index/src/index-method.ts` and `attention-index/src/measure.ts`.

## Measurements

The observation time `t` is the cron run's scheduled time.

| Source | Measurement `x` | Notes |
| - | - | - |
| Elfa (X and Telegram) | Mentions of the trend's keywords over the last 24 hours (`metadata.total`, capped at 10,000 by Elfa) | One credit per trend; Elfa rejects windows shorter than one day |
| GDELT | News articles worldwide matching the keywords over the last day | Keyless; one request per 5 seconds per client |
| Bluesky | Posts matching any keyword over the last 24 hours (`searchPosts` `hitsTotal`, capped at 10,000 by Bluesky; keywords ORed with `\|`, cashtags left out) | Keyless public AppView; one search per trend, a second apart |
| Hacker News | Stories and comments mentioning a keyword over the last 24 hours (Algolia `nbHits`, typo tolerance off), summed over up to three keywords, cashtags left out | Keyless; a boost, see below |
| Wikipedia | Human views of the trend's article over the last complete UTC day | Keyless; slow-moving baseline |
| Reddit | Posts in the last hour plus their score and comments divided by `engagementPerPost` | Off until Reddit grants API access |
| Nansen (crypto only) | Net smart-money flow in USD over 24 hours, summed across chains | Shapes the index and gates new crypto trends |

Keywords come from the trend radar (an AI proposal checked against the source) or, for trends without one, from the identifier itself (`topic:world-cup` gives "world cup", `crypto:mon` gives "$MON").
Wikipedia titles are checked against Wikipedia, because pageviews do not follow redirects.

## Where measurements come from

Each source runs in one of two modes, set per source in the config.

- `direct`: every DON node calls the source itself on every run.
  This is the production design and needs keys whose rate limits allow it.
- `collector`: the workflow reads the latest reading per source for every sampled trend from the backend collector, in one HTTP call (`collector.measurementsUrl`, bearer `BACKEND_TOKEN`).
  API budgets cannot answer a run every minute (Elfa's monthly credits, Nansen 10 credits a day, GDELT one request per 5 seconds), so the collector (`backend/src/collector.ts`) measures each trend at the pace each budget sustains and keeps the newest reading.
  A reading older than the source's `maxAgeSec` is ignored, so a stalled collector removes a component instead of freezing the index.

Testnet runs every source in collector mode on free plans.
GDELT, Bluesky and Hacker News are collector only: a DON calling them from every node on every run would break their per-IP limits.
Switching a source to `direct` needs only its key in the workflow secrets and the config change; the index method is the same either way.

## From measurement to a component in [0, 1]

For every count source `s` with clip `C_s`, saturation `K_s` and hourly seasonal profile `S_s`:

1. Clip outliers: `x1 = min(x, C_s)`.
2. Deseasonalize: `x2 = x1 / f_s(h)`, where `f_s(h) = S_s[h] / mean(S_s)` for the observation's UTC hour `h`.
   Day-long measurements (Elfa, GDELT, Wikipedia, Bluesky, Hacker News) have no time-of-day pattern, so their profiles are flat; Reddit's hourly window keeps its profile.
3. Normalize on a log scale: `n_s = clamp(ln(1 + x2) / ln(1 + K_s), 0, 1)`.
   Attention is heavy-tailed, so the log scale keeps both niche and mainstream trends on a usable range, and `K_s` is the level that counts as maximal attention.

The Nansen component is `n_nansen = 0.5 + 0.5 * tanh(F / scale)` for net flow `F`, so neutral flow scores 0.5, inflows push it toward 1 and outflows toward 0.
It is only included when at least one attention source answered, so smart money alone never moves an index.
Nansen's token filter takes contract addresses, so one call reads every token smart money traded (most traded first, market cap above $1M) and a ticker missing from it had no smart-money flow.

## Combining components

`index = 100 * sum(w_s * n_s) / sum(w_s)`, summed over the components that answered for this trend.
Weights renormalize over available sources, so one API being down shifts the mix instead of zeroing the index.
If no component answered, the trend is not reported this run.

| Source | Weight | Clip | Saturation `K` | Collector `maxAgeSec` |
| - | - | - | - | - |
| Elfa | 0.6 | 10,000 | 5,000 | 43,200 |
| Bluesky | 0.35 | 10,000 | 1,000 | 7,200 |
| GDELT | 0.3 | 20,000 | 3,000 | 7,200 |
| Wikipedia | 0.25 | 5,000,000 | 150,000 | 172,800 |
| Nansen (crypto) | 0.2 | | `scaleUsd` 500,000 | 43,200 |
| Hacker News (boost) | 0.15 | 5,000 | 300 | 10,800 |

Elfa stays the heaviest source whenever it answers.
Bluesky carries about a tenth of X's volume, so its saturation is a fifth of Elfa's (its audience is also less crypto-heavy, so a topic reaches it relatively more than its size suggests).

Hacker News is a boost: most topics never reach it, and a zero there says nothing about attention elsewhere.
It enters the weighted mean only when its component is above the index without it, so it can lift a tech topic and never drags down the rest.
The rule is continuous: at the point where the boost equals the index, including it changes nothing.
On its own (no other attention component) it measures nothing.

### Phasing in a source

A source added to a live deployment changes every live index at once, and an Up/Down series open across that step would settle on the change of method rather than of attention.
A source may therefore carry `phaseIn: { fromSec, durationSec }`: its weight is 0 before `fromSec` (the scheduled run time) and rises linearly to its full weight over `durationSec`, so indices move in many small reports instead of one jump.
Testnet phased Bluesky and Hacker News in over 24 hours from 2026-10-13 02:00 UTC.
A source that is the only component of a trend counts in full as soon as its weight is above 0, since renormalization makes its share 1 whatever the weight; that only affects trends no other source measured, which had no index to jump from.
Remove `phaseIn` once the ramp is over, or leave it: past `fromSec + durationSec` it is the full weight.
Elfa, Bluesky and Hacker News accept `phaseIn`; set it on Elfa too before Elfa comes back after an outage longer than its `maxAgeSec`, since its return is the same step as a new source.
Whatever the method does, TrendRegistry clamps each update to `maxMoveBps` of the last value (50% on Testnet), so a step is at worst spread over a few reports.
The value is rounded to 0.01 points and bounded to [0.01, 100] points, which the registry stores as `points * 1,000,000`.

## Consensus and reporting

- New trends: every node returns the same canonical candidate list (identical aggregation); a candidate becomes a trend when its index is at least `minCreateIndexPoints`, and a crypto candidate also needs smart-money net inflow of at least `minConfirmNetflowUsd`.
  No new trend is created while `maxLiveTrends` are live, since each listing costs keeper and market-maker gas and inventory.
- Candidate order: the backend ranks its queue (assets Perpl lists with smart money buying first, then the most-mentioned, never crypto that smart money is leaving) and the workflow keeps that order; seed and trending candidates rotate with the run's scheduled time, so each gets a turn.
- Values: each index and flow is aggregated with the median across nodes.
- Writes: a measured trend is reported when its heartbeat is due, when it moved at least `deviationBps`, or when one of its outcome series has expired and waits for its settlement observation.
  A report that goes out also carries trends past half their heartbeat, so heartbeats line up and share one transaction's base cost.
  A trend that could not be measured is never re-reported with an old value, so freshness on chain always means a real measurement.
- Settlement: the first observation at or after a series' expiry settles it, so trends at expiry are sampled first and their settlement is recorded in the same report.
- Each run sends at most one report, and a run with nothing to report sends no transaction.

## Budget

A CRE execution may make 15 HTTP calls.
The workflow spends one call each on the candidate queue, the collector (all collector sources in one call), Elfa trending, the Reddit token and Nansen when they apply, and divides the rest among trends at one call per direct source per trend.
In collector mode measuring costs no per-trend calls, so only `maxSamplesPerRun` limits a run.
Trends with an expired series come first, then new candidates, then the trends observed longest ago.
