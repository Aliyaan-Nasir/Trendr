import { balancedHttp } from "@trendr/chain";
import { type Deployment, trendRegistryAbi, trendrLensAbi } from "@trendr/contracts";
import { type Chain, createPublicClient, type Hex, type PublicClient } from "viem";
import { monad, monadTestnet } from "viem/chains";

/**
 * Read-only chain access: the registry's trends, read through load-balanced RPC endpoints and
 * cached briefly, since the radar, collector and API all ask for them.
 */

export const STATUS = ["None", "Active", "Cooling", "Retired"] as const;

export interface ChainTrend {
  id: Hex;
  identifier: string;
  assetClass: number;
  status: (typeof STATUS)[number];
  createdAt: number;
  updatedAt: number;
  /** When the trend entered its current status (for a retired trend, when it retired). */
  statusSince: number;
  /** Index points (registry units / 1e6). */
  index: number;
  peakIndex: number;
  surfacer: string;
}

const PAGE = 100;
const INDEX_SCALE = 1_000_000;

export class ChainReader {
  readonly client: PublicClient;
  private cache: { at: number; trends: ChainTrend[]; lastRunId: bigint } | null = null;
  private staleRetire: Promise<number> | null = null;
  private inflight: Promise<{ trends: ChainTrend[]; lastRunId: bigint }> | null = null;

  constructor(
    rpcUrls: readonly string[],
    readonly deployment: Deployment,
    private readonly ttlMs = 15_000,
  ) {
    const chain: Chain | undefined = deployment.chainId === 143 ? monad : deployment.chainId === 10143 ? monadTestnet : undefined;
    // The chain definition carries Multicall3, which history and portfolio reads batch through.
    this.client = createPublicClient({ chain, transport: balancedHttp(rpcUrls, { requestsPerSecond: 10 }), batch: { multicall: true } }) as PublicClient;
  }

  /** Every trend the registry knows, retired ones included, in creation order. */
  async trends(): Promise<ChainTrend[]> {
    return (await this.snapshot()).trends;
  }

  /** The newest CRE run the registry accepted (the run's scheduled time). */
  async lastRunId(): Promise<bigint> {
    return (await this.snapshot()).lastRunId;
  }

  /**
   * Seconds without an update after which anyone may retire a trend (an immutable registry
   * parameter, so it is read once). A trend retired that late was retired because the oracle
   * stopped updating it, not because its topic faded.
   */
  async staleRetireWindow(): Promise<number> {
    this.staleRetire ??= this.client
      .readContract({ address: this.deployment.trendRegistry, abi: trendRegistryAbi, functionName: "staleRetireWindow" })
      .then(Number)
      .catch((e: unknown) => {
        this.staleRetire = null;
        throw e;
      });
    return this.staleRetire;
  }

  async statuses(ids: readonly Hex[]): Promise<number[]> {
    if (ids.length === 0) return [];
    return [...(await this.client.readContract({ address: this.deployment.trendrLens, abi: trendrLensAbi, functionName: "statuses", args: [[...ids]] }))];
  }

  private async snapshot(): Promise<{ trends: ChainTrend[]; lastRunId: bigint }> {
    if (this.cache && Date.now() - this.cache.at < this.ttlMs) return this.cache;
    this.inflight ??= this.load().finally(() => {
      this.inflight = null;
    });
    return this.inflight;
  }

  private async load(): Promise<{ trends: ChainTrend[]; lastRunId: bigint }> {
    const registry = this.deployment.trendRegistry;
    const [count, lastRunId] = await Promise.all([
      this.client.readContract({ address: registry, abi: trendRegistryAbi, functionName: "trendCount" }),
      this.client.readContract({ address: registry, abi: trendRegistryAbi, functionName: "lastRunId" }),
    ]);
    const trends: ChainTrend[] = [];
    for (let start = 0n; start < count; start += BigInt(PAGE)) {
      const page = await this.client.readContract({ address: registry, abi: trendRegistryAbi, functionName: "trends", args: [start, BigInt(PAGE)] });
      for (const v of page) {
        trends.push({
          id: v.id,
          identifier: v.identifier,
          assetClass: v.trend.assetClass,
          status: STATUS[v.trend.status] ?? "None",
          createdAt: Number(v.trend.createdAt),
          updatedAt: Number(v.trend.updatedAt),
          statusSince: Number(v.trend.statusSince),
          index: Number(v.trend.index) / INDEX_SCALE,
          peakIndex: Number(v.trend.peakIndex) / INDEX_SCALE,
          surfacer: v.trend.surfacer.toLowerCase(),
        });
      }
    }
    const snap = { trends, lastRunId: BigInt(lastRunId) };
    this.cache = { ...snap, at: Date.now() };
    return snap;
  }
}
