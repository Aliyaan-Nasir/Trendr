import { createEffect, S } from "envio";
import { createPublicClient, fallback, http, type PublicClient } from "viem";

/**
 * RPCs per chain for a few cached view calls: ENVIO_RPC_URL_<chainId> (the variable config.yaml
 * uses for its realtime source) first, then the public endpoints. A failed effect stops the
 * indexer, and free endpoints refuse calls now and then (dRPC answers "method not available" under
 * load), so every read falls back across all of them.
 */
const PUBLIC_RPCS: Record<number, readonly string[]> = {
  143: ["https://rpc.monad.xyz"],
  10143: ["https://testnet-rpc.monad.xyz", "https://rpc-testnet.monadinfra.com", "https://rpc.ankr.com/monad_testnet"],
};

const clients = new Map<number, PublicClient>();

export function rpcUrls(chainId: number, env: Record<string, string | undefined> = process.env): string[] {
  const configured = env[`ENVIO_RPC_URL_${chainId}`];
  // Tests serve reads from a local node and must never reach the network.
  const publics = env.ENVIO_PUBLIC_RPC_FALLBACK === "off" ? [] : (PUBLIC_RPCS[chainId] ?? []);
  return [...new Set([...(configured ? [configured] : []), ...publics])];
}

/** A client whose every read tries each URL in turn, retrying a failing one before moving on. */
export function viewClient(urls: readonly string[]): PublicClient {
  return createPublicClient({
    transport: fallback(
      urls.map((url) => http(url, { batch: true, retryCount: 2, retryDelay: 100 })),
      { retryCount: 3 },
    ),
  }) as PublicClient;
}

function client(chainId: number): PublicClient {
  let c = clients.get(chainId);
  if (!c) {
    const urls = rpcUrls(chainId);
    if (urls.length === 0) throw new Error(`No RPC URL for chain ${chainId}; set ENVIO_RPC_URL_${chainId}`);
    c = viewClient(urls);
    clients.set(chainId, c);
  }
  return c;
}

/** Exchange.getPerpetualInfo, from Perpl's Exchange ABI (packages/perpl/src/exchange-abi.ts). */
const exchangeAbi = [
  {
    type: "function",
    name: "getPerpetualInfo",
    stateMutability: "view",
    inputs: [{ name: "perpId", type: "uint256" }],
    outputs: [
      {
        name: "perpetualInfo",
        type: "tuple",
        components: [
          { name: "name", type: "string" },
          { name: "symbol", type: "string" },
          { name: "priceDecimals", type: "uint256" },
          { name: "lotDecimals", type: "uint256" },
          { name: "linkFeedId", type: "bytes32" },
          { name: "priceTolPer100K", type: "uint256" },
          { name: "marginTol", type: "uint256" },
          { name: "marginTolDecimals", type: "uint256" },
          { name: "refPriceMaxAgeSec", type: "uint256" },
          { name: "positionBalanceCNS", type: "uint256" },
          { name: "insuranceBalanceCNS", type: "uint256" },
          { name: "markPNS", type: "uint256" },
          { name: "markTimestamp", type: "uint256" },
          { name: "lastPNS", type: "uint256" },
          { name: "lastTimestamp", type: "uint256" },
          { name: "oraclePNS", type: "uint256" },
          { name: "oracleTimestampSec", type: "uint256" },
          { name: "longOpenInterestLNS", type: "uint256" },
          { name: "shortOpenInterestLNS", type: "uint256" },
          { name: "fundingStartBlock", type: "uint256" },
          { name: "fundingRatePct100k", type: "int16" },
          { name: "absFundingClampPctPer100K", type: "uint256" },
          { name: "status", type: "uint8" },
          { name: "basePricePNS", type: "uint256" },
          { name: "maxBidPriceONS", type: "uint256" },
          { name: "minBidPriceONS", type: "uint256" },
          { name: "maxAskPriceONS", type: "uint256" },
          { name: "minAskPriceONS", type: "uint256" },
          { name: "numOrders", type: "uint256" },
          { name: "ignOracle", type: "bool" },
        ],
      },
    ],
  },
] as const;

/**
 * Name and decimals of a Perpl perpetual, read once per market from the Exchange and cached in the
 * database. Decimals are fixed per market, so the latest state is the right one to read.
 */
export const perplMarketInfo = createEffect(
  {
    name: "perplMarketInfo",
    input: { exchange: S.string, perpId: S.string },
    output: { name: S.string, symbol: S.string, priceDecimals: S.number, lotDecimals: S.number },
    rateLimit: { calls: 5, per: "second" },
    cache: true,
    crossChain: false,
  },
  async ({ input, context }) => {
    const info = await client(context.chain.id).readContract({
      address: input.exchange as `0x${string}`,
      abi: exchangeAbi,
      functionName: "getPerpetualInfo",
      args: [BigInt(input.perpId)],
    });
    return {
      name: info.name,
      symbol: info.symbol,
      priceDecimals: Number(info.priceDecimals),
      lotDecimals: Number(info.lotDecimals),
    };
  },
);

/** EIP-7702 delegated code: this designator followed by the 20-byte address of the code it runs. */
const DELEGATION_DESIGNATOR = "0xef0100";

/** The address an account's code delegates to under EIP-7702, or null for any other code (none, or a contract's own). */
export function delegateFromCode(code: string | undefined): string | null {
  const c = code?.toLowerCase();
  return c && c.length === DELEGATION_DESIGNATOR.length + 40 && c.startsWith(DELEGATION_DESIGNATOR)
    ? `0x${c.slice(DELEGATION_DESIGNATOR.length)}`
    : null;
}

/**
 * The code an address delegates to at a block, read once and cached. Reading at the event's block
 * means a later re-delegation can neither fake nor hide what the address ran then. A node that no
 * longer serves that block's state is asked for the latest code instead.
 */
export const delegateOf = createEffect(
  {
    name: "delegateOf",
    input: { address: S.string, blockNumber: S.number },
    output: { delegate: S.nullable(S.string) },
    rateLimit: { calls: 5, per: "second" },
    cache: true,
    crossChain: false,
  },
  async ({ input, context }) => {
    const c = client(context.chain.id);
    const address = input.address as `0x${string}`;
    const code = await c
      .getCode({ address, blockNumber: BigInt(input.blockNumber) })
      .catch(() => c.getCode({ address }));
    return { delegate: delegateFromCode(code) };
  },
);
