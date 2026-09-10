import type { Config } from "./config";
import type { HttpRequest } from "./http";
import { baseOf } from "./identifiers";
import { boostedPoints, type Component, normalizeCount, normalizeFlow, phasedWeight, seasonalFactor } from "./index-method";
import { runNumber } from "./schedule";
import * as candidates from "./sources/candidates";
import * as collector from "./sources/collector";
import * as elfa from "./sources/elfa";
import * as nansen from "./sources/nansen";
import * as reddit from "./sources/reddit";
import * as wikipedia from "./sources/wikipedia";

/** Sends one request and returns status and UTF-8 body; injected so tests need no network. */
export type Send = (req: HttpRequest) => { status: number; body: string };

export interface Secrets {
  elfaApiKey: string;
  redditClientId: string;
  redditClientSecret: string;
  nansenApiKey: string;
  /** Bearer token for the backend's candidate queue and collector. */
  backendToken: string;
}

export interface Target {
  identifier: string;
  keywords: string[];
  /** Ticker for crypto targets (smart-money flows), otherwise null. */
  ticker: string | null;
  /** Wikipedia article, or null when there is no sensible one. */
  article: string | null;
}

/** Which sources run this execution and how, given config and secrets. */
export function activeSources(cfg: Config, s: Secrets) {
  const src = cfg.sources;
  const hasCollector = cfg.collector.measurementsUrl.length > 0;
  const via = (enabled: boolean, mode: "direct" | "collector", directReady: boolean) => ({
    direct: enabled && mode === "direct" && directReady,
    collector: enabled && mode === "collector" && hasCollector,
  });
  const out = {
    elfa: via(src.elfa.enabled, src.elfa.mode, s.elfaApiKey.length > 0),
    gdelt: via(src.gdelt.enabled, "collector", false),
    bluesky: via(src.bluesky.enabled, "collector", false),
    hn: via(src.hn.enabled, "collector", false),
    wikipedia: via(src.wikipedia.enabled, src.wikipedia.mode, true),
    nansen: via(src.nansen.enabled, src.nansen.mode, s.nansenApiKey.length > 0),
    reddit: src.reddit.enabled && s.redditClientId.length > 0 && s.redditClientSecret.length > 0,
    candidatesUrl: cfg.discovery.candidatesUrl.length > 0,
    elfaTrending: cfg.discovery.elfaTrending.enabled && src.elfa.enabled && s.elfaApiKey.length > 0,
    collector: false,
  };
  out.collector = out.elfa.collector || out.gdelt.collector || out.wikipedia.collector || out.nansen.collector || out.bluesky.collector || out.hn.collector;
  return out;
}

/** True when at least one attention source (not smart money or a Hacker News boost alone) can measure. */
export function anyAttentionSource(cfg: Config, s: Secrets): boolean {
  const a = activeSources(cfg, s);
  return a.elfa.direct || a.elfa.collector || a.gdelt.collector || a.bluesky.collector || a.wikipedia.direct || a.wikipedia.collector || a.reddit;
}

function ok(res: { status: number; body: string }, what: string): string {
  if (res.status < 200 || res.status >= 300) throw new Error(`${what}: HTTP ${res.status}`);
  return res.body;
}

/**
 * Node mode: collects candidates from the backend queue, configured seeds and Elfa trending
 * tokens, and returns them as canonical JSON so consensus can require identical output. `runAt`
 * (the scheduled run time) rotates which candidates this run considers: each run moves on by
 * `perRun`, the number of candidates a run samples, so consecutive runs walk the queue in its
 * ranked order and every candidate is measured within a few runs.
 */
export function discover(send: Send, cfg: Config, s: Secrets, runAt: number, perRun = cfg.discovery.maxCandidatesPerRun): string {
  const active = activeSources(cfg, s);
  const lists: candidates.Candidate[][] = [];
  if (active.candidatesUrl) {
    try {
      const res = send(candidates.candidatesRequest(cfg.discovery.candidatesUrl, s.backendToken));
      lists.push(candidates.parseCandidates(ok(res, "candidates")));
    } catch {
      // The queue is optional: seeds and trending still apply.
    }
  }
  lists.push(
    cfg.discovery.seedCandidates
      .map((c) => candidates.toCandidate(c.identifier, c.keywords, c.surfacer))
      .filter((c): c is candidates.Candidate => c !== null),
  );
  if (active.elfaTrending) {
    try {
      const t = cfg.discovery.elfaTrending;
      const res = send(elfa.trendingTokensRequest(cfg.sources.elfa.baseUrl, s.elfaApiKey, t.timeWindow, t.minMentions));
      lists.push(candidates.fromTrendingTokens(elfa.parseTrendingTokens(ok(res, "elfa trending")), t.maxCandidates));
    } catch {
      // Trending is optional.
    }
  }
  const max = cfg.discovery.maxCandidatesPerRun * 3;
  // Each run moves the window by the candidates it samples, so the windows tile the queue.
  const rotation = runNumber(runAt, cfg.schedule) * Math.max(1, perRun);
  return JSON.stringify(candidates.canonicalCandidates(lists, max, rotation));
}

/** Field names for slot `k`: points, smart-money flow and whether the flow is known. */
export const fields = (k: number) => ({ points: `p${k}`, flow: `f${k}`, hasFlow: `n${k}` }) as const;
export const MISSING = -1;

/**
 * Node mode: measures every target and returns flat numeric fields for per-field median
 * consensus. A source that fails, or a collector reading that is too old, only removes its
 * component; a target with no component at all reports MISSING.
 */
export function measure(send: Send, cfg: Config, s: Secrets, targets: readonly Target[], observedAt: number): Record<string, number> {
  const active = activeSources(cfg, s);
  const src = cfg.sources;
  const hour = new Date(observedAt * 1000).getUTCHours();

  let collected: Map<string, collector.Collected> | null = null;
  if (active.collector && targets.length > 0) {
    try {
      const req = collector.measurementsRequest(
        cfg.collector.measurementsUrl,
        s.backendToken,
        targets.map((t) => baseOf(t.identifier)),
      );
      collected = collector.parseMeasurements(ok(send(req), "collector"));
    } catch {
      collected = null;
    }
  }

  let redditToken: string | null = null;
  if (active.reddit && targets.length > 0) {
    try {
      redditToken = reddit.parseToken(ok(send(reddit.tokenRequest(s.redditClientId, s.redditClientSecret, src.reddit.userAgent)), "reddit token"));
    } catch {
      redditToken = null;
    }
  }

  let flows: Map<string, number> | null = null;
  if (active.nansen.direct && targets.some((t) => t.ticker !== null)) {
    try {
      flows = nansen.parseNetflow(ok(send(nansen.netflowRequest(src.nansen.baseUrl, s.nansenApiKey, src.nansen.chains)), "nansen"));
    } catch {
      flows = null;
    }
  }

  const out: Record<string, number> = {};
  targets.forEach((t, k) => {
    const f = fields(k);
    const components: Component[] = [];
    const got = collected?.get(baseOf(t.identifier));
    const reading = (source: collector.CollectedSource, maxAge: number) => collector.fresh(got?.readings[source], observedAt, maxAge);

    // Elfa: mentions over the last day. A day-long window has no time-of-day pattern to remove.
    let mentions: number | null = null;
    if (active.elfa.direct) {
      try {
        mentions = elfa.parseKeywordMentions(
          ok(send(elfa.keywordMentionsRequest(src.elfa.baseUrl, s.elfaApiKey, t.keywords, observedAt - elfa.MENTIONS_WINDOW_SEC, observedAt)), "elfa mentions"),
        );
      } catch {
        mentions = null;
      }
    } else if (active.elfa.collector) {
      mentions = reading("elfa", src.elfa.maxAgeSec);
    }
    const elfaWeight = phasedWeight(src.elfa.weight, src.elfa.phaseIn, observedAt);
    if (mentions !== null && elfaWeight > 0) {
      components.push({ value: normalizeCount(mentions, src.elfa.clip, src.elfa.saturation, seasonalFactor(src.elfa.seasonality, hour)), weight: elfaWeight });
    }

    if (active.gdelt.collector) {
      const articles = reading("gdelt", src.gdelt.maxAgeSec);
      if (articles !== null) {
        components.push({ value: normalizeCount(articles, src.gdelt.clip, src.gdelt.saturation, seasonalFactor(src.gdelt.seasonality, hour)), weight: src.gdelt.weight });
      }
    }

    if (redditToken !== null) {
      try {
        const r = src.reddit;
        const activity = reddit.parseSearch(ok(send(reddit.searchRequest(redditToken, t.keywords, r.userAgent)), "reddit search"), observedAt - cfg.windowSec, observedAt);
        components.push({
          value: normalizeCount(reddit.activityCount(activity, r.engagementPerPost), r.clip, r.saturation, seasonalFactor(r.seasonality, hour)),
          weight: r.weight,
        });
      } catch {
        // Missing component.
      }
    }

    let views: number | null = null;
    // The backend checks its article against Wikipedia, so it beats one derived from the identifier.
    const article = got?.article ?? t.article;
    if (active.wikipedia.direct && article !== null) {
      try {
        const w = src.wikipedia;
        views = wikipedia.parsePageviews(ok(send(wikipedia.pageviewsRequest(w.project, article, wikipedia.lastCompleteDay(observedAt), w.userAgent)), "wikipedia"));
      } catch {
        // Missing component, for example an article that does not exist.
      }
    } else if (active.wikipedia.collector) {
      views = reading("wikipedia", src.wikipedia.maxAgeSec);
    }
    if (views !== null) components.push({ value: normalizeCount(views, src.wikipedia.clip, src.wikipedia.saturation, 1), weight: src.wikipedia.weight });

    // Bluesky: posts over the last day, weighted in over its phase-in.
    if (active.bluesky.collector) {
      const posts = reading("bluesky", src.bluesky.maxAgeSec);
      const b = src.bluesky;
      const weight = phasedWeight(b.weight, b.phaseIn, observedAt);
      if (posts !== null && weight > 0) components.push({ value: normalizeCount(posts, b.clip, b.saturation, seasonalFactor(b.seasonality, hour)), weight });
    }

    let flow: number | null = null;
    if (t.ticker !== null) {
      if (flows !== null) flow = flows.get(t.ticker) ?? 0;
      else if (active.nansen.collector) flow = reading("nansen", src.nansen.maxAgeSec);
    }
    // Smart money only shapes the index alongside real attention measurements.
    if (flow !== null && components.length > 0) {
      components.push({ value: normalizeFlow(flow, src.nansen.scaleUsd), weight: src.nansen.weight });
    }

    // Hacker News only lifts an index: most topics never reach it, and its silence is no signal.
    const boosts: Component[] = [];
    if (active.hn.collector) {
      const mentions = reading("hn", src.hn.maxAgeSec);
      const h = src.hn;
      const weight = phasedWeight(h.weight, h.phaseIn, observedAt);
      if (mentions !== null && weight > 0) boosts.push({ value: normalizeCount(mentions, h.clip, h.saturation, seasonalFactor(h.seasonality, hour)), weight });
    }

    const points = boostedPoints(components, boosts);
    out[f.points] = points === null ? MISSING : Math.round(points * 100) / 100;
    out[f.flow] = flow ?? 0;
    out[f.hasFlow] = flow === null ? 0 : 1;
  });
  return out;
}

/** HTTP calls one execution will make outside the per-target ones. */
export function fixedCalls(cfg: Config, s: Secrets, anyCrypto: boolean): number {
  const a = activeSources(cfg, s);
  return (a.candidatesUrl ? 1 : 0) + (a.elfaTrending ? 1 : 0) + (a.collector ? 1 : 0) + (a.reddit ? 1 : 0) + (a.nansen.direct && anyCrypto ? 1 : 0);
}

export function perTargetCalls(cfg: Config, s: Secrets): number {
  const a = activeSources(cfg, s);
  return (a.elfa.direct ? 1 : 0) + (a.reddit ? 1 : 0) + (a.wikipedia.direct ? 1 : 0);
}
