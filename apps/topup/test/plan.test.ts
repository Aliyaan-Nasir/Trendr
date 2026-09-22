import { describe, expect, test } from "bun:test";
import { parseEther } from "viem";
import type { Target } from "../src/config";
import { freshMemory, HOUR_MS, type PlanOptions, plan, recordFailure, type TargetMemory, type TargetView, type TransferRecord } from "../src/plan";

const e = (mon: string) => parseEther(mon);
const NOW = 1_800_000_000_000;
const FEE = e("0.002");

const target = (name: string, min: string, goal: string, perTransfer = goal, perDay = "100"): Target => ({
  name,
  address: `0x${name.padStart(40, "0").slice(-40).replace(/[^0-9a-f]/g, "a")}`,
  min: e(min),
  target: e(goal),
  maxPerTransfer: e(perTransfer),
  maxPerDay: e(perDay),
});
const ORACLE = target("oracle", "5", "20");
const KEEPER = target("keeper", "3", "12");
const RELAYER = target("relayer", "1.5", "5");

const view = (t: Target, balance: string): TargetView => ({ target: t, balance: e(balance), fee: FEE });
const opts: PlanOptions = { floor: e("12"), cooldownMs: 600_000, maxRefillsPerHour: 3, minTransfer: e("0.1") };
const transfer = (name: string, amount: string, agoMs: number, extra: Partial<TransferRecord> = {}): TransferRecord => ({
  id: `${name}-${agoMs}`,
  target: name,
  amount: e(amount).toString(),
  at: NOW - agoMs,
  status: "confirmed",
  partial: false,
  ...extra,
});
const memory = (m: Partial<TargetMemory>) => ({ ...freshMemory(), ...m });

describe("plan", () => {
  test("refills what is below min up to target and leaves the rest", () => {
    const p = plan(NOW, e("100"), [view(ORACLE, "4"), view(KEEPER, "5"), view(RELAYER, "1")], {}, [], opts);
    expect(p.decisions.map((d) => [d.name, d.state, d.amount])).toEqual([
      ["oracle", "send", e("16")],
      ["keeper", "ok", 0n],
      ["relayer", "send", e("4")],
    ]);
    expect(p.treasuryLow).toBe(false);
    expect(p.starved).toEqual([]);
  });

  test("serves by priority and never takes the treasury below its floor", () => {
    // 12 floor + 18 spendable: the oracle's 16 fits, the keeper's 12 does not.
    const p = plan(NOW, e("30"), [view(ORACLE, "4"), view(KEEPER, "0"), view(RELAYER, "1")], {}, [], opts);
    const [oracle, keeper, relayer] = p.decisions;
    expect(oracle).toMatchObject({ state: "send", amount: e("16"), partial: false });
    // What is left after the oracle and its fee goes to the keeper as a partial refill.
    expect(keeper).toMatchObject({ state: "send", partial: true });
    expect(keeper!.amount).toBe(e("30") - e("12") - e("16") - FEE - FEE);
    expect(relayer).toMatchObject({ state: "starved", amount: 0n });
    const spent = p.decisions.reduce((a, d) => a + d.amount + (d.state === "send" ? FEE : 0n), 0n);
    expect(e("30") - spent).toBe(e("12"));
    expect(p.treasuryLow).toBe(true);
    expect(p.starved).toEqual(["keeper", "relayer"]);
  });

  test("skips a remainder too small to be worth a transfer", () => {
    const p = plan(NOW, e("12.05"), [view(ORACLE, "4")], {}, [], opts);
    expect(p.decisions[0]!.state).toBe("starved");
    expect(p.treasuryLow).toBe(true);
  });

  test("is low below the floor even when nobody needs anything", () => {
    const p = plan(NOW, e("11"), [view(ORACLE, "10")], {}, [], opts);
    expect(p.decisions[0]!.state).toBe("ok");
    expect(p.treasuryLow).toBe(true);
    expect(p.spendable).toBe(0n);
  });

  test("a lower-priority wallet is served while a higher one cools down", () => {
    const p = plan(NOW, e("100"), [view(ORACLE, "4"), view(KEEPER, "0")], {}, [transfer("oracle", "1", 60_000)], opts);
    expect(p.decisions.map((d) => d.state)).toEqual(["cooldown", "send"]);
    // The cooling wallet still counts as owed, so a short treasury stays low between checks.
    expect(p.owed).toBe(e("16") + FEE + e("12") + FEE);
  });

  test("the treasury stays low while a partly refilled wallet cools down", () => {
    const p = plan(NOW, e("13"), [view(ORACLE, "4")], {}, [transfer("oracle", "1", 60_000, { partial: true })], opts);
    expect(p.decisions[0]!.state).toBe("cooldown");
    expect(p.treasuryLow).toBe(true);
  });

  test("the cooldown follows any transfer that may have moved MON, and ends", () => {
    for (const status of ["confirmed", "pending", "unknown"] as const) {
      expect(plan(NOW, e("100"), [view(ORACLE, "4")], {}, [transfer("oracle", "1", 60_000, { status })], opts).decisions[0]!.state).toBe("cooldown");
    }
    expect(plan(NOW, e("100"), [view(ORACLE, "4")], {}, [transfer("oracle", "1", 60_000, { status: "failed" })], opts).decisions[0]!.state).toBe("send");
    expect(plan(NOW, e("100"), [view(ORACLE, "4")], {}, [transfer("oracle", "1", 600_001)], opts).decisions[0]!.state).toBe("send");
  });

  test("a failing wallet backs off, doubling up to the maximum", () => {
    const m = freshMemory();
    const backoff = { firstMs: 120_000, maxMs: HOUR_MS };
    const delays: number[] = [];
    for (let i = 0; i < 7; i++) {
      recordFailure(m, NOW, "boom", backoff);
      delays.push(m.retryAt - NOW);
    }
    expect(delays).toEqual([120_000, 240_000, 480_000, 960_000, 1_920_000, HOUR_MS, HOUR_MS]);
    expect(plan(NOW, e("100"), [view(ORACLE, "4")], { oracle: m }, [], opts).decisions[0]!.state).toBe("backoff");
    expect(plan(NOW + HOUR_MS, e("100"), [view(ORACLE, "4")], { oracle: m }, [], opts).decisions[0]!.state).toBe("send");
  });

  test("sends at most maxPerTransfer", () => {
    const small = target("oracle", "5", "20", "6");
    expect(plan(NOW, e("100"), [view(small, "0")], {}, [], opts).decisions[0]!.amount).toBe(e("6"));
  });

  test("sends what the daily cap leaves, then stops at the cap", () => {
    const capped = target("oracle", "5", "20", "20", "30");
    const earlier = [transfer("oracle", "15", 10 * HOUR_MS), transfer("oracle", "9", 2 * HOUR_MS)];
    const first = plan(NOW, e("100"), [view(capped, "4")], {}, earlier, opts);
    expect(first.decisions[0]).toMatchObject({ state: "send", amount: e("6"), allowance: e("6") });
    const all = [...earlier, transfer("oracle", "6", 0)];
    const second = plan(NOW + 700_000, e("100"), [view(capped, "4")], {}, all, opts);
    expect(second.decisions[0]).toMatchObject({ state: "capped", allowance: 0n });
    // A capped wallet is not owed: the cap, not the treasury, is what holds it back.
    expect(second.treasuryLow).toBe(false);
  });

  test("the daily cap is a rolling 24 hours and ignores transfers that moved nothing", () => {
    const capped = target("oracle", "5", "20", "20", "20");
    const ledger = [transfer("oracle", "20", 24 * HOUR_MS + 1), transfer("oracle", "20", 60_000, { status: "failed" })];
    expect(plan(NOW, e("100"), [view(capped, "4")], {}, ledger, opts).decisions[0]).toMatchObject({ state: "send", amount: e("16") });
    // Pending and unknown transfers may have moved MON, so they count.
    for (const status of ["pending", "unknown"] as const) {
      const maybe = [transfer("oracle", "20", 60 * 60_000, { status })];
      expect(plan(NOW, e("100"), [view(capped, "4")], {}, maybe, opts).decisions[0]!.state).toBe("capped");
    }
  });

  test("halts a wallet that refills abnormally often", () => {
    const recent = [transfer("oracle", "16", 50 * 60_000), transfer("oracle", "16", 30 * 60_000), transfer("oracle", "16", 11 * 60_000)];
    const p = plan(NOW, e("1000"), [view(ORACLE, "0"), view(KEEPER, "0")], {}, recent, opts);
    expect(p.decisions[0]).toMatchObject({ state: "halted", amount: 0n });
    expect(p.decisions[0]!.halt).toContain("3 refills in the last hour");
    // The rest are still served.
    expect(p.decisions[1]!.state).toBe("send");
  });

  test("a halted wallet stays halted, and is not owed", () => {
    const p = plan(NOW, e("12"), [view(ORACLE, "0")], { oracle: memory({ halted: { at: NOW - 1, reason: "x" } }) }, [], opts);
    expect(p.decisions[0]!.state).toBe("halted");
    expect(p.decisions[0]!.halt).toBeUndefined();
    expect(p.treasuryLow).toBe(false);
  });

  test("a release restarts the frequency count, and treasury-limited partial refills never count", () => {
    const recent = [transfer("oracle", "16", 50 * 60_000), transfer("oracle", "16", 30 * 60_000), transfer("oracle", "16", 11 * 60_000)];
    const released = plan(NOW, e("1000"), [view(ORACLE, "0")], { oracle: memory({ releasedAt: NOW - 5 * 60_000 }) }, recent, opts);
    expect(released.decisions[0]!.state).toBe("send");
    const partials = recent.map((r) => ({ ...r, partial: true }));
    expect(plan(NOW, e("1000"), [view(ORACLE, "0")], {}, partials, opts).decisions[0]!.state).toBe("send");
  });
});
