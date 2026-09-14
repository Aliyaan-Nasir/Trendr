import { describe, expect, test } from "bun:test";
import { type Chain, type SendParams, type Sent, SimulationRevert } from "@trendr/chain";
import { Executor } from "../src/executor";
import type { Action } from "../src/plan";

const quiet = { info() {}, warn() {}, debug() {} };
const action = (key: string): Action => ({ key, kind: "settle", to: "0x0000000000000000000000000000000000000001", data: "0x12345678", gasCap: 100_000n, reason: "test" });

function fakeChain(behaviour: (p: SendParams) => Promise<Sent>) {
  const sent: SendParams[] = [];
  const chain = {
    chainId: 1,
    senders: () => ["0x00000000000000000000000000000000000000aa"],
    send: async (p: SendParams) => {
      sent.push(p);
      return behaviour(p);
    },
  } as unknown as Chain;
  return { chain, sent };
}

const ok = async (): Promise<Sent> => ({ hash: "0xabc", status: "success", blockNumber: 1n, gasUsed: 1n, gasLimit: 50_000n, logs: [] });

describe("Executor", () => {
  test("sends in order and respects the per-scan cap", async () => {
    const { chain, sent } = fakeChain(ok);
    const ex = new Executor(chain, quiet);
    const results = await ex.run([action("a"), action("b"), action("c")], 2);
    expect(results.map((r) => r.outcome)).toEqual(["sent", "sent"]);
    expect(sent.length).toBe(2);
    expect(ex.stats.sent.settle).toBe(2);
    expect(ex.stats.gasLimitSpent).toBe(100_000n);
  });

  test("backs off a failing action exponentially and forgets it once unplanned", async () => {
    let now = 0;
    const { chain, sent } = fakeChain(async () => {
      throw new SimulationRevert("SomethingBroke()");
    });
    const ex = new Executor(chain, quiet, () => now);
    expect((await ex.run([action("a")], 5))[0]!.outcome).toBe("failed");
    expect(await ex.run([action("a")], 5)).toEqual([]);
    now += 15_000;
    await ex.run([action("a")], 5);
    expect(sent.length).toBe(2);
    now += 15_000; // the second backoff is 30 s
    expect(await ex.run([action("a")], 5)).toEqual([]);
    now += 15_000;
    await ex.run([action("a")], 5);
    expect(ex.failing(3)).toEqual([{ key: "a", failures: 3, reason: "SomethingBroke()" }]);

    await ex.run([], 5);
    expect(ex.failing(1)).toEqual([]);
    expect((await ex.run([action("a")], 5)).length).toBe(1);
  });

  test("treats lost races as skipped, not failures worth a warning", async () => {
    const warnings: string[] = [];
    const { chain } = fakeChain(async () => {
      throw new SimulationRevert("NotLiquidatable()");
    });
    const ex = new Executor(chain, { ...quiet, warn: (_f, m) => warnings.push(m) });
    expect((await ex.run([action("a")], 5))[0]!.outcome).toBe("skipped");
    expect(warnings).toEqual([]);
  });

  test("never sends the same action twice at once", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const { chain, sent } = fakeChain(async () => {
      await gate;
      return ok();
    });
    const ex = new Executor(chain, quiet);
    const first = ex.run([action("a")], 5);
    const second = await ex.run([action("a")], 5);
    expect(second).toEqual([]);
    release();
    await first;
    expect(sent.length).toBe(1);
  });
});
