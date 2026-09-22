import { describe, expect, test } from "bun:test";
import { type Chain, type SendParams, type Sent, SimulationRevert } from "@trendr/chain";
import { type Address, type Hex, parseEther } from "viem";
import type { Target } from "../src/config";
import { HOUR_MS } from "../src/plan";
import { emptyState, type State, type Store } from "../src/store";
import { type Reader, TopUp, type TopUpOptions } from "../src/topup";

const e = (mon: string) => parseEther(mon);
const MIN = 60_000;
const TREASURY = "0x00000000000000000000000000000000000000ff" as Address;
const target = (name: string, n: number, min: string, goal: string, perDay = "100"): Target => ({
  name,
  address: `0x${n.toString(16).padStart(40, "0")}` as Address,
  min: e(min),
  target: e(goal),
  maxPerTransfer: e(goal),
  maxPerDay: e(perDay),
});
const ORACLE = target("oracle", 1, "5", "20");
const KEEPER = target("keeper", 2, "3", "12");
const quiet = { info() {}, warn() {}, error() {} };

class FakeChain implements Reader, Chain {
  readonly chainId = 10143;
  balances = new Map<string, bigint>();
  codes = new Map<string, Hex>();
  sends: SendParams[] = [];
  /** Scripted outcomes for the next sends: an error to throw or a status. */
  script: (Error | "reverted")[] = [];
  readsFail = false;

  balance(a: Address) {
    return this.balances.get(a.toLowerCase()) ?? 0n;
  }
  async getBalance({ address }: { address: Address }) {
    if (this.readsFail) throw new Error("fetch failed");
    return this.balance(address);
  }
  async getCode({ address }: { address: Address }) {
    return this.codes.get(address.toLowerCase());
  }
  async estimateFeesPerGas() {
    return { maxFeePerGas: 100_000_000_000n };
  }
  async code(address: Address) {
    return this.codes.get(address.toLowerCase());
  }
  async nonce() {
    return 0;
  }
  async read(): Promise<unknown> {
    throw new Error("unused");
  }
  async estimate() {
    return 21_000n;
  }
  senders() {
    return [TREASURY];
  }
  async send(p: SendParams): Promise<Sent> {
    this.sends.push(p);
    const next = this.script.shift();
    if (next instanceof Error) throw next;
    const gasLimit = this.codes.has(p.to.toLowerCase()) ? 50_000n : 21_000n;
    const fee = gasLimit * 100_000_000_000n;
    this.balances.set(TREASURY, this.balance(TREASURY) - fee - (next === "reverted" ? 0n : p.value!));
    if (next !== "reverted") this.balances.set(p.to.toLowerCase(), this.balance(p.to) + p.value!);
    return { hash: `0x${this.sends.length.toString(16).padStart(64, "0")}`, status: next ?? "success", blockNumber: 1n, gasUsed: gasLimit, gasLimit, logs: [] };
  }
}

class MemoryStore implements Store {
  readonly kind = "file" as const;
  saved: State = emptyState();
  leading = true;
  saves = 0;
  async load() {
    return structuredClone(this.saved);
  }
  async save(s: State) {
    this.saves++;
    this.saved = structuredClone(s);
  }
  async lead() {
    return this.leading;
  }
  async close() {}
}

function setup(over: Partial<TopUpOptions> = {}, store = new MemoryStore()) {
  const chain = new FakeChain();
  const posts: string[] = [];
  let now = 1_800_000_000_000;
  const opts: TopUpOptions = {
    treasury: TREASURY,
    targets: [ORACLE, KEEPER],
    floor: e("12"),
    intervalMs: 2 * MIN,
    cooldownMs: 10 * MIN,
    maxRefillsPerHour: 3,
    minTransfer: e("0.1"),
    runwayAlertDays: 3,
    delegatedGasCap: 100_000n,
    dryRun: false,
    failureBackoff: { firstMs: 2 * MIN, maxMs: HOUR_MS },
    alertRepeat: { firstMs: 15 * MIN, maxMs: 12 * HOUR_MS },
    checkFailuresBeforeAlert: 3,
    ...over,
  };
  const topup = new TopUp(chain, opts.dryRun ? null : chain, store, quiet, opts, { source: "top-up", webhookUrl: "https://hooks.example/x", post: async (_u, b) => posts.push(JSON.parse(b).text) }, () => now);
  const check = async (advanceMs = 2 * MIN) => {
    now += advanceMs;
    await topup.check();
    await Bun.sleep(0);
  };
  return { chain, store, posts, topup, check, set: (a: Address, mon: string) => chain.balances.set(a.toLowerCase(), e(mon)) };
}

describe("TopUp", () => {
  test("refills below min, records the transfer ahead of sending, then cools down", async () => {
    const s = setup();
    s.set(TREASURY, "100");
    s.set(ORACLE.address, "4");
    s.set(KEEPER.address, "5");
    s.chain.codes.set(ORACLE.address, "0xef0100aabbccddeeff00112233445566778899aabbccdd");
    let pendingSeen = false;
    const save = s.store.save.bind(s.store);
    s.store.save = async (st) => {
      if (st.transfers.some((r) => r.status === "pending")) pendingSeen = true;
      return save(st);
    };
    await s.check();
    expect(pendingSeen).toBe(true);
    expect(s.chain.sends.map((p) => [p.to, p.value, p.gasCap, p.gas])).toEqual([[ORACLE.address, e("16"), 100_000n, undefined]]);
    expect(s.chain.balance(ORACLE.address)).toBe(e("20"));
    expect(s.store.saved.transfers).toMatchObject([{ target: "oracle", status: "confirmed", amount: e("16").toString(), gasLimit: "50000" }]);

    // The keeper drops below min: a plain EOA gets exactly 21000 gas.
    s.set(KEEPER.address, "1");
    // The oracle is drained right after its refill: it waits out the cooldown.
    s.set(ORACLE.address, "0");
    await s.check();
    // A wallet without code is sent exactly 21000 gas: Monad estimates a plain transfer above that.
    expect(s.chain.sends.slice(1).map((p) => [p.to, p.value, p.gasCap, p.gas])).toEqual([[KEEPER.address, e("11"), 21_000n, 21_000n]]);
    expect(s.topup.status.targets.map((t) => t.state)).toEqual(["cooldown", "send"]);
    await s.check(10 * MIN);
    expect(s.chain.sends.at(-1)!.to).toBe(ORACLE.address);
    expect(s.topup.healthy()).toBe(true);
    expect(s.posts).toEqual([]);
  });

  test("a short treasury alerts once, reminds with backoff, and recovers once", async () => {
    const s = setup();
    s.set(TREASURY, "5");
    s.set(ORACLE.address, "1");
    s.set(KEEPER.address, "1");
    // Checks every 2 minutes: the alert fires on the first, and nothing more for 15 minutes.
    for (let i = 0; i < 8; i++) await s.check();
    expect(s.chain.sends).toEqual([]);
    expect(s.posts).toHaveLength(1);
    expect(s.posts[0]).toContain("top-up alert: treasury 0x00000000000000000000000000000000000000ff holds 5 MON against a floor of 12 MON; cannot cover oracle, keeper");
    expect(s.topup.healthy()).toBe(false);
    await s.check();
    // 16 minutes after the alert: the first reminder; the next is 30 minutes later.
    expect(s.posts).toHaveLength(2);
    expect(s.posts[1]).toContain("still firing");
    for (let i = 0; i < 10; i++) await s.check();
    expect(s.posts).toHaveLength(2);

    s.set(TREASURY, "100");
    await s.check();
    expect(s.chain.sends.map((p) => p.to)).toEqual([ORACLE.address, KEEPER.address]);
    expect(s.posts).toHaveLength(3);
    expect(s.posts[2]).toContain("resolved");
    for (let i = 0; i < 5; i++) await s.check();
    expect(s.posts).toHaveLength(3);
    expect(s.topup.healthy()).toBe(true);
  });

  test("a partly covered wallet keeps the alert up through its cooldown instead of flapping", async () => {
    const s = setup();
    s.set(TREASURY, "15");
    s.set(ORACLE.address, "1");
    s.set(KEEPER.address, "5");
    for (let i = 0; i < 6; i++) await s.check();
    expect(s.chain.sends).toHaveLength(1);
    expect(s.store.saved.transfers[0]!.partial).toBe(true);
    expect(s.posts).toHaveLength(1);
  });

  test("a refused send backs off and alerts once; success resolves it", async () => {
    const s = setup();
    s.set(TREASURY, "100");
    s.set(ORACLE.address, "1");
    s.set(KEEPER.address, "5");
    s.chain.script = [new SimulationRevert("boom"), new SimulationRevert("boom")];
    await s.check();
    expect(s.store.saved.transfers[0]!.status).toBe("failed");
    expect(s.posts).toEqual(["top-up alert: transfers to oracle failed 1 time(s) in a row: boom"]);
    // Backoff of 2 minutes, then 4: no tight retries.
    await s.check(MIN);
    expect(s.chain.sends).toHaveLength(1);
    await s.check(MIN);
    expect(s.chain.sends).toHaveLength(2);
    await s.check(2 * MIN);
    expect(s.chain.sends).toHaveLength(2);
    await s.check(2 * MIN);
    expect(s.chain.sends).toHaveLength(3);
    expect(s.chain.balance(ORACLE.address)).toBe(e("20"));
    expect(s.posts).toHaveLength(2);
    expect(s.posts[1]).toContain("resolved after 6m: send-failed:oracle");
  });

  test("a send that may have gone out counts toward the cap and the cooldown", async () => {
    const s = setup({ targets: [target("oracle", 1, "5", "20", "20")] });
    s.set(TREASURY, "100");
    s.set(ORACLE.address, "1");
    s.chain.script = [new Error("request timed out")];
    await s.check();
    expect(s.store.saved.transfers[0]!.status).toBe("unknown");
    await s.check(5 * MIN);
    expect(s.chain.sends).toHaveLength(1);
    // After the cooldown the cap (20 a day, 19 maybe spent) leaves 1 MON.
    await s.check(10 * MIN);
    expect(s.chain.sends.at(-1)!.value).toBe(e("1"));
  });

  test("a pending transfer left by a crash still counts after a restart", async () => {
    const store = new MemoryStore();
    store.saved.transfers.push({ id: "x", target: "oracle", amount: e("20").toString(), at: 1_800_000_000_000, status: "pending", partial: false });
    const s = setup({ targets: [target("oracle", 1, "5", "20", "20")] }, store);
    s.set(TREASURY, "100");
    s.set(ORACLE.address, "1");
    await s.check(20 * MIN);
    expect(s.chain.sends).toEqual([]);
    expect(s.topup.status.targets[0]!.state).toBe("capped");
    expect(s.posts).toEqual(["top-up alert: oracle reached its cap of 20 MON a day and holds 1 MON (min 5); refills resume as the 24 hour window moves"]);
  });

  test("halts a wallet drained again and again, alerts once, and resumes on release", async () => {
    const s = setup();
    s.set(TREASURY, "1000");
    s.set(KEEPER.address, "5");
    for (let i = 0; i < 6; i++) {
      s.set(ORACLE.address, "0");
      await s.check(11 * MIN);
    }
    expect(s.chain.sends).toHaveLength(3);
    expect(s.topup.status.targets[0]!.state).toBe("halted");
    expect(s.posts).toHaveLength(1);
    expect(s.posts[0]).toContain("oracle (0x0000000000000000000000000000000000000001) is halted: 3 refills in the last hour");
    expect(await s.topup.release("nobody")).toBe("unknown-target");
    expect(await s.topup.release("oracle")).toBe("released");
    expect(await s.topup.release("oracle")).toBe("not-halted");
    await s.check();
    expect(s.chain.sends).toHaveLength(4);
    expect(s.posts.at(-1)).toContain("resolved");
  });

  test("a dry run sends nothing and reports what it would send", async () => {
    const s = setup({ dryRun: true });
    s.set(TREASURY, "100");
    s.set(ORACLE.address, "1");
    s.set(KEEPER.address, "1");
    await s.check();
    await s.check();
    expect(s.chain.sends).toEqual([]);
    expect(s.topup.status.wouldSend).toEqual([
      { name: "oracle", amount: e("19"), gasCap: 21_000n, partial: false },
      { name: "keeper", amount: e("11"), gasCap: 21_000n, partial: false },
    ]);
    expect(s.store.saved.transfers).toEqual([]);
    expect(s.topup.status.role).toBe("dry-run");
  });

  test("a standby reads and sends nothing", async () => {
    const store = new MemoryStore();
    store.leading = false;
    const s = setup({}, store);
    s.set(TREASURY, "100");
    s.set(ORACLE.address, "1");
    await s.check();
    expect(s.chain.sends).toEqual([]);
    expect(store.saves).toBe(0);
    expect(s.topup.status.role).toBe("standby");
    expect(await s.topup.release("oracle")).toBe("standby");
  });

  test("failed checks alert after three in a row, once, and resolve once", async () => {
    const s = setup();
    s.set(TREASURY, "100");
    s.set(ORACLE.address, "10");
    s.set(KEEPER.address, "10");
    s.chain.readsFail = true;
    for (let i = 0; i < 2; i++) await s.check();
    expect(s.posts).toEqual([]);
    for (let i = 0; i < 4; i++) await s.check();
    expect(s.posts).toEqual(["top-up alert: 3 checks in a row failed: fetch failed"]);
    s.chain.readsFail = false;
    await s.check();
    await s.check();
    expect(s.posts).toHaveLength(2);
    expect(s.posts[1]).toContain("resolved after 8m: check-failed");
  });

  test("warns when the runway at the observed burn runs short", async () => {
    const s = setup({ targets: [ORACLE] });
    s.set(TREASURY, "52");
    s.set(ORACLE.address, "19");
    // The oracle burns 0.1 MON every 2 minutes (72 MON a day); 40 spendable lasts about half a day.
    for (let i = 0; i < 31; i++) {
      await s.check();
      s.chain.balances.set(ORACLE.address, s.chain.balance(ORACLE.address) - e("0.1"));
    }
    expect(s.topup.status.treasury.runwayDays).toBeLessThan(1);
    expect(s.posts).toHaveLength(1);
    expect(s.posts[0]).toContain("lasts about");
  });
});
