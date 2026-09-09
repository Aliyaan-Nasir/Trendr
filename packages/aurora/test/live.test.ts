/**
 * Live checks against Aurora and Monad Mainnet. Everything here is read-only or a dry run: the
 * token lists, dry quotes, dry Intents Connect executions, and eth_calls on Monad (Kuru's book and
 * state, the stable pool's quote, and a simulation of the planned steps with a state override that
 * gives the intermediary its bridged USDC). Nothing is created, signed or funded. Run with
 * AURORA_LIVE=1 and AURORA_API_KEY set.
 */
import { describe, expect, test } from "bun:test";
import { type Address, createPublicClient, decodeEventLog, encodeAbiParameters, erc20Abi, formatUnits, type Hex, http, keccak256, numberToHex, pad } from "viem";
import {
  AUSD_MAINNET,
  AuroraClient,
  CURVE_AUSD_POOL,
  curveQuote,
  depositAusdSteps,
  depositQuoteRequest,
  type EvmStep,
  encodeStep,
  IntentsConnectClient,
  KURU_CLOB_VENUE,
  KuruMarketState,
  MONAD_ASSETS,
  MONAD_MAINNET_CONNECT,
  minusBps,
  monadAsset,
  monadAssetDrift,
  planBridgeIn,
  readKuruBook,
  readKuruMarketState,
} from "../src";

const monad = createPublicClient({ transport: http("https://rpc.monad.xyz") });
const USDC = MONAD_ASSETS.USDC.address!;

/**
 * Runs steps from `from` in one eth_simulateV1 batch, with `usdc` of USDC credited to it (USDC is
 * Circle's FiatToken: balances live in mapping slot 9). Returns AUSD transfers and any revert.
 */
async function simulateSteps(from: Address, steps: EvmStep[], usdc: bigint) {
  const slot = keccak256(encodeAbiParameters([{ type: "address" }, { type: "uint256" }], [from, 9n]));
  const res = await monad.simulateCalls({
    account: from,
    calls: steps.map((s) => {
      const c = encodeStep(s);
      return { to: c.to, data: c.data, value: c.value };
    }),
    stateOverrides: [{ address: USDC, stateDiff: [{ slot, value: pad(numberToHex(usdc)) }] }],
  });
  const failed = res.results.find((r) => r.status !== "success");
  const ausdIn: { to: string; value: bigint }[] = [];
  for (const r of res.results)
    for (const log of r.logs ?? []) {
      if (log.address.toLowerCase() !== AUSD_MAINNET.address.toLowerCase()) continue;
      const ev = decodeEventLog({ abi: erc20Abi, data: log.data as Hex, topics: log.topics as [Hex, ...Hex[]] });
      if (ev.eventName === "Transfer") ausdIn.push({ to: ev.args.to, value: ev.args.value });
    }
  // 0x004b65ba is Kuru's MarketStateError().
  const selector = failed?.data?.slice(0, 10);
  return { ok: !failed, error: selector === "0x004b65ba" ? "MarketStateError()" : (selector ?? failed?.error?.message.split("\n")[0]), ausdIn };
}

const apiKey = process.env.AURORA_API_KEY;
const enabled = process.env.AURORA_LIVE === "1" && !!apiKey;
// Placeholders: dry quotes reserve nothing and nobody deposits.
const REFUND = "0x1111111111111111111111111111111111111111";
const ACCOUNT = "0x2222222222222222222222222222222222222222";

describe.skipIf(!enabled)("Aurora live (dry runs only)", () => {
  const aurora = new AuroraClient({ apiKey: apiKey ?? "unset" });
  const connect = new IntentsConnectClient({ apiKey });

  test("lists Monad USDC, USDT0 and MON", async () => {
    const list = await aurora.tokens();
    expect(monadAssetDrift(list)).toEqual([]);
    console.log(`tokens: ${list.tokens.length} on ${list.chains().length} chains; Monad: ${list.onChain("monad").map((t) => t.symbol).join(", ")}`);
  }, 30_000);

  for (const chain of ["base", "arb"]) {
    test(`dry quote: 10 USDC on ${chain} to USDC on Monad`, async () => {
      const list = await aurora.tokens();
      const origin = list.bySymbol(chain, "USDC")[0]!;
      const destination = monadAsset(list, "USDC");
      const res = await aurora.quote(depositQuoteRequest({ origin, destination, amount: 10_000_000n, account: ACCOUNT, refundTo: REFUND, dry: true }));
      const q = res.quote;
      expect(q.depositAddress).toBeUndefined();
      expect(BigInt(q.amountOut)).toBeGreaterThan(9_000_000n);
      console.log(
        `${chain} USDC -> Monad USDC: in ${q.amountInFormatted}, out ${q.amountOutFormatted} (min ${formatUnits(BigInt(q.minAmountOut), 6)}), ` +
          `about ${q.timeEstimate} s, refund fee ${q.refundFee ?? "?"} raw, withdraw fee ${q.withdrawFee ?? "?"} raw, ` +
          `fees ${JSON.stringify(res.quoteRequest.appFees?.map((f) => f.fee) ?? [])} bps`,
      );
    }, 60_000);
  }

  test("incidents", async () => {
    const res = await aurora.incidents();
    console.log(`incidents: ${res.status}${res.status === "incidents" ? ` (${res.incidents.length})` : ""}`);
  }, 30_000);

  test("Intents Connect: Monad is a destination, and the deposit-AUSD recipe dry-runs and simulates on Mainnet", async () => {
    const tokens = await connect.supportedTokens();
    expect(tokens.out.some((t) => t.assetId === MONAD_ASSETS.USDC.assetId)).toBe(true);
    const list = await aurora.tokens();
    const plan = await planBridgeIn(connect, {
      wallet: ACCOUNT,
      quote: {
        originAsset: list.bySymbol("base", "USDC")[0]!.assetId,
        destinationAsset: MONAD_ASSETS.USDC.assetId,
        amount: "20000000",
        swapType: "EXACT_INPUT",
        slippageTolerance: 50,
      },
      destinationToken: USDC,
      build: async ({ spendable }) => {
        const dy = await curveQuote(monad, { i: CURVE_AUSD_POOL.index.USDC, j: CURVE_AUSD_POOL.index.AUSD, dx: spendable });
        return depositAusdSteps(MONAD_MAINNET_CONNECT, { usdcIn: spendable, minAusdOut: minusBps(dy, 30), account: ACCOUNT });
      },
    });
    const minAusd = BigInt(plan.steps[1]!.parameters[3] as string);
    console.log(
      `Intents Connect 20 USDC Base -> Monad: intermediary ${plan.intermediary}, gross min ${formatUnits(plan.grossMinAmountOut, 6)} USDC, ` +
        `network fee ${formatUnits(plan.networkFee, 6)} USDC, spend ${formatUnits(plan.spendable, 6)} USDC -> at least ${formatUnits(minAusd, 6)} AUSD, about ${plan.estimatedSeconds} s`,
    );
    // The intermediary as it will be after the bridge: holding the guaranteed USDC.
    const sim = await simulateSteps(plan.intermediary, plan.steps, plan.minAmountOut);
    expect(sim.ok).toBe(true);
    const toAccount = sim.ausdIn.filter((t) => t.to.toLowerCase() === ACCOUNT.toLowerCase()).reduce((a, t) => a + t.value, 0n);
    expect(toAccount).toBeGreaterThanOrEqual(minAusd);
    console.log(`simulated on Mainnet: ${formatUnits(toAccount, 6)} AUSD to the Trendr account`);

    // The same recipe through Kuru's book, for comparison: it reverts while the market is paused.
    const state = await readKuruMarketState(monad);
    const kuru = depositAusdSteps({ ...MONAD_MAINNET_CONNECT, venue: KURU_CLOB_VENUE }, { usdcIn: plan.spendable, minAusdOut: minAusd, account: ACCOUNT });
    const kuruSim = await simulateSteps(plan.intermediary, kuru, plan.minAmountOut);
    console.log(`Kuru AUSD/USDC market state ${KuruMarketState[state]}; Kuru recipe simulation ${kuruSim.ok ? "succeeded" : `reverted: ${kuruSim.error}`}`);
  }, 90_000);

  test("AUSD liquidity: Kuru's book and the stable pool", async () => {
    const book = await readKuruBook(monad);
    const asks = book.asks.reduce((s, l) => s + l.size, 0n);
    const bids = book.bids.reduce((s, l) => s + l.size, 0n);
    console.log(`Kuru AUSD/USDC at block ${book.block}: ${formatUnits(asks, 6)} AUSD of asks, ${formatUnits(bids, 6)} AUSD of bids (top 50 levels)`);
    for (const usdc of [1_000_000_000n, 100_000_000_000n]) {
      const dy = await curveQuote(monad, { i: CURVE_AUSD_POOL.index.USDC, j: CURVE_AUSD_POOL.index.AUSD, dx: usdc });
      console.log(`stable pool: ${formatUnits(usdc, 6)} USDC -> ${formatUnits(dy, 6)} AUSD`);
    }
  }, 30_000);
});
