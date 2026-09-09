/**
 * Records the fixtures under test/fixtures from the live APIs. Every call here is read-only or a
 * dry run: token lists, dry quotes, dry Intents Connect executions, statuses of existing deposit
 * addresses and an eth_call on Monad Mainnet. Nothing is created, signed or funded.
 *
 *   AURORA_API_KEY=... bun scripts/record.ts
 *
 * Responses are scrubbed before they are written: the API key never appears, and the referral and
 * fee recipients Aurora echoes back from the key's configuration are replaced with placeholders.
 * Persistent deposit address creation is only recorded with RECORD_PERSISTENT=1, because for an
 * approved key it creates a real (unfunded) address.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createPublicClient, http, parseAbi } from "viem";

const apiKey = process.env.AURORA_API_KEY;
if (!apiKey) throw new Error("set AURORA_API_KEY");

const SWAP = "https://intents-api.aurora.dev";
const CONNECT = "https://intents-connect-api.aurora.dev";
const OUT = join(import.meta.dir, "..", "test", "fixtures");

const ASSET = {
  baseUsdc: "nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near",
  arbUsdc: "nep141:arb-0xaf88d065e77c8cc2239327c5edb3a432268e5831.omft.near",
  solUsdc: "nep141:sol-5ce3bf3a31af18be40ba30f721101b4341690186.omft.near",
  monadUsdc: "nep245:v2_1.omni.hot.tg:143_2dmLwYWkCQKyTjeUPAsGJuiVLbFx",
};
// Placeholder wallets: nobody deposits to anything quoted here, and dry quotes reserve nothing.
const EVM_REFUND = "0x1111111111111111111111111111111111111111";
const SOL_REFUND = "7XSfQkK1y1pX6dGqH4cJRtBZ2Ffq6dUQUh8m3WwDXqR3";
const RECIPIENT = "0x2222222222222222222222222222222222222222";
// Deposit addresses from earlier Intents Connect test quotes on that same placeholder wallet;
// their status is public and they were never funded.
const PUBLIC_DEPOSIT_ADDRESS = "0x8b9F5A1329c0d5376038F1d29DeB7C662B5f7426";

const KURU_ROUTER = "0xd651346d7c789536ebf06dc72aE3C8502cd695CC";
const KURU_AUSD_USDC = "0x699abc15308156e9a3ab89ec7387e9cfe1c86a3b";
const CURVE_POOL = "0x942644106B073E30D72c2C5D7529D5C296ea91ab";
const USDC = "0x754704Bc059F8C67012fEd69BC8A327a5aafb603";
const AUSD = "0x00000000eFE302BEAA2b3e6e1b18d08D69a9012a";

const recorded = new Date().toISOString();

function scrub(value: unknown): unknown {
  if (typeof value === "string") return value.split(apiKey!).join("{apiKey}");
  if (Array.isArray(value)) return value.map(scrub);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      if (k === "referral" && typeof v === "string") out[k] = "trendr-fixture";
      else if (k === "appFees" && Array.isArray(v)) out[k] = v.map((f: { fee: number }) => ({ recipient: "fee-recipient.fixture", fee: f.fee }));
      else out[k] = scrub(v);
    }
    return out;
  }
  return value;
}

function save(name: string, fixture: Record<string, unknown>) {
  const file = join(OUT, `${name}.json`);
  mkdirSync(dirname(file), { recursive: true });
  const text = `${JSON.stringify(scrub({ recorded, ...fixture }), null, 2)}\n`;
  if (text.includes(apiKey!)) throw new Error(`${name} still contains the API key`);
  writeFileSync(file, text);
  console.log(`recorded ${name} (HTTP ${fixture.status})`);
}

async function call(url: string, init?: RequestInit) {
  const res = await fetch(url, init);
  const text = await res.text();
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }
  return { status: res.status, retryAfter: res.headers.get("retry-after"), body };
}

const post = (url: string, body: unknown, headers: Record<string, string> = {}) =>
  call(url, { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(body) });

const deadline = (minutes: number) => new Date(Date.now() + minutes * 60_000).toISOString().replace(/\.\d{3}Z$/, ".000Z");

function quoteBody(over: Record<string, unknown>) {
  return {
    dry: true,
    swapType: "EXACT_INPUT",
    depositType: "ORIGIN_CHAIN",
    originAsset: ASSET.baseUsdc,
    destinationAsset: ASSET.monadUsdc,
    amount: "10000000",
    slippageTolerance: 50,
    refundTo: EVM_REFUND,
    refundType: "ORIGIN_CHAIN",
    recipient: RECIPIENT,
    recipientType: "DESTINATION_CHAIN",
    deadline: deadline(30),
    ...over,
  };
}

// --- Swap API -----------------------------------------------------------------------------------

{
  const r = await call(`${SWAP}/api/tokens/${apiKey}`);
  const all = (r.body as { tokens: { blockchain: string; symbol: string; contractAddress?: string }[]; asset_stats: unknown[] }).tokens;
  const keep = all.filter(
    (t) =>
      t.blockchain === "monad" ||
      (t.symbol === "USDC" && ["base", "arb", "eth", "sol"].includes(t.blockchain)) ||
      (t.symbol === "ETH" && t.blockchain === "eth") ||
      (t.symbol === "BTC" && t.blockchain === "btc"),
  );
  save("swap/tokens", { status: r.status, note: `trimmed from ${all.length} live tokens`, body: { ...(r.body as object), tokens: keep } });
}

for (const [name, over] of [
  ["swap/quote-dry-exact-input", {}],
  ["swap/quote-dry-exact-output", { swapType: "EXACT_OUTPUT", originAsset: ASSET.arbUsdc, amount: "25000000" }],
  ["swap/quote-dry-flex-input", { swapType: "FLEX_INPUT" }],
  ["swap/quote-dry-solana", { originAsset: ASSET.solUsdc, refundTo: SOL_REFUND }],
  ["swap/quote-error-amount-too-low", { amount: "1000" }],
  ["swap/quote-error-invalid-refund", { refundTo: "not-an-address" }],
  ["swap/quote-error-any-input-origin-chain", { swapType: "ANY_INPUT", amount: "0" }],
] as const) {
  const request = quoteBody(over);
  const r = await post(`${SWAP}/api/quote/${apiKey}`, request);
  save(name, { status: r.status, request, body: r.body });
}

{
  const r = await post(`${SWAP}/api/quote/00000000-0000-0000-0000-000000000000`, quoteBody({}));
  save("swap/quote-error-unknown-key", { status: r.status, body: r.body });
}

{
  const r = await call(`${SWAP}/api/status/${apiKey}?depositAddress=${PUBLIC_DEPOSIT_ADDRESS}`);
  save("swap/status-pending-deposit", { status: r.status, body: r.body });
  const missing = await call(`${SWAP}/api/status/${apiKey}?depositAddress=${EVM_REFUND}`);
  save("swap/status-not-found", { status: missing.status, body: missing.body });
}

{
  const r = await call(`${SWAP}/api/incidents/${apiKey}`);
  const body = r.body as { status: string; incidents?: Record<string, unknown>[] };
  // Keep two incidents and drop their internal descriptions; the shape is what matters.
  const incidents = body.incidents?.slice(0, 2).map((i) => ({ ...i, description: "trimmed", publicDescription: i.publicDescription ?? null }));
  save("swap/incidents", { status: r.status, body: incidents ? { ...body, incidents } : body });
}

{
  const r = await call(`${SWAP}/api/transactions/${apiKey}?numberOfTransactions=5`);
  save("swap/transactions", { status: r.status, body: r.body });
}

// --- Persistent deposit addresses ---------------------------------------------------------------

{
  const r = await call(`${SWAP}/api/persistent-deposit-status/${apiKey}?type=received&address=${EVM_REFUND}`);
  save("persistent/status-not-found", { status: r.status, body: r.body });
  const list = await call(`${SWAP}/api/persistent-deposit-addresses/${apiKey}?perPage=5`);
  save("persistent/list", { status: list.status, body: list.body });
  if (process.env.RECORD_PERSISTENT === "1") {
    const request = { recipient: RECIPIENT, sender: "trendr-aurora-fixture", depositChain: "evm", destinationChain: "monad", destinationAsset: ASSET.monadUsdc };
    const created = await post(`${SWAP}/api/persistent-deposit-address/${apiKey}`, request);
    save("persistent/create", { status: created.status, request, body: created.body });
  }
}

// --- Intents Connect ----------------------------------------------------------------------------

{
  const r = await call(`${CONNECT}/api/v1/supported_tokens`);
  const result = (r.body as { result: { in: { blockchain: string; symbol: string }[]; out: { blockchain: string; symbol: string }[] } }).result;
  const pick = (list: { blockchain: string; symbol: string }[]) =>
    list.filter((t) => t.blockchain === "monad" || (t.symbol === "USDC" && ["base", "arb", "sol"].includes(t.blockchain)));
  save("connect/supported-tokens", {
    status: r.status,
    note: `trimmed from ${result.in.length} in and ${result.out.length} out tokens`,
    body: { result: { in: pick(result.in), out: pick(result.out) } },
  });
  const intermediary = await call(`${CONNECT}/api/v1/executions/${RECIPIENT}/intermediary`);
  save("connect/intermediary", { status: intermediary.status, body: intermediary.body });
}

const connectQuote = {
  originAsset: ASSET.baseUsdc,
  destinationAsset: ASSET.monadUsdc,
  amount: "20000000",
  swapType: "EXACT_INPUT",
  slippageTolerance: 50,
  deadline: deadline(30).replace(".000Z", "Z"),
};
const metadata = { title: "Trendr deposit", intent: "trendr_deposit" };

{
  const round1 = { version: "1.0", type: "evm", quote: connectQuote, steps: [], metadata, dry: true };
  const r1 = await post(`${CONNECT}/api/v1/executions/${RECIPIENT}`, round1, { "x-api-key": apiKey });
  save("connect/dry-round1", { status: r1.status, request: round1, body: r1.body });

  const gross = BigInt((r1.body as { result: { quote: { minAmountOut: string } } }).result.quote.minAmountOut);
  const minAusd = (gross * 9_900n) / 10_000n;
  const venues = {
    // Kuru's AUSD/USDC book through the Router; the AUSD is paid to the intermediary, then moved.
    kuru: [
      { to: USDC, value: "0", functionSignature: "approve(address,uint256)", parameters: [KURU_ROUTER, gross.toString()] },
      {
        to: KURU_ROUTER,
        value: "0",
        functionSignature: "anyToAnySwap(address[],bool[],bool[],address,address,uint256,uint256)",
        parameters: [[KURU_AUSD_USDC], [true], [false], USDC, AUSD, gross.toString(), minAusd.toString()],
      },
      { to: AUSD, value: "0", functionSignature: "transfer(address,uint256)", parameters: [RECIPIENT, minAusd.toString()] },
    ],
    // The AUSD/USDC/USDT0 stable pool, paying the receiver directly.
    curve: [
      { to: USDC, value: "0", functionSignature: "approve(address,uint256)", parameters: [CURVE_POOL, gross.toString()] },
      {
        to: CURVE_POOL,
        value: "0",
        functionSignature: "exchange(int128,int128,uint256,uint256,address)",
        parameters: ["1", "0", gross.toString(), minAusd.toString(), RECIPIENT],
      },
    ],
  };
  for (const [venue, steps] of Object.entries(venues)) {
    const round2 = { ...round1, steps };
    const r2 = await post(`${CONNECT}/api/v1/executions/${RECIPIENT}`, round2, { "x-api-key": apiKey });
    save(`connect/dry-round2-${venue}`, { status: r2.status, request: round2, body: r2.body });
  }

  const noKey = await post(`${CONNECT}/api/v1/executions/${RECIPIENT}`, round1);
  save("connect/error-missing-key", { status: noKey.status, body: noKey.body });
}

{
  const request = {
    version: "1.0",
    type: "evm",
    destinationAsset: ASSET.monadUsdc,
    steps: [
      { to: USDC, value: "0", functionSignature: "transfer(address,uint256)", parameters: [RECIPIENT, "1000000"] },
      { to: AUSD, value: "0", functionSignature: "transfer(address,uint256)", parameters: [RECIPIENT, "500000"] },
    ],
    metadata: { title: "Sweep to Trendr account", intent: "trendr_sweep" },
    dry: true,
  };
  const r = await post(`${CONNECT}/api/v1/executions/${RECIPIENT}/steps`, request);
  save("connect/steps-dry-sweep", { status: r.status, request, body: r.body });
}

{
  // Executions other integrators created on the placeholder wallet; keep one of each mode.
  const r = await call(`${CONNECT}/api/v1/executions/${RECIPIENT}`);
  const all = (r.body as { result: { executionMode?: string }[] }).result;
  const keep = ["quote_with_steps", "steps_only"].map((m) => all.find((e) => e.executionMode === m)).filter(Boolean);
  save("connect/executions", { status: r.status, note: `trimmed from ${all.length} executions`, body: { result: keep } });
}

// --- Kuru on Monad Mainnet (read-only eth_call) -------------------------------------------------

{
  const client = createPublicClient({ transport: http("https://rpc.monad.xyz") });
  const book = parseAbi([
    "function getL2Book(uint32 bidPricePoints, uint32 askPricePoints) view returns (bytes)",
    "function marketState() view returns (uint8)",
  ]);
  const router = parseAbi([
    "function verifiedMarket(address market) view returns (uint32 pricePrecision, uint96 sizePrecision, address baseAssetAddress, uint256 baseAssetDecimals, address quoteAssetAddress, uint256 quoteAssetDecimals, uint32 tickSize, uint96 minSize, uint96 maxSize, uint256 takerFeeBps, uint256 makerFeeBps)",
  ]);
  const blockNumber = await client.getBlockNumber();
  const l2 = await client.readContract({ address: KURU_AUSD_USDC, abi: book, functionName: "getL2Book", args: [30, 30], blockNumber });
  const params = await client.readContract({ address: KURU_ROUTER, abi: router, functionName: "verifiedMarket", args: [KURU_AUSD_USDC], blockNumber });
  const marketState = await client.readContract({ address: KURU_AUSD_USDC, abi: book, functionName: "marketState", blockNumber });
  save("kuru/ausd-usdc-book", {
    status: 200,
    blockNumber: blockNumber.toString(),
    market: KURU_AUSD_USDC,
    body: { l2, marketState, verifiedMarket: params.map((v) => (typeof v === "bigint" ? v.toString() : v)) },
  });

  const pool = parseAbi([
    "function coins(uint256 i) view returns (address)",
    "function get_balances() view returns (uint256[])",
    "function get_dy(int128 i, int128 j, uint256 dx) view returns (uint256)",
  ]);
  const coins = await Promise.all([0n, 1n, 2n].map((i) => client.readContract({ address: CURVE_POOL, abi: pool, functionName: "coins", args: [i], blockNumber })));
  const balances = await client.readContract({ address: CURVE_POOL, abi: pool, functionName: "get_balances", blockNumber });
  const dx = [1_000_000n, 1_000_000_000n, 100_000_000_000n];
  const dy = await Promise.all(dx.map((d) => client.readContract({ address: CURVE_POOL, abi: pool, functionName: "get_dy", args: [1n, 0n, d], blockNumber })));
  save("curve/ausd-pool", {
    status: 200,
    blockNumber: blockNumber.toString(),
    pool: CURVE_POOL,
    body: { coins, balances: balances.map(String), usdcToAusd: dx.map((d, i) => ({ dx: d.toString(), dy: dy[i]!.toString() })) },
  });
}
