import { z } from "zod";

const address = z.string().regex(/^0x[0-9a-fA-F]{40}$/, "expected a 20-byte hex address");
// A pattern instead of zod's URL check, which needs the URL class the WASM sandbox lacks.
const httpsUrl = z.string().regex(/^https:\/\/[a-z0-9.-]+(:\d+)?(\/[^\s]*)?$/i, "expected an https URL");
/** An https URL, or plain http to this machine for a local backend in simulation. */
const serviceUrl = z
  .string()
  .regex(/^(https:\/\/[a-z0-9.-]+|http:\/\/(localhost|127\.0\.0\.1))(:\d+)?(\/[^\s]*)?$/i, "expected an https URL (http only for localhost)");

/**
 * Where a source's measurement comes from: `direct` calls the source from every node (paid keys),
 * `collector` reads the backend collector's latest reading, which paces free-tier budgets.
 */
const mode = z.enum(["direct", "collector"]);
/** A collector reading older than this is ignored, so a stalled collector cannot freeze the index. */
const maxAgeSec = z.number().int().positive();

/**
 * Ramps a source's weight from 0 at `fromSec` to its full weight `durationSec` later (scheduled run
 * time), so adding a source to live trends moves their indices gradually instead of in one step.
 */
const phaseIn = z.object({
  fromSec: z.number().int().nonnegative(),
  durationSec: z.number().int().positive(),
});

/** Per-source count parameters. See docs/index-method.md for how they enter the index. */
const countSource = z.object({
  enabled: z.boolean(),
  /** Relative weight in the index. */
  weight: z.number().positive(),
  /** Winsorization cap on the raw measurement (outlier clip). */
  clip: z.number().positive(),
  /** Deseasonalized measurement that maps to 1.0 after log scaling. */
  saturation: z.number().positive(),
  /** Relative activity by UTC hour (24 values); divided by its mean, so only the shape matters. */
  seasonality: z.array(z.number().positive()).length(24),
});

export const configSchema = z.object({
  /** CRE cron schedule (6 fields, seconds first). */
  schedule: z.string().min(1),
  chainSelectorName: z.enum(["monad-testnet", "monad-mainnet"]),
  registry: address,
  lens: address,
  /** Reddit's measurement window ending at the observation time, in seconds. */
  windowSec: z.number().int().min(300).max(86_400),
  sources: z.object({
    /** X and Telegram mentions over the last 24 hours (Elfa's shortest keyword-mentions window). */
    elfa: countSource.extend({
      mode,
      maxAgeSec,
      baseUrl: httpsUrl,
      phaseIn: phaseIn.optional(),
    }),
    /** Worldwide news articles over the last day; collector only (GDELT allows one request per 5 s per client). */
    gdelt: countSource.extend({
      maxAgeSec,
    }),
    /** Direct only, and only with Reddit API access. */
    reddit: countSource.extend({
      /** Engagement (score plus comments) counted as one post per this many points. */
      engagementPerPost: z.number().positive(),
      userAgent: z.string().min(1),
    }),
    wikipedia: countSource.extend({
      mode,
      maxAgeSec,
      /** Wikimedia project, for example `en.wikipedia`. */
      project: z.string().min(1),
      userAgent: z.string().min(1),
    }),
    /** Bluesky posts over the last 24 hours; collector only (one search per trend at a polite pace). */
    bluesky: countSource.extend({
      maxAgeSec,
      phaseIn: phaseIn.optional(),
    }),
    /**
     * Hacker News stories and comments over the last 24 hours; collector only. A boost: it enters
     * only when it would raise the index, since most topics never reach Hacker News.
     */
    hn: countSource.extend({
      maxAgeSec,
      phaseIn: phaseIn.optional(),
    }),
    nansen: z.object({
      enabled: z.boolean(),
      mode,
      maxAgeSec,
      weight: z.number().positive(),
      /** Net smart-money flow (USD, 24h) that moves the component from 0.5 to about 0.88. */
      scaleUsd: z.number().positive(),
      /** Net smart-money inflow (USD, 24h) a crypto trend needs before markets open. */
      minConfirmNetflowUsd: z.number().nonnegative(),
      chains: z.array(z.string()).min(1),
      baseUrl: httpsUrl,
    }),
  }),
  collector: z.object({
    /** Backend endpoint serving the latest reading per source for each trend (GET, JSON). */
    measurementsUrl: z.union([serviceUrl, z.literal("")]),
  }),
  discovery: z.object({
    /** Backend candidate queue (GET, JSON); empty to use only seeds and Elfa trending. */
    candidatesUrl: z.union([serviceUrl, z.literal("")]),
    seedCandidates: z.array(
      z.object({
        identifier: z.string(),
        keywords: z.array(z.string()).optional(),
        surfacer: address.optional(),
      }),
    ),
    elfaTrending: z.object({
      enabled: z.boolean(),
      timeWindow: z.string(),
      minMentions: z.number().int().nonnegative(),
      maxCandidates: z.number().int().nonnegative(),
    }),
    maxCandidatesPerRun: z.number().int().min(0).max(10),
    /** No new trends while this many are live; each listing costs the keeper and market maker gas and inventory. */
    maxLiveTrends: z.number().int().min(1),
  }),
  sampling: z.object({
    maxSamplesPerRun: z.number().int().min(1).max(12),
    /** Re-report an unchanged trend at least this often so it stays fresh on chain. */
    heartbeatSec: z.number().int().positive(),
    /** Report a sampled trend when its index moved at least this much (basis points). */
    deviationBps: z.number().int().nonnegative(),
    /** A candidate becomes a trend only at or above this index (points). */
    minCreateIndexPoints: z.number().nonnegative(),
  }),
  /** Keywords per identifier where the identifier alone is ambiguous. */
  keywordOverrides: z.record(z.string(), z.array(z.string()).min(1)),
  /** Wikipedia article per identifier where the derived title would be wrong or ambiguous. */
  wikiArticles: z.record(z.string(), z.string().min(1)),
  scan: z.object({
    pageSize: z.number().int().min(1).max(20),
    scanLimit: z.number().int().min(1),
    maxPages: z.number().int().min(1).max(10),
  }),
  gas: z.object({
    base: z.number().int().positive(),
    perNewTrend: z.number().int().positive(),
    perUpdate: z.number().int().positive(),
    perSettlement: z.number().int().positive(),
    max: z.number().int().positive().max(10_000_000),
  }),
});

export type Config = z.infer<typeof configSchema>;
