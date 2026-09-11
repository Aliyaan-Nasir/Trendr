import { describe, expect, test } from "bun:test";
import { type BudgetLimits, DEFAULT_LIMITS, MemoryBudget, type Reservation } from "../src/budget";

const a = "0x00000000000000000000000000000000000000aa" as const;
const b = "0x00000000000000000000000000000000000000bb" as const;
const DAY = 86_400;
/** Noon UTC on some day, so a few hours either way stay in it. */
const T = 20_000 * DAY + 12 * 3_600;

const limits = (over: Partial<BudgetLimits> = {}): BudgetLimits => ({ ...DEFAULT_LIMITS, ...over });

async function reserved(budget: MemoryBudget, account: `0x${string}`, gas: bigint, now: number, kind: "session" | "activation" = "session") {
  const r = await budget.reserve(account, kind, gas, now);
  if (!r.ok) throw new Error(`refused: ${r.code}`);
  return r.reservation;
}

describe("account budget", () => {
  test("caps the gas limit one account spends per UTC day, until the next day", async () => {
    const budget = new MemoryBudget(limits({ accountGasPerDay: 5_000_000n }));
    await reserved(budget, a, 2_000_000n, T);
    await reserved(budget, a, 2_000_000n, T + 60);
    const refused = await budget.reserve(a, "session", 2_000_000n, T + 120);
    expect(refused).toEqual({
      ok: false,
      code: "account_budget",
      message: "this account has used its gas allowance for today",
      retryAfter: 12 * 3_600 - 120,
    });
    // Another account is not affected, and the next UTC day starts afresh.
    expect((await budget.reserve(b, "session", 2_000_000n, T + 120)).ok).toBe(true);
    expect((await budget.reserve(a, "session", 2_000_000n, T + 12 * 3_600)).ok).toBe(true);
  });

  test("keeps only the gas limit actually sent", async () => {
    const budget = new MemoryBudget(limits({ accountGasPerDay: 3_000_000n }));
    // The cap is reserved, the send used less, and a failed simulation sent nothing.
    await budget.settle(await reserved(budget, a, 2_000_000n, T), 600_000n);
    await budget.settle(await reserved(budget, a, 2_000_000n, T), 0n);
    expect((await budget.usage(T)).today).toEqual({ accounts: 1, busiestAccountGas: 600_000, reverts: 0 });
    expect((await budget.reserve(a, "session", 2_000_000n, T)).ok).toBe(true);
    expect((await budget.reserve(a, "session", 500_000n, T)).ok).toBe(false);
  });

  test("a settlement after midnight leaves the new day alone", async () => {
    const budget = new MemoryBudget(limits({ accountGasPerDay: 3_000_000n }));
    const late = await reserved(budget, a, 2_000_000n, T + 12 * 3_600 - 1);
    await reserved(budget, a, 2_000_000n, T + 12 * 3_600);
    await budget.settle(late, 0n);
    expect((await budget.reserve(a, "session", 2_000_000n, T + 12 * 3_600)).ok).toBe(false);
  });
});

describe("relayer budget", () => {
  test("caps all accounts together over a rolling hour", async () => {
    const budget = new MemoryBudget(limits({ totalGasPerHour: 5_000_000n }));
    await reserved(budget, a, 2_000_000n, T);
    await reserved(budget, b, 2_000_000n, T + 600);
    const refused = await budget.reserve("0x00000000000000000000000000000000000000cc", "owner", 2_000_000n, T + 1_200);
    // The first minute's gas leaves the window an hour after it was spent.
    expect(refused).toMatchObject({ ok: false, code: "relayer_budget", retryAfter: 3_600 - 1_200 });
    expect((await budget.reserve("0x00000000000000000000000000000000000000cc", "owner", 2_000_000n, T + 3_599)).ok).toBe(false);
    expect((await budget.reserve("0x00000000000000000000000000000000000000cc", "owner", 2_000_000n, T + 3_600)).ok).toBe(true);
    expect((await budget.usage(T + 3_600)).lastHour.gas).toBe(4_000_000);
  });

  test("caps activations per rolling hour; one that sent nothing does not count", async () => {
    const budget = new MemoryBudget(limits({ activationsPerHour: 2 }));
    const first = await reserved(budget, a, 1_000_000n, T, "activation");
    await reserved(budget, b, 1_000_000n, T + 10, "activation");
    expect(await budget.reserve("0x00000000000000000000000000000000000000cc", "activation", 1_000_000n, T + 20)).toMatchObject({
      ok: false,
      code: "activation_budget",
    });
    // Sessions are not activations.
    expect((await budget.reserve("0x00000000000000000000000000000000000000cc", "session", 1_000_000n, T + 20)).ok).toBe(true);
    await budget.settle(first, 0n);
    expect((await budget.reserve("0x00000000000000000000000000000000000000cc", "activation", 1_000_000n, T + 20)).ok).toBe(true);
    expect((await budget.usage(T + 20)).lastHour.activations).toBe(2);
  });
});

describe("reverts", () => {
  test("pause an account for the cooldown from the threshold on", async () => {
    const budget = new MemoryBudget(limits({ revertsBeforeCooldown: 3, revertCooldownSeconds: 600 }));
    await budget.recordRevert(a, T);
    await budget.recordRevert(a, T + 1);
    expect((await budget.reserve(a, "session", 1n, T + 2)).ok).toBe(true);
    await budget.recordRevert(a, T + 2);
    expect(await budget.reserve(a, "session", 1n, T + 3)).toEqual({
      ok: false,
      code: "account_cooldown",
      message: "too many transactions from this account reverted; try again later",
      retryAfter: 599,
    });
    expect((await budget.reserve(b, "session", 1n, T + 3)).ok).toBe(true);
    expect((await budget.usage(T + 3)).coolingDown).toBe(1);
    // After the cooldown the account may relay again, but its next revert pauses it at once.
    expect((await budget.reserve(a, "session", 1n, T + 602)).ok).toBe(true);
    await budget.recordRevert(a, T + 603);
    expect(await budget.reserve(a, "session", 1n, T + 604)).toMatchObject({ ok: false, code: "account_cooldown" });
  });

  test("the count starts again each UTC day, but a running cooldown carries over", async () => {
    const budget = new MemoryBudget(limits({ revertsBeforeCooldown: 2, revertCooldownSeconds: 3_600 }));
    const evening = T + 12 * 3_600 - 600;
    await budget.recordRevert(a, evening);
    await budget.recordRevert(a, evening);
    const nextDay = T + 12 * 3_600;
    expect(await budget.reserve(a, "session", 1n, nextDay)).toMatchObject({ ok: false, code: "account_cooldown", retryAfter: 3_000 });
    await budget.recordRevert(a, nextDay + 3_000);
    expect((await budget.reserve(a, "session", 1n, nextDay + 3_001)).ok).toBe(true);
  });
});

describe("usage", () => {
  test("reports the rolling hour, today and the limits", async () => {
    const budget = new MemoryBudget(limits());
    await budget.settle(await reserved(budget, a, 1_200_000n, T, "activation"), 900_000n);
    await budget.settle(await reserved(budget, a, 2_000_000n, T + 5), 400_000n);
    await budget.settle(await reserved(budget, b, 2_000_000n, T + 9), 2_000_000n);
    await budget.recordRevert(b, T + 9);
    expect(await budget.usage(T + 10)).toEqual({
      limits: { accountGasPerDay: 40_000_000, totalGasPerHour: 300_000_000, activationsPerHour: 60 },
      lastHour: { gas: 3_300_000, activations: 1 },
      today: { accounts: 2, busiestAccountGas: 2_000_000, reverts: 1 },
      coolingDown: 0,
    });
    // A day later only what still matters is left.
    expect(await budget.usage(T + DAY)).toMatchObject({ lastHour: { gas: 0, activations: 0 }, today: { accounts: 0 } });
  });

  test("forgets past days once nothing holds them", async () => {
    const budget = new MemoryBudget(limits());
    for (let i = 0; i < 50; i++) await reserved(budget, `0x${i.toString(16).padStart(40, "0")}`, 1n, T);
    await budget.reserve(a, "session", 1n, T + DAY);
    const accounts = (budget as unknown as { accounts: Map<string, unknown> }).accounts;
    expect(accounts.size).toBe(1);
  });

  test("a reservation is the worst case until settled", async () => {
    const budget = new MemoryBudget(limits({ totalGasPerHour: 2_000_000n }));
    const r: Reservation = await reserved(budget, a, 2_000_000n, T);
    expect((await budget.reserve(b, "session", 1n, T)).ok).toBe(false);
    await budget.settle(r, 1_000_000n);
    expect((await budget.reserve(b, "session", 1_000_000n, T)).ok).toBe(true);
  });
});
