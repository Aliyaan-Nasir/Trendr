/**
 * The market maker on a fork of Monad Testnet, against the live Trendr deployment and the real
 * Kuru order books: it mints inventory and quotes every listed series, re-quotes after a taker
 * fills it, takes a complete-set arbitrage another trader leaves, pulls everything on the kill
 * switch, and after settlement withdraws and redeems. Oracle reports reach the registry the way
 * the CRE simulator sends them, from the trusted broadcaster through the MockKeystoneForwarder.
 *
 * Run with MM_FORK=1 (needs anvil on PATH and network access to the Testnet RPC).
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Alerts, monadChain, ViemChainClient } from "@trendr/chain";
import {
  deployments,
  iKuruMarginAccountAbi,
  iKuruOrderBookAbi,
  iKuruRouterAbi,
  outcomeMarketsAbi,
  trendRegistryAbi,
  trendrErrorAbis,
  trendrLensAbi,
} from "@trendr/contracts";
import {
  type Address,
  concat,
  createPublicClient,
  createWalletClient,
  encodeAbiParameters,
  erc20Abi,
  type Hex,
  http,
  keccak256,
  numberToHex,
  parseAbi,
  toBytes,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { decodeL2 } from "../src/book";
import { MarketMaker } from "../src/engine";
import { StateStore } from "../src/store";

const enabled = process.env.MM_FORK === "1";
const d = deployments[10143]!;
const BROADCASTER = d.treasury; // the Testnet deployer, which the registry trusts as broadcaster
const MM_KEY = "0x47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a" as const;
const TAKER_KEY = "0x8b3a350cf5c34c9194ca85829a2df0ec3153be0318b5e2d3348e872092edffba" as const;
const port = 9600 + Math.floor(Math.random() * 300);
const rpc = `http://127.0.0.1:${port}`;
const chain = monadChain(10143, rpc);
const pub = createPublicClient({ chain, transport: http(rpc) });
const taker = createWalletClient({ chain, transport: http(rpc), account: privateKeyToAccount(TAKER_KEY) });
const maker = privateKeyToAccount(MM_KEY).address;
const UNIT = 1_000_000n;
const MARGIN = "0xd029C2D98ff85D8F64799017fE00a59B1159CE02" as Address;
const forwarderAbi = parseAbi(["function report(address receiver, bytes rawReport, bytes reportContext, bytes[] signatures)"]);
const REPORT = [
  {
    type: "tuple",
    components: [
      { name: "runId", type: "uint64" },
      { name: "observedAt", type: "uint64" },
      {
        name: "newTrends",
        type: "tuple[]",
        components: [
          { name: "identifier", type: "string" },
          { name: "assetClass", type: "uint8" },
          { name: "index", type: "uint64" },
          { name: "surfacer", type: "address" },
          { name: "smartMoneyConfirmed", type: "bool" },
        ],
      },
      { name: "updates", type: "tuple[]", components: [{ name: "id", type: "bytes32" }, { name: "index", type: "uint64" }] },
      { name: "settlements", type: "tuple[]", components: [{ name: "id", type: "bytes32" }, { name: "expiry", type: "uint64" }] },
    ],
  },
] as const;

let anvil: ReturnType<typeof Bun.spawn> | undefined;
let mm: MarketMaker;
let killed = false;
let trendIds: Hex[] = [];
const quiet = { info() {}, debug() {}, warn: (f: object, m: string) => console.warn(m, f), error: (f: object, m: string) => console.error(m, f) };

async function rpcCall(method: string, params: unknown[]) {
  return pub.request({ method, params } as never);
}

async function asBroadcaster<T>(fn: (w: ReturnType<typeof createWalletClient>) => Promise<T>): Promise<T> {
  await rpcCall("anvil_impersonateAccount", [BROADCASTER]);
  try {
    return await fn(createWalletClient({ chain, transport: http(rpc), account: BROADCASTER }));
  } finally {
    await rpcCall("anvil_stopImpersonatingAccount", [BROADCASTER]);
  }
}

async function wait(hash: Hex) {
  const r = await pub.waitForTransactionReceipt({ hash });
  if (r.status !== "success") throw new Error(`reverted: ${hash}`);
}

/** Re-reports every live trend at its current index (or `bump` points higher), now. */
async function report(bump = 0n, settlements: { id: Hex; expiry: bigint }[] = []) {
  const now = (await pub.getBlock()).timestamp;
  const last = await pub.readContract({ address: d.trendRegistry, abi: trendRegistryAbi, functionName: "lastRunId" });
  const updates = [];
  for (const id of trendIds) {
    const t = await pub.readContract({ address: d.trendRegistry, abi: trendRegistryAbi, functionName: "trendOf", args: [id] });
    updates.push({ id, index: BigInt(t.index) + bump });
  }
  const runId = BigInt(last) >= now ? BigInt(last) + 1n : now;
  const body = encodeAbiParameters(REPORT, [{ runId, observedAt: now, newTrends: [], updates, settlements }]);
  // version, execution id, timestamp, DON id, config version, then the receiver's metadata.
  const header = concat([
    "0x01",
    keccak256(toBytes(`fork-run-${runId}`)),
    numberToHex(Number(now), { size: 4 }),
    numberToHex(1, { size: 4 }),
    numberToHex(1, { size: 4 }),
    numberToHex(0, { size: 32 }),
    numberToHex(0, { size: 10 }),
    numberToHex(0, { size: 20 }),
    numberToHex(0, { size: 2 }),
  ]);
  await asBroadcaster(async (w) =>
    wait(await w.writeContract({ address: d.creForwarder, abi: forwarderAbi, functionName: "report", args: [d.trendRegistry, concat([header, body]), "0x", []], chain, account: BROADCASTER })),
  );
  expect(await pub.readContract({ address: d.trendRegistry, abi: trendRegistryAbi, functionName: "lastRunId" })).toBe(runId);
}

async function quotedSeries() {
  const views = await pub.readContract({ address: d.trendrLens, abi: trendrLensAbi, functionName: "series", args: [trendIds] });
  return views.filter((v) => v.listed && v.outcome === 0 && (v.window === 86_400 || v.window === 604_800));
}

const book = async (market: Address) => decodeL2(await pub.readContract({ address: market, abi: iKuruOrderBookAbi, functionName: "getL2Book", args: [5, 5] }));
const ausd = (who: Address) => pub.readContract({ address: d.ausd, abi: erc20Abi, functionName: "balanceOf", args: [who] });

describe.skipIf(!enabled)("market maker on a Monad Testnet fork", () => {
  beforeAll(async () => {
    anvil = Bun.spawn(["anvil", "--fork-url", "https://testnet-rpc.monad.xyz", "--port", String(port), "--silent"], { stdout: "ignore", stderr: "ignore" });
    for (let i = 0; i < 200; i++) {
      try {
        await pub.getChainId();
        break;
      } catch {
        await Bun.sleep(100);
      }
    }
    const count = await pub.readContract({ address: d.trendRegistry, abi: trendRegistryAbi, functionName: "trendCount" });
    const all = await pub.readContract({ address: d.trendRegistry, abi: trendRegistryAbi, functionName: "trends", args: [0n, count] });
    trendIds = all.filter((t) => t.trend.status === 1).map((t) => t.id);
    await report();

    // AUSD for the maker and the taker, from the Testnet deployer; gas for both.
    for (const who of [maker, taker.account.address]) {
      await rpcCall("anvil_setBalance", [who, numberToHex(10n ** 21n)]);
      await asBroadcaster(async (w) =>
        wait(await w.writeContract({ address: d.ausd, abi: erc20Abi, functionName: "transfer", args: [who, 1000n * UNIT], chain, account: BROADCASTER })),
      );
    }

    const sender = new ViemChainClient(rpc, 10143, [MM_KEY], undefined, trendrErrorAbis);
    const dir = mkdtempSync(join(tmpdir(), "mm-fork-"));
    mm = new MarketMaker(pub, sender, d, new StateStore(join(dir, "state.json")), new Alerts("test", quiet), quiet, {
      quote: { halfSpread: 0.03, levelStep: 0.01, levels: 2, levelTokens: 10, maxSkew: 0.03, inventoryLimit: 40 },
      windows: [86_400, 604_800],
      setsPerSeries: 50,
      marginAusd: 100,
      requoteTicks: 5,
      stopBeforeExpirySec: 300,
      arbMinEdge: 0.005,
      arbMaxTokens: 100,
      quoteEveryBlocks: 1,
      pollMs: 1000,
      killed: () => killed,
    });
  }, 180_000);

  afterAll(() => {
    mm?.stop();
    anvil?.kill();
  });

  test("mints inventory and quotes both sides of every listed series", async () => {
    await mm.tick();
    expect(mm.status.lastError).toBeNull();
    const series = await quotedSeries();
    expect(series.length).toBeGreaterThan(0);
    expect(mm.status.stats.mints).toBe(series.length);
    for (const s of series) {
      const fair = mm.status.series[s.seriesId]!.fair;
      for (const [market, center] of [
        [s.upMarket, fair],
        [s.downMarket, 1 - fair],
      ] as const) {
        // The forked books also hold the live market maker's orders, so look at ours only.
        const own = await mm.restingOrders(market);
        const bids = own.filter((o) => o.isBuy).map((o) => o.price / 10_000);
        const asks = own.filter((o) => !o.isBuy).map((o) => o.price / 10_000);
        expect(bids.length).toBe(2);
        expect(asks.length).toBe(2);
        expect(Math.max(...bids)).toBeLessThan(center);
        expect(Math.min(...asks)).toBeGreaterThan(center);
      }
    }
    // Nothing moved, so a second tick sends nothing.
    const before = mm.status.stats.requotes;
    await mm.tick();
    expect(mm.status.stats.requotes).toBe(before);
  }, 240_000);

  test("re-quotes after a taker lifts its ask", async () => {
    const [s] = await quotedSeries();
    const ours = (await mm.restingOrders(s!.upMarket)).filter((o) => !o.isBuy).sort((a, b) => a.price - b.price)[0]!;
    // Buy through every ask up to and including our best one (price units times size units is the
    // raw AUSD cost of a level), with 1% more so Kuru's rounding cannot leave a sliver of it.
    const cost = (await book(s!.upMarket)).asks.filter((l) => l.price <= ours.price).reduce((a, l) => a + BigInt(l.price) * l.size, 0n);
    const spend = (cost * 101n) / 100n;
    await wait(await taker.writeContract({ address: d.ausd, abi: erc20Abi, functionName: "approve", args: [d.kuruRouter, spend] }));
    await wait(
      await taker.writeContract({
        address: d.kuruRouter,
        abi: iKuruRouterAbi,
        functionName: "anyToAnySwap",
        args: [[s!.upMarket], [true], [false], d.ausd, s!.up, spend, 1n],
      }),
    );
    expect((await mm.restingOrders(s!.upMarket)).some((o) => o.id === ours.id)).toBe(false);
    const before = mm.status.stats.requotes;
    await mm.tick();
    expect(mm.status.stats.requotes).toBeGreaterThan(before);
    const asks = (await mm.restingOrders(s!.upMarket)).filter((o) => !o.isBuy);
    expect(asks.length).toBe(2);
  }, 240_000);

  test("buys a complete set below 1 AUSD from another trader and redeems it", async () => {
    const [s] = await quotedSeries();
    const offered: number[] = [];
    // The taker mints 20 sets and offers each side one cent above the maker's bid, post-only, so
    // the asks rest without crossing; together they sell a complete set for about 0.96.
    await wait(await taker.writeContract({ address: d.ausd, abi: erc20Abi, functionName: "approve", args: [d.outcomeMarkets, 20n * UNIT] }));
    await wait(await taker.writeContract({ address: d.outcomeMarkets, abi: outcomeMarketsAbi, functionName: "mint", args: [s!.seriesId, 20n * UNIT, taker.account.address] }));
    for (const [token, market] of [
      [s!.up, s!.upMarket],
      [s!.down, s!.downMarket],
    ] as const) {
      await wait(await taker.writeContract({ address: token, abi: erc20Abi, functionName: "approve", args: [MARGIN, 20n * UNIT] }));
      await wait(await taker.writeContract({ address: MARGIN, abi: iKuruMarginAccountAbi, functionName: "deposit", args: [taker.account.address, token, 20n * UNIT] }));
      const price = (await book(market)).bids[0]!.price + 100;
      await wait(await taker.writeContract({ address: market, abi: iKuruOrderBookAbi, functionName: "addSellOrder", args: [price, 2000n, true] }));
      offered.push(price);
    }
    const before = await ausd(maker);
    await mm.tick();
    expect(mm.status.stats.arbitrages).toBe(1);
    // Twenty pairs bought for about 0.96 and redeemed for 1.
    const paid = offered.reduce((a, p) => a + p, 0) / 10_000;
    expect(Number((await ausd(maker)) - before) / 1e6).toBeGreaterThan(20 * (0.999 - paid) * 0.9);
    expect((await book(s!.upMarket)).asks.every((l) => l.price !== offered[0])).toBe(true);
  }, 240_000);

  test("pulls every quote on the kill switch", async () => {
    killed = true;
    await mm.tick();
    for (const s of await quotedSeries()) {
      for (const market of [s.upMarket, s.downMarket]) expect(await mm.restingOrders(market)).toEqual([]);
    }
    killed = false;
  }, 240_000);

  test("after settlement withdraws everything and redeems", async () => {
    await mm.tick();
    const series = await quotedSeries();
    const maxExpiry = series.reduce((a, s) => (BigInt(s.expiry) > a ? BigInt(s.expiry) : a), 0n);
    const now = (await pub.getBlock()).timestamp;
    await rpcCall("evm_increaseTime", [Number(maxExpiry - now) + 30]);
    await rpcCall("evm_mine", []);
    await report(1_000_000n);
    for (const s of series) {
      await wait(await taker.writeContract({ address: d.outcomeMarkets, abi: outcomeMarketsAbi, functionName: "settle", args: [s.seriesId] }));
    }
    const before = await ausd(maker);
    await mm.tick();
    expect(mm.status.stats.redemptions).toBe(series.length);
    for (const s of series) {
      for (const token of [s.up, s.down]) {
        expect(await pub.readContract({ address: token, abi: erc20Abi, functionName: "balanceOf", args: [maker] })).toBe(0n);
        expect(await pub.readContract({ address: MARGIN, abi: iKuruMarginAccountAbi, functionName: "getBalance", args: [maker, token] })).toBe(0n);
      }
    }
    expect(await ausd(maker)).toBeGreaterThan(before);
  }, 300_000);
});
