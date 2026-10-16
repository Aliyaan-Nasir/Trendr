import {
  ConsensusAggregationByFields,
  type CronPayload,
  consensusIdenticalAggregation,
  EVMClient,
  encodeCallMsg,
  getNetwork,
  HTTPClient,
  LAST_FINALIZED_BLOCK_NUMBER,
  median,
  type NodeRuntime,
  prepareReportRequest,
  type Runtime,
  text,
  TxStatus,
} from "@chainlink/cre-sdk";
import { bytesToHex, type Hex } from "viem";
import { type ChainCall, readIdentifiers, readSnapshot, readStatuses, trendId } from "./chain";
import type { Config } from "./config";
import { base64Utf8, type HttpRequest } from "./http";
import { articleFor, CRYPTO, keywordsFor, MAX_VERSION, tickerOf, versioned } from "./identifiers";
import {
  anyAttentionSource,
  discover,
  type Discovered,
  fields,
  fixedCalls,
  MISSING,
  measure,
  perTargetCalls,
  type Secrets,
  type Send,
  type Target,
} from "./measure";
import { allocate, decide, freeListing, isEmpty, type LiveTrend, type Measurement, sampleSlots } from "./plan";
import { encodeReport, gasLimit } from "./report";
import type { Candidate } from "./sources/candidates";

const ZERO: Hex = "0x0000000000000000000000000000000000000000";
const SECRET_IDS = ["ELFA_API_KEY", "REDDIT_CLIENT_ID", "REDDIT_CLIENT_SECRET", "NANSEN_API_KEY", "BACKEND_TOKEN"] as const;

/** A missing or empty secret disables its source instead of failing the run. */
function readSecrets(runtime: Runtime<Config>): Secrets {
  const value = (id: string): string => {
    try {
      return runtime.getSecret({ id }).result().value.trim();
    } catch {
      return "";
    }
  };
  const [elfa, redditId, redditSecret, nansen, backend] = SECRET_IDS.map(value);
  return {
    elfaApiKey: elfa ?? "",
    redditClientId: redditId ?? "",
    redditClientSecret: redditSecret ?? "",
    nansenApiKey: nansen ?? "",
    backendToken: backend ?? "",
  };
}

function nodeSend(nodeRuntime: NodeRuntime<Config>): Send {
  const http = new HTTPClient();
  return (req: HttpRequest) => {
    const multiHeaders: Record<string, { values: string[] }> = {};
    for (const [k, v] of Object.entries(req.headers)) multiHeaders[k] = { values: [v] };
    const res = http
      .sendRequest(nodeRuntime, {
        url: req.url,
        method: req.method,
        multiHeaders,
        // Protobuf JSON rejects an explicit undefined, so the body key is set only when there is one.
        ...(req.body === undefined ? {} : { body: base64Utf8(req.body) }),
        timeout: "8s",
        // Nodes may reuse one node's response for the same request within the run.
        cacheSettings: { store: true, maxAge: "60s" },
      })
      .result();
    return { status: res.statusCode, body: text(res) };
  };
}

function scheduledSeconds(runtime: Runtime<Config>, payload: CronPayload): number {
  const t = payload.scheduledExecutionTime;
  if (t?.seconds !== undefined) return Number(t.seconds);
  return Math.floor(runtime.now().getTime() / 1000);
}

/** One cron run: read chain state, discover, measure under consensus, report. */
export function onCron(runtime: Runtime<Config>, payload: CronPayload): string {
  const cfg = runtime.config;
  const now = scheduledSeconds(runtime, payload);
  const network = getNetwork({ chainFamily: "evm", chainSelectorName: cfg.chainSelectorName, isTestnet: cfg.chainSelectorName === "monad-testnet" });
  if (!network) throw new Error(`unknown chain ${cfg.chainSelectorName}`);
  const evm = new EVMClient(network.chainSelector.selector);
  const call: ChainCall = (to, data) =>
    bytesToHex(
      evm.callContract(runtime, { call: encodeCallMsg({ from: ZERO, to, data }), blockNumber: LAST_FINALIZED_BLOCK_NUMBER }).result().data,
    );
  const lens = cfg.lens as Hex;

  // 1. Chain state. Run ids are the scheduled time, so a repeated run is a no-op.
  const snapshot = readSnapshot(call, lens, cfg.scan);
  if (BigInt(now) <= snapshot.lastRunId) return `skip: run ${now} already reported`;
  if (!snapshot.complete) runtime.log(`warning: scanned ${snapshot.live.length} live trends before the page limit`);
  const secrets = readSecrets(runtime);

  // 2. Discovery, identical on every node. Runs take turns through the queue, a run's worth of
  // candidates at a time.
  const windowRoom = Math.max(0, cfg.discovery.maxLiveTrends - snapshot.live.length);
  const found: Discovered = JSON.parse(
    runtime
      .runInNodeMode(
        (node: NodeRuntime<Config>) => discover(nodeSend(node), cfg, secrets, now, Math.min(cfg.discovery.maxCandidatesPerRun, windowRoom)),
        consensusIdenticalAggregation<string>(),
      )()
      .result(),
  );
  const discovered = found.candidates;
  // Trends the backend is rotating out are left unmeasured, so the registry retires them as stale,
  // and their slots are free for the queue now.
  const liveNames = readIdentifiers(call, lens, snapshot.live.map((t) => t.id));
  const rotatingOut = new Set(found.rotating);
  const keep = snapshot.live.filter((_, i) => !rotatingOut.has(liveNames[i] ?? ""));
  const nameOf = new Map(snapshot.live.map((t, i) => [t.id, liveNames[i] ?? ""]));
  const room = Math.max(0, cfg.discovery.maxLiveTrends - keep.length);
  const perRun = Math.min(cfg.discovery.maxCandidatesPerRun, room);
  const listable = resolveListings(call, lens, discovered);

  // 3. Plan the run within the HTTP budget.
  const anyCrypto = snapshot.live.some((t) => t.assetClass === CRYPTO) || listable.some((c) => c.candidate.assetClass === CRYPTO);
  if (!anyAttentionSource(cfg, secrets)) return "skip: no attention source is configured";
  const slots = sampleSlots(fixedCalls(cfg, secrets, anyCrypto), perTargetCalls(cfg, secrets), cfg.sampling.maxSamplesPerRun);
  if (slots === 0) return "skip: the HTTP budget leaves no room to measure";
  const plan = allocate(
    keep,
    listable.map((l) => l.candidate),
    slots,
    perRun,
  );
  const planned = listable.filter((l) => plan.candidates.includes(l.candidate));
  const names = plan.trends.map((t) => nameOf.get(t.id) ?? "");
  const targets: Target[] = [
    ...plan.trends.map((_, i) => target(names[i] ?? "", [], cfg)),
    ...planned.map((l) => target(l.identifier, l.candidate.keywords, cfg)),
  ];
  if (targets.length === 0) return "skip: nothing to measure";

  // 4. Measure on every node; median per field.
  const aggregation: Record<string, typeof median> = {};
  targets.forEach((_, k) => {
    const f = fields(k);
    aggregation[f.points] = median;
    aggregation[f.flow] = median;
    aggregation[f.hasFlow] = median;
  });
  const measured = runtime
    .runInNodeMode(
      (node: NodeRuntime<Config>) => measure(nodeSend(node), cfg, secrets, targets, now),
      ConsensusAggregationByFields<Record<string, number>>(aggregation),
    )()
    .result();
  const at = (k: number): Measurement => {
    const f = fields(k);
    const p = measured[f.points] ?? MISSING;
    return { points: p < 0 ? null : p, netflowUsd: (measured[f.hasFlow] ?? 0) >= 1 ? (measured[f.flow] ?? 0) : null };
  };

  // 5. Decide and report.
  const decisions = decide(
    plan.trends.map((trend, k) => ({ trend, m: at(k) })),
    planned.map((l, j) => ({ candidate: l.candidate, identifier: l.identifier, m: at(plan.trends.length + j) })),
    {
      now,
      heartbeatSec: cfg.sampling.heartbeatSec,
      deviationBps: cfg.sampling.deviationBps,
      minCreateIndexPoints: cfg.sampling.minCreateIndexPoints,
      minConfirmNetflowUsd: cfg.sources.nansen.minConfirmNetflowUsd,
    },
  );
  const tried = planned.length > 0 ? `; tried ${planned.map((l) => l.identifier).join(", ")}` : "";
  const summary = `run ${now}: ${decisions.newTrends.length} new, ${decisions.updates.length} updates, ${decisions.settlements.length} settlements (sampled ${targets.length} of ${snapshot.live.length} live, ${snapshot.live.length - keep.length} rotating out, ${discovered.length} candidates${tried})`;
  if (isEmpty(decisions)) return `nothing to report; ${summary}`;

  const report = runtime.report(prepareReportRequest(encodeReport(BigInt(now), BigInt(now), decisions))).result();
  const reply = evm
    .writeReport(runtime, {
      receiver: cfg.registry,
      report,
      gasConfig: { gasLimit: String(gasLimit(decisions, cfg.gas)) },
    })
    .result();
  if (reply.txStatus !== TxStatus.SUCCESS) {
    throw new Error(`report write failed (${TxStatus[reply.txStatus]}): ${reply.errorMessage ?? "no message"}`);
  }
  const hash = reply.txHash ? bytesToHex(reply.txHash) : "unknown";
  runtime.log(`${summary}; tx ${hash}`);
  return `${summary}; tx ${hash}`;
}

function target(identifier: string, proposed: readonly string[], cfg: Config): Target {
  const keywords = proposed.length > 0 ? [...proposed] : keywordsFor(identifier, cfg.keywordOverrides);
  return { identifier, keywords, ticker: tickerOf(identifier), article: articleFor(identifier, keywords, cfg.wikiArticles) };
}

/** Candidates that can be listed now, with the identifier their listing uses. */
function resolveListings(call: ChainCall, lens: Hex, discovered: readonly Candidate[]) {
  const versions = discovered.map((c) =>
    Array.from({ length: MAX_VERSION }, (_, i) => versioned(c.identifier, i + 1)).filter((v): v is string => v !== null),
  );
  const statuses = readStatuses(call, lens, versions.flat().map(trendId));
  let offset = 0;
  const out: Array<{ candidate: Candidate; identifier: string }> = [];
  discovered.forEach((candidate, i) => {
    const vs = versions[i] ?? [];
    const identifier = freeListing(candidate.identifier, statuses.slice(offset, offset + vs.length));
    offset += vs.length;
    if (identifier !== null) out.push({ candidate, identifier });
  });
  return out;
}

export type { LiveTrend };
