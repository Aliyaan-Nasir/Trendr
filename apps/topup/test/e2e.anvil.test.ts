/**
 * The top-up service end to end on a local Anvil: a funded treasury refills plain wallets with
 * exactly 21000 gas and an EIP-7702 delegated wallet with an estimated limit, respects the
 * cooldown and the floor (Monad's 10 MON reserve emulated), alerts once when the treasury runs
 * short (also across a restart) and once when it recovers. Run with TOPUP_E2E=1 (needs anvil).
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { monadChain, ViemChainClient } from "@trendr/chain";
import { type Address, createPublicClient, createWalletClient, type Hex, http, parseEther, toHex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import type { Target } from "../src/config";
import { HOUR_MS } from "../src/plan";
import { FileStore } from "../src/store";
import { TopUp, type TopUpOptions } from "../src/topup";

const enabled = process.env.TOPUP_E2E === "1";
const DEPLOYER = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
const port = 9600 + Math.floor(Math.random() * 1000);
const rpc = `http://127.0.0.1:${port}`;
const chain = monadChain(31_337, rpc);
const pub = createPublicClient({ chain, transport: http(rpc) });
const deployer = createWalletClient({ chain, transport: http(rpc), account: privateKeyToAccount(DEPLOYER) });
const e = (mon: string) => parseEther(mon);
const MIN = 60_000;
// Creation code for a contract whose code stores the value it receives in slot 0
// (CALLVALUE PUSH1 0 SSTORE STOP), so a delegated wallet spends more than 21000 gas on receipt.
const RECEIVER_INITCODE = "0x6434600055006000526005601bf3";
const quiet = { info() {}, warn: (f: object, m: string) => console.warn(m, f), error() {} };

const treasuryKey = generatePrivateKey();
const treasury = privateKeyToAccount(treasuryKey).address.toLowerCase() as Address;
const relayerKey = generatePrivateKey();
const fresh = () => privateKeyToAccount(generatePrivateKey()).address.toLowerCase() as Address;
const wallet = (name: string, address: Address, min: string, goal: string): Target => ({
  name,
  address,
  min: e(min),
  target: e(goal),
  maxPerTransfer: e(goal),
  maxPerDay: e("100"),
});
const ORACLE = wallet("oracle", fresh(), "5", "20");
const KEEPER = wallet("keeper", fresh(), "3", "12");
const RELAYER = wallet("relayer", privateKeyToAccount(relayerKey).address.toLowerCase() as Address, "1.5", "5");

let anvil: ReturnType<typeof Bun.spawn> | undefined;
let dir: string;
let now = 1_800_000_000_000;
const posts: string[] = [];

const balance = (address: Address) => pub.getBalance({ address });
const setBalance = (address: Address, mon: string) => pub.request({ method: "anvil_setBalance", params: [address, toHex(e(mon))] } as never);

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

function service(): TopUp {
  const opts: TopUpOptions = {
    treasury,
    targets: [ORACLE, KEEPER, RELAYER],
    // 2 MON of the service's own reserve on top of Monad's 10.
    floor: e("12"),
    intervalMs: 2 * MIN,
    cooldownMs: 10 * MIN,
    maxRefillsPerHour: 3,
    minTransfer: e("0.1"),
    runwayAlertDays: 0.001,
    delegatedGasCap: 100_000n,
    dryRun: false,
    failureBackoff: { firstMs: 2 * MIN, maxMs: HOUR_MS },
    alertRepeat: { firstMs: 15 * MIN, maxMs: 12 * HOUR_MS },
    checkFailuresBeforeAlert: 3,
  };
  const sender = new ViemChainClient(rpc, 31_337, [treasuryKey]);
  return new TopUp(pub, sender, new FileStore(join(dir, "state.json")), quiet, opts, {
    source: "top-up",
    webhookUrl: "https://hooks.example/x",
    post: async (_u, body) => posts.push(JSON.parse(body).text),
  }, () => now);
}

async function check(topup: TopUp, advanceMs = 2 * MIN) {
  now += advanceMs;
  await topup.check();
  await Bun.sleep(0);
  expect(topup.status.lastCheck?.error).toBeNull();
}

const gasOf = async (hash: string) => (await pub.getTransaction({ hash: hash as Hex })).gas;

describe.skipIf(!enabled)("top-up end to end on Anvil", () => {
  let topup: TopUp;

  // 73 MON: 12 for the floor, 37 to fill the three wallets, 19 to refill the oracle once, and about
  // 5 left, which cannot cover the keeper's next refill.
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "topup-e2e-"));
    anvil = Bun.spawn(["anvil", "--hardfork", "osaka", "--port", String(port), "--silent"], { stdout: "ignore", stderr: "ignore" });
    await waitForRpc();
    const deployed = await pub.waitForTransactionReceipt({ hash: await deployer.sendTransaction({ data: RECEIVER_INITCODE }) });
    const receiver = deployed.contractAddress!;
    // The relayer wallet delegates to the receiver (EIP-7702); the deployer pays.
    const relayer = createWalletClient({ chain, transport: http(rpc), account: privateKeyToAccount(relayerKey) });
    const authorization = await relayer.signAuthorization({ contractAddress: receiver });
    await pub.waitForTransactionReceipt({
      hash: await deployer.sendTransaction({ to: RELAYER.address, data: "0x", authorizationList: [authorization] }),
    });
    expect(await pub.getCode({ address: RELAYER.address })).toBe(`0xef0100${receiver.slice(2).toLowerCase()}` as Hex);
    await pub.waitForTransactionReceipt({ hash: await deployer.sendTransaction({ to: treasury, value: e("73") }) });
    topup = service();
  });

  afterAll(async () => {
    anvil?.kill();
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  test("fills every wallet to its target with the right gas limits", async () => {
    await check(topup);
    expect(await balance(ORACLE.address)).toBe(e("20"));
    expect(await balance(KEEPER.address)).toBe(e("12"));
    expect(await balance(RELAYER.address)).toBe(e("5"));
    // The delegated code ran in the relayer wallet: it stored the 5 MON it received.
    expect(BigInt((await pub.getStorageAt({ address: RELAYER.address, slot: "0x0" }))!)).toBe(e("5"));
    const sent = topup.status.targets.map((t) => t.lastTransfer!);
    expect(sent.map((r) => r.status)).toEqual(["confirmed", "confirmed", "confirmed"]);
    expect(await gasOf(sent[0]!.hash!)).toBe(21_000n);
    expect(await gasOf(sent[1]!.hash!)).toBe(21_000n);
    const delegatedGas = await gasOf(sent[2]!.hash!);
    expect(delegatedGas).toBeGreaterThan(21_000n);
    expect(delegatedGas).toBeLessThanOrEqual(100_000n);
    expect(topup.status.targets.map((t) => t.delegated)).toEqual([false, false, true]);
    expect(topup.healthy()).toBe(true);

    // Everything is at target: the next check sends nothing.
    const nonce = await pub.getTransactionCount({ address: treasury });
    await check(topup);
    expect(await pub.getTransactionCount({ address: treasury })).toBe(nonce);
    expect(posts).toEqual([]);
  });

  test("waits out the cooldown before refilling a drained wallet", async () => {
    await setBalance(ORACLE.address, "1");
    await check(topup);
    expect(await balance(ORACLE.address)).toBe(e("1"));
    expect(topup.status.targets[0]!.state).toBe("cooldown");
    await check(topup, 10 * MIN);
    expect(await balance(ORACLE.address)).toBe(e("20"));
  });

  test("never sends below the floor, alerts once when short (also across a restart), and recovers once", async () => {
    await setBalance(KEEPER.address, "0");
    await check(topup, 10 * MIN);
    // The keeper got what was left above the floor, and the treasury kept its floor.
    const keeper = await balance(KEEPER.address);
    expect(keeper).toBeGreaterThan(e("3"));
    expect(keeper).toBeLessThan(e("12"));
    expect(topup.status.targets[1]!.lastTransfer!.partial).toBe(true);
    expect(await balance(treasury)).toBeGreaterThanOrEqual(e("12"));
    expect(posts).toHaveLength(1);
    expect(posts[0]).toContain(`top-up alert: treasury ${treasury} holds`);
    expect(topup.healthy()).toBe(true);

    // Still short for the next 12 minutes, through a restart: no repeat.
    for (let i = 0; i < 3; i++) await check(topup);
    topup = service();
    for (let i = 0; i < 3; i++) await check(topup);
    expect(posts).toHaveLength(1);

    // The treasury drops below its floor: unhealthy, and the same alert, not a new one.
    await setBalance(treasury, "11");
    await check(topup);
    expect(topup.healthy()).toBe(false);
    expect(posts).toHaveLength(1);

    // The partly refilled keeper is above its min, so only a drop below it brings the rest.
    await setBalance(treasury, "50");
    await setBalance(KEEPER.address, "2");
    await check(topup);
    expect(await balance(KEEPER.address)).toBe(e("12"));
    expect(posts).toHaveLength(2);
    expect(posts[1]).toContain("top-up resolved");
    expect(posts[1]).toContain("treasury-low");
    expect(topup.healthy()).toBe(true);
    for (let i = 0; i < 3; i++) await check(topup);
    expect(posts).toHaveLength(2);
  });
});
