/**
 * The keeper end to end on a local Anvil with the real contracts from script/Deploy.s.sol (local
 * Kuru stand-ins): series opening, listing and rolling, settlement, liquidation, funding marks,
 * retirement with settlement of stranded positions, and curve graduation. Run with KEEPER_E2E=1
 * (needs anvil and forge on PATH).
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { Alerts, monadChain, ViemChainClient } from "@trendr/chain";
import {
  attentionPerpAbi,
  bondingCurveAbi,
  type Deployment,
  outcomeMarketsAbi,
  trendRegistryAbi,
  trendrErrorAbis,
  trendrLensAbi,
} from "@trendr/contracts";
import { createPublicClient, createWalletClient, encodeAbiParameters, erc20Abi, type Hex, http, keccak256, parseAbi, toBytes } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { Executor } from "../src/executor";
import { Keeper } from "../src/keeper";

const enabled = process.env.KEEPER_E2E === "1";
const ANVIL_KEYS = [
  "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
  "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
  "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a",
] as const;
const contractsDir = join(import.meta.dir, "..", "..", "..", "contracts");
const port = 8600 + Math.floor(Math.random() * 1000);
const rpc = `http://127.0.0.1:${port}`;
const chain = monadChain(31_337, rpc);
const pub = createPublicClient({ chain, transport: http(rpc) });
const deployer = createWalletClient({ chain, transport: http(rpc), account: privateKeyToAccount(ANVIL_KEYS[0]) });
const trader = createWalletClient({ chain, transport: http(rpc), account: privateKeyToAccount(ANVIL_KEYS[2]) });
const keeperAddress = privateKeyToAccount(ANVIL_KEYS[1]).address;
const mintAbi = parseAbi(["function mint(address to, uint256 amount)"]);
const UNIT = 1_000_000n;
const DAY = 86_400;
const CURVE_OPEN = 1;
const CURVE_GRADUATED = 3;

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
let d: Deployment;
let keeper: Keeper;
let executor: Executor;
let runId = 0n;
const K1 = keccak256(toBytes("topic:k1"));
const K2 = keccak256(toBytes("topic:k2"));
const quiet = { info() {}, debug() {}, warn: (f: object, m: string) => console.warn(m, f), error: (f: object, m: string) => console.error(m, f) };
const ZERO = `0x${"0".repeat(64)}` as Hex;

async function waitForRpc() {
  for (let i = 0; i < 100; i++) {
    try {
      await pub.getChainId();
      return;
    } catch {
      await Bun.sleep(100);
    }
  }
  throw new Error("anvil did not start");
}

async function send(hash: Promise<Hex>) {
  const receipt = await pub.waitForTransactionReceipt({ hash: await hash });
  if (receipt.status !== "success") throw new Error("transaction reverted");
}

async function warp(seconds: number) {
  await pub.request({ method: "evm_increaseTime", params: [seconds] } as never);
  await pub.request({ method: "evm_mine", params: [] } as never);
}

/** An oracle report from the local forwarder, observed at the latest block's time. */
async function report(parts: { newTrends?: string[]; updates?: [Hex, bigint][] }) {
  const now = (await pub.getBlock()).timestamp;
  const data = encodeAbiParameters(REPORT, [
    {
      runId: ++runId,
      observedAt: now,
      newTrends: (parts.newTrends ?? []).map((identifier) => ({
        identifier,
        assetClass: 6,
        index: 40_000_000n,
        surfacer: deployer.account.address,
        smartMoneyConfirmed: false,
      })),
      updates: (parts.updates ?? []).map(([id, index]) => ({ id, index })),
      settlements: [],
    },
  ]);
  await send(deployer.writeContract({ address: d.trendRegistry, abi: trendRegistryAbi, functionName: "onReport", args: ["0x", data] }));
}

/** Scans until a scan sends nothing, as the live keeper does head after head. */
async function settleDown(maxScans = 6) {
  for (let i = 0; i < maxScans; i++) {
    const before = Object.values(executor.stats.sent).reduce((a, b) => a + b, 0);
    await keeper.scan();
    const after = Object.values(executor.stats.sent).reduce((a, b) => a + b, 0);
    if (after === before) return;
  }
}

const seriesOf = async (ids: Hex[]) =>
  pub.readContract({ address: d.trendrLens, abi: trendrLensAbi, functionName: "series", args: [ids] });

describe.skipIf(!enabled)("keeper end to end on Anvil", () => {
  beforeAll(async () => {
    anvil = Bun.spawn(["anvil", "--hardfork", "osaka", "--port", String(port), "--silent"], { stdout: "ignore", stderr: "ignore" });
    await waitForRpc();
    const deploy = Bun.spawnSync(
      ["forge", "script", "script/Deploy.s.sol", "--rpc-url", rpc, "--private-key", ANVIL_KEYS[0], "--broadcast", "--non-interactive"],
      { cwd: contractsDir, env: { ...process.env, CRE_MODE: "mock" } },
    );
    if (deploy.exitCode !== 0) throw new Error(`deploy failed: ${deploy.stderr.toString()}`);
    d = (await Bun.file(join(contractsDir, "deployments", "31337.json")).json()) as Deployment;

    const sender = new ViemChainClient(rpc, 31_337, [ANVIL_KEYS[1]], undefined, trendrErrorAbis);
    executor = new Executor(sender, quiet);
    keeper = new Keeper(pub, sender, d, executor, new Alerts("Trendr keeper", quiet), quiet, {
      seriesWindows: [DAY, 7 * DAY],
      listWindows: [DAY, 7 * DAY],
      scanEveryBlocks: 1,
      maxActionsPerScan: 12,
      pollMs: 1000,
      headLagAlertSec: 30,
      minBalanceWei: 0n,
    });

    await send(trader.writeContract({ address: d.ausd, abi: mintAbi, functionName: "mint", args: [trader.account.address, 100_000n * UNIT] }));
    for (const spender of [d.attentionPerp, d.bondingCurve]) {
      await send(trader.writeContract({ address: d.ausd, abi: erc20Abi, functionName: "approve", args: [spender, 2n ** 255n] }));
    }
    await report({ newTrends: ["topic:k1"] });
  }, 120_000);

  afterAll(() => {
    keeper?.stop();
    anvil?.kill();
  }, 120_000);

  test("opens and lists a series in every configured window", async () => {
    await settleDown();
    const views = await seriesOf([K1]);
    // The local deployment also offers the 15 minute drill window, which this keeper skips.
    expect(views.map((v) => v.window)).toEqual([DAY, 7 * DAY, 900]);
    for (const v of views.slice(0, 2)) {
      expect(v.seriesId).not.toBe(ZERO as Hex);
      expect(v.outcome).toBe(0);
      expect(v.listed).toBe(true);
    }
    expect(views[2]!.seriesId).toBe(ZERO);
    expect(executor.stats.sent.openSeries).toBe(2);
    expect(executor.stats.sent.list).toBe(2);
  }, 120_000);

  test("liquidates an underwater position and marks funding for the rest", async () => {
    const open = (isLong: boolean, margin: bigint, lev: bigint) =>
      send(
        trader.writeContract({
          address: d.attentionPerp,
          abi: attentionPerpAbi,
          functionName: "open",
          args: [K1, isLong, margin, lev, isLong ? 2n ** 64n - 1n : 0n, 2n ** 40n],
        }),
      );
    await open(true, 1000n * UNIT, 3n * 10n ** 18n);
    await open(false, 500n * UNIT, 10n ** 18n);
    const doomed = 1n;

    // 40 to 28.5 points leaves the 3x long with positive equity below maintenance, so the
    // liquidation pays the keeper a reward.
    await report({ updates: [[K1, 28_500_000n]] });
    const before = await pub.readContract({ address: d.ausd, abi: erc20Abi, functionName: "balanceOf", args: [keeperAddress] });
    await settleDown();
    const p = await pub.readContract({ address: d.attentionPerp, abi: attentionPerpAbi, functionName: "positionOf", args: [doomed] });
    expect(p.owner).toBe("0x0000000000000000000000000000000000000000");
    expect(executor.stats.sent.liquidate).toBe(1);
    const after = await pub.readContract({ address: d.ausd, abi: erc20Abi, functionName: "balanceOf", args: [keeperAddress] });
    expect(after).toBeGreaterThan(before);

    // The short survives; its market is marked at the new index.
    const [, , , , , lastMark] = await pub.readContract({ address: d.attentionPerp, abi: attentionPerpAbi, functionName: "markets", args: [K1] });
    expect(lastMark).toBe(28_500_000n);
  }, 120_000);

  test("settles an expired series and rolls the window", async () => {
    const [day] = await seriesOf([K1]);
    await warp(DAY);
    await report({ updates: [[K1, 29_000_000n]] });
    await settleDown();
    const s = await pub.readContract({ address: d.outcomeMarkets, abi: outcomeMarketsAbi, functionName: "seriesOf", args: [day!.seriesId] });
    expect(s.outcome).toBe(2); // 29 points closes below the 40 point opening: DOWN
    const [next] = await seriesOf([K1]);
    expect(next!.seriesId).not.toBe(day!.seriesId);
    expect(next!.outcome).toBe(0);
    expect(next!.listed).toBe(true);
  }, 120_000);

  test("retires a trend the oracle abandoned and settles its stranded positions", async () => {
    await warp(2 * 3600 + 1);
    await settleDown();
    const status = await pub.readContract({ address: d.trendRegistry, abi: trendRegistryAbi, functionName: "statusOf", args: [K1] });
    expect(status).toBe(3);
    expect(executor.stats.sent.retire).toBe(1);
    expect(executor.stats.sent.settleRetired).toBe(1);
    const short = await pub.readContract({ address: d.attentionPerp, abi: attentionPerpAbi, functionName: "positionOf", args: [2n] });
    expect(short.owner).toBe("0x0000000000000000000000000000000000000000");
  }, 120_000);

  test("graduates a filled curve", async () => {
    await report({ newTrends: ["topic:k2"] });
    await send(trader.writeContract({ address: d.bondingCurve, abi: bondingCurveAbi, functionName: "createCurve", args: ["topic:k2"] }));
    for (let i = 0; i < 40; i++) {
      const c = await pub.readContract({ address: d.bondingCurve, abi: bondingCurveAbi, functionName: "curveOf", args: [K2] });
      if (c.state !== CURVE_OPEN) break;
      await send(
        trader.writeContract({
          address: d.bondingCurve,
          abi: bondingCurveAbi,
          functionName: "buy",
          args: [K2, (c.virtualQuote + c.reserve) / 12n, 0n, trader.account.address, 2n ** 40n],
        }),
      );
    }
    await settleDown();
    const c = await pub.readContract({ address: d.bondingCurve, abi: bondingCurveAbi, functionName: "curveOf", args: [K2] });
    expect(c.state).toBe(CURVE_GRADUATED);
    expect(executor.stats.sent.graduate).toBe(1);
  }, 120_000);

  test("reports health and nothing left to do", async () => {
    await settleDown();
    expect(keeper.status.lastError).toBeNull();
    expect(keeper.status.lastScan?.planned).toBe(0);
  });
});
