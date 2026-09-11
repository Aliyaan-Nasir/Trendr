import { describe, expect, test } from "bun:test";
import { type Chain, type SendParams, type Sent, SimulationRevert } from "@trendr/chain";
import { activationTicketTypedData, type Call, deployments, encodeUpgrade, legacyPasskeyAccounts, type SessionConfig, tradingPermissions } from "@trendr/contracts";
import { type Address, encodeFunctionData, erc20Abi, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import type { BudgetLimits } from "../src/budget";
import { type ActivateInput, activationGasCap, GAS_CAP, RelayError, RelayerService, type SessionInput, type UpgradeInput } from "../src/service";
import type { TrendrTokens } from "../src/tokens";

const d = deployments[10143]!;
const NOW = 1_800_000_000;
const a = "0x00000000000000000000000000000000000000aa" as const;
const b = "0x00000000000000000000000000000000000000bb" as const;
const up = "0x00000000000000000000000000000000000000cc" as const;
const fake = "0x00000000000000000000000000000000000000dd" as const;

const sent = (gasLimit: bigint, status: Sent["status"] = "success"): Sent => ({
  hash: `0x${"ab".repeat(32)}`,
  status,
  blockNumber: 1n,
  gasUsed: gasLimit,
  gasLimit,
  logs: [],
});

/** A deferred promise, to hold a send open while other requests arrive. */
function gate() {
  let open!: () => void;
  const opened = new Promise<void>((r) => (open = r));
  return { open, opened };
}

const V1 = legacyPasskeyAccounts(10143)[0]!;

/** Accounts are active on the current PasskeyAccount unless listed otherwise; sends answer through `outcome`. */
class FakeChain implements Chain {
  readonly chainId = 10143;
  readonly fresh = new Set<string>();
  /** Delegated to the replaced version 1 implementation. */
  readonly v1 = new Set<string>();
  /** Delegated to some other contract. */
  readonly foreign = new Set<string>();
  readonly uninitialized = new Set<string>();
  readonly sends: SendParams[] = [];
  private readonly inFlight = new Map<string, number>();
  maxInFlightPerAccount = 0;
  maxInFlight = 0;
  outcome: (p: SendParams, n: number) => Promise<Sent> = async () => sent(500_000n);

  async code(account: Address) {
    const k = account.toLowerCase();
    if (this.fresh.has(k)) return undefined;
    const delegate = this.v1.has(k) ? V1 : this.foreign.has(k) ? fake : d.passkeyAccount;
    return `0xef0100${delegate.slice(2).toLowerCase()}` as Hex;
  }
  async nonce() {
    return 0;
  }
  async read({ address, functionName }: { address: Address; functionName: string }) {
    if (functionName === "isInitialized") return !this.uninitialized.has(address.toLowerCase());
    throw new Error(`unexpected read ${functionName}`);
  }
  async estimate() {
    return 100_000n;
  }
  async send(p: SendParams) {
    this.sends.push(p);
    const key = p.to.toLowerCase();
    this.inFlight.set(key, (this.inFlight.get(key) ?? 0) + 1);
    this.maxInFlightPerAccount = Math.max(this.maxInFlightPerAccount, this.inFlight.get(key)!);
    this.maxInFlight = Math.max(this.maxInFlight, [...this.inFlight.values()].reduce((x, y) => x + y, 0));
    try {
      return await this.outcome(p, this.sends.length);
    } finally {
      this.inFlight.set(key, this.inFlight.get(key)! - 1);
    }
  }
  senders() {
    return [];
  }
}

const tokens: TrendrTokens = { isTrendrToken: async (t) => t.toLowerCase() === up };

function setup(opts: { limits?: Partial<BudgetLimits>; maxPendingPerAccount?: number; tokens?: TrendrTokens; ticketSigner?: Address } = {}) {
  const chain = new FakeChain();
  const service = new RelayerService(
    chain,
    {
      deployment: d,
      maxSessionDailyLimit: 1_000_000_000n,
      maxSessionLifetime: 30 * 86_400,
      limits: opts.limits,
      maxPendingPerAccount: opts.maxPendingPerAccount,
      activationTicketSigner: opts.ticketSigner,
    },
    () => NOW,
    { tokens: opts.tokens ?? tokens },
  );
  return { chain, service };
}

const approve = (token: Address, spender: Address): Call => ({
  target: token,
  value: 0n,
  data: encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [spender, 1n] }),
});
const trade = (account: Address, calls: Call[] = [approve(d.ausd, d.outcomeMarkets)], signature: Hex = "0x01"): SessionInput => ({
  account,
  calls,
  sessionKey: b,
  deadline: BigInt(NOW + 600),
  signature,
});

async function refusal(p: Promise<unknown>) {
  try {
    await p;
  } catch (e) {
    if (e instanceof RelayError) return { status: e.status, code: e.code, retryAfter: e.retryAfter };
    throw e;
  }
  throw new Error("expected a refusal");
}

describe("gas budgets", () => {
  test("keep the gas limit sent, and nothing for a failed simulation", async () => {
    const { chain, service } = setup();
    chain.outcome = async () => sent(600_000n);
    await service.executeSession(trade(a));
    expect(chain.sends[0]!.gasCap).toBe(GAS_CAP.session);
    expect((await service.usage()).lastHour.gas).toBe(600_000);

    chain.outcome = async () => {
      throw new SimulationRevert("BadSignature()");
    };
    expect(await refusal(service.executeSession(trade(a)))).toEqual({ status: 422, code: "simulation_failed", retryAfter: undefined });
    expect((await service.usage()).lastHour.gas).toBe(600_000);
  });

  test("keep the whole cap when the outcome of a send is unknown", async () => {
    const { chain, service } = setup();
    chain.outcome = async () => {
      throw new Error("socket hang up");
    };
    await expect(service.executeSession(trade(a))).rejects.toThrow("socket hang up");
    expect((await service.usage()).lastHour.gas).toBe(Number(GAS_CAP.session));
  });

  test("refusals before the send release the reservation", async () => {
    const failing: TrendrTokens = {
      isTrendrToken: async () => {
        throw new Error("rpc down");
      },
    };
    const { chain, service } = setup({ tokens: failing });
    expect(await refusal(service.executeSession(trade(a, [approve(d.ausd, a)])))).toMatchObject({ status: 403, code: "policy" });
    await expect(service.executeSession(trade(a, [approve(up, d.trendrSpot)]))).rejects.toThrow("rpc down");
    expect(chain.sends).toHaveLength(0);
    expect((await service.usage()).lastHour.gas).toBe(0);
  });

  test("refuse an account over its daily gas without touching the chain", async () => {
    const { chain, service } = setup({ limits: { accountGasPerDay: 3_000_000n } });
    chain.outcome = async () => sent(GAS_CAP.session);
    await service.executeSession(trade(a));
    const r = await refusal(service.executeSession(trade(a)));
    expect(r).toMatchObject({ status: 429, code: "account_budget" });
    expect(r.retryAfter).toBeGreaterThan(0);
    expect(chain.sends).toHaveLength(1);
    // Another account still has its own allowance.
    await service.executeSession(trade(b));
  });

  test("refuse everyone once the relayer's hourly budget is spent", async () => {
    const { chain, service } = setup({ limits: { totalGasPerHour: 3_000_000n } });
    chain.outcome = async () => sent(GAS_CAP.session);
    await service.executeSession(trade(a));
    expect(await refusal(service.executeSession(trade(b)))).toMatchObject({ status: 429, code: "relayer_budget" });
  });

  test("pause an account whose relays keep reverting on chain", async () => {
    const { chain, service } = setup({ limits: { revertsBeforeCooldown: 2, revertCooldownSeconds: 600 } });
    chain.outcome = async () => sent(GAS_CAP.session, "reverted");
    expect(await refusal(service.executeSession(trade(a)))).toMatchObject({ status: 502, code: "reverted" });
    expect(await refusal(service.executeSession(trade(a)))).toMatchObject({ status: 502, code: "reverted" });
    expect(await refusal(service.executeSession(trade(a)))).toEqual({ status: 429, code: "account_cooldown", retryAfter: 600 });
    expect(chain.sends).toHaveLength(2);
    // Reverted relays are billed, so they count against the budgets too.
    expect((await service.usage()).today).toEqual({ accounts: 1, busiestAccountGas: 4_000_000, reverts: 2 });
    chain.outcome = async () => sent(500_000n);
    await service.executeSession(trade(b));
  });
});

describe("one relay per account", () => {
  test("a second request waits for the first; other accounts do not", async () => {
    const { chain, service } = setup();
    const g = gate();
    chain.outcome = async () => {
      await g.opened;
      return sent(500_000n);
    };
    const all = Promise.all([service.executeSession(trade(a)), service.executeSession(trade(a)), service.executeSession(trade(b))]);
    await Bun.sleep(5);
    expect(chain.sends.map((s) => s.to)).toEqual([a, b]);
    g.open();
    await all;
    expect(chain.sends).toHaveLength(3);
    expect(chain.maxInFlightPerAccount).toBe(1);
    expect(chain.maxInFlight).toBe(2);
  });

  test("two copies of one signed batch: the second fails simulation for free instead of reverting", async () => {
    const { chain, service } = setup();
    const used = new Set<string>();
    chain.outcome = async (p) => {
      // The account's nonce moves once the first copy lands.
      if (used.has(p.data)) throw new SimulationRevert("BadSignature()");
      await Bun.sleep(5);
      used.add(p.data);
      return sent(500_000n);
    };
    const results = await Promise.allSettled([service.executeSession(trade(a)), service.executeSession(trade(a))]);
    expect(results.map((r) => r.status)).toEqual(["fulfilled", "rejected"]);
    expect(((results[1] as PromiseRejectedResult).reason as RelayError).code).toBe("simulation_failed");
    expect((await service.usage()).lastHour.gas).toBe(500_000);
  });

  test("refuses requests beyond the queue", async () => {
    const { chain, service } = setup({ maxPendingPerAccount: 2 });
    const g = gate();
    chain.outcome = async () => {
      await g.opened;
      return sent(500_000n);
    };
    const first = service.executeSession(trade(a));
    const second = service.executeSession(trade(a));
    expect(await refusal(service.executeSession(trade(a)))).toEqual({ status: 409, code: "account_busy", retryAfter: undefined });
    expect((await service.usage()).busyAccounts).toBe(1);
    g.open();
    await Promise.all([first, second]);
    expect((await service.usage()).busyAccounts).toBe(0);
    // A failed request frees its place too.
    chain.outcome = async () => {
      throw new SimulationRevert("x");
    };
    await refusal(service.executeSession(trade(a)));
    await refusal(service.executeSession(trade(a)));
    expect((await service.usage()).busyAccounts).toBe(0);
  });
});

describe("activation", () => {
  async function activation(permissions = tradingPermissions(d)): Promise<ActivateInput> {
    const user = privateKeyToAccount(generatePrivateKey());
    const auth = await user.signAuthorization({ contractAddress: d.passkeyAccount, chainId: 10143, nonce: 0 });
    const session: SessionConfig = { key: b, validUntil: NOW + 86_400, dailyLimit: 100_000_000n, permissions };
    return {
      account: user.address,
      authorization: auth,
      owner: { x: `0x${"01".repeat(32)}`, y: `0x${"02".repeat(32)}` },
      session,
      deadline: BigInt(NOW + 600),
      eoaSignature: "0x01",
    };
  }

  test("is capped for the standard permissions, and refuses any other set", async () => {
    const { chain, service } = setup();
    const input = await activation();
    chain.fresh.add(input.account.toLowerCase());
    await service.activate(input);
    expect(chain.sends[0]!.gasCap).toBe(activationGasCap(tradingPermissions(d).length));
    expect(chain.sends[0]!.authorizationList).toHaveLength(1);

    const subset = await activation(tradingPermissions(d).slice(0, 2));
    chain.fresh.add(subset.account.toLowerCase());
    expect(await refusal(service.activate(subset))).toMatchObject({ status: 403, code: "policy" });
    const padded = await activation([...tradingPermissions(d), tradingPermissions(d)[0]!]);
    chain.fresh.add(padded.account.toLowerCase());
    expect(await refusal(service.activate(padded))).toMatchObject({ status: 403, code: "policy" });
    expect(chain.sends).toHaveLength(1);
  });

  test("is limited per hour across all accounts; a refused one does not count", async () => {
    const { chain, service } = setup({ limits: { activationsPerHour: 1 } });
    const bad = await activation(tradingPermissions(d).slice(1));
    expect(await refusal(service.activate(bad))).toMatchObject({ code: "policy" });
    const first = await activation();
    const second = await activation();
    chain.fresh.add(first.account.toLowerCase());
    chain.fresh.add(second.account.toLowerCase());
    await service.activate(first);
    expect(await refusal(service.activate(second))).toMatchObject({ status: 429, code: "activation_budget" });
    expect((await service.usage()).lastHour.activations).toBe(1);
  });

  test("needs the backend's ticket for this very account once a ticket signer is set", async () => {
    const backend = privateKeyToAccount(generatePrivateKey());
    const { chain, service } = setup({ ticketSigner: backend.address });
    const ticket = async (account: Address, expiresAt = NOW + 600, signer = backend) => ({ expiresAt, signature: await signer.signTypedData(activationTicketTypedData(10143, account, expiresAt)) });
    const input = await activation();
    const other = await activation();
    chain.fresh.add(input.account.toLowerCase());
    chain.fresh.add(other.account.toLowerCase());

    expect(await refusal(service.activate(input))).toMatchObject({ status: 403, code: "ticket_required" });
    // Another account's ticket, an expired one, one lasting too long and one from another key.
    expect(await refusal(service.activate({ ...input, ticket: await ticket(other.account) }))).toMatchObject({ status: 403, code: "bad_ticket" });
    expect(await refusal(service.activate({ ...input, ticket: await ticket(input.account, NOW) }))).toMatchObject({ status: 403, code: "ticket_expired" });
    expect(await refusal(service.activate({ ...input, ticket: await ticket(input.account, NOW + 3_600) }))).toMatchObject({ status: 403, code: "bad_ticket" });
    const stranger = privateKeyToAccount(generatePrivateKey());
    expect(await refusal(service.activate({ ...input, ticket: await ticket(input.account, NOW + 600, stranger) }))).toMatchObject({ status: 403, code: "bad_ticket" });
    // A ticket signed for another chain does not pass either.
    const mainnet = { expiresAt: NOW + 600, signature: await backend.signTypedData(activationTicketTypedData(143, input.account, NOW + 600)) };
    expect(await refusal(service.activate({ ...input, ticket: mainnet }))).toMatchObject({ status: 403, code: "bad_ticket" });
    expect(chain.sends).toHaveLength(0);

    await service.activate({ ...input, ticket: await ticket(input.account) });
    expect(chain.sends).toHaveLength(1);
    // Refusals cost nothing against the hourly activation budget.
    expect((await service.usage()).lastHour.activations).toBe(1);
  });

  test("takes no ticket without a ticket signer", async () => {
    const { chain, service } = setup();
    const input = await activation();
    chain.fresh.add(input.account.toLowerCase());
    await service.activate(input);
    expect(chain.sends).toHaveLength(1);
  });
});

describe("upgrade", () => {
  async function upgradeInput(opts: { sessions?: SessionConfig[]; to?: Address; signer?: Address } = {}): Promise<UpgradeInput> {
    const user = privateKeyToAccount(generatePrivateKey());
    const auth = await user.signAuthorization({ contractAddress: opts.to ?? d.passkeyAccount, chainId: 10143, nonce: 0 });
    const session: SessionConfig = { key: b, validUntil: NOW + 86_400, dailyLimit: 100_000_000n, permissions: tradingPermissions(d) };
    return { account: opts.signer ?? user.address, authorization: auth, sessions: opts.sessions ?? [session], deadline: BigInt(NOW + 600), eoaSignature: "0x01" };
  }

  test("moves a genuine version 1 account to the current PasskeyAccount", async () => {
    const { chain, service } = setup();
    const input = await upgradeInput();
    chain.v1.add(input.account.toLowerCase());
    expect(await service.status(input.account)).toMatchObject({ active: true, version: 1 });
    await service.upgrade(input);
    expect(chain.sends).toHaveLength(1);
    expect(chain.sends[0]!.gasCap).toBe(activationGasCap(tradingPermissions(d).length));
    expect(chain.sends[0]!.authorizationList).toEqual([input.authorization]);
    expect(chain.sends[0]!.data).toBe(encodeUpgrade(input.sessions, input.deadline, input.eoaSignature));
  });

  test("delegates only to the current PasskeyAccount", async () => {
    const { chain, service } = setup();
    for (const to of [V1, fake]) {
      const input = await upgradeInput({ to });
      chain.v1.add(input.account.toLowerCase());
      expect(await refusal(service.upgrade(input))).toMatchObject({ status: 403, code: "wrong_delegate" });
    }
    expect(chain.sends).toHaveLength(0);
  });

  test("only for accounts initialized on version 1", async () => {
    const { chain, service } = setup();
    const current = await upgradeInput();
    expect(await refusal(service.upgrade(current))).toMatchObject({ status: 409, code: "already_upgraded" });
    const fresh = await upgradeInput();
    chain.fresh.add(fresh.account.toLowerCase());
    expect(await refusal(service.upgrade(fresh))).toMatchObject({ status: 409, code: "not_upgradable" });
    const foreign = await upgradeInput();
    chain.foreign.add(foreign.account.toLowerCase());
    expect(await refusal(service.upgrade(foreign))).toMatchObject({ status: 409, code: "not_upgradable" });
    const halfway = await upgradeInput();
    chain.v1.add(halfway.account.toLowerCase());
    chain.uninitialized.add(halfway.account.toLowerCase());
    expect(await refusal(service.upgrade(halfway))).toMatchObject({ status: 409, code: "not_upgradable" });
    expect(chain.sends).toHaveLength(0);
  });

  test("needs the account's own authorization and one standard session", async () => {
    const { chain, service } = setup();
    const stolen = await upgradeInput({ signer: a });
    chain.v1.add(a);
    expect(await refusal(service.upgrade(stolen))).toMatchObject({ status: 400, code: "bad_authorization" });
    const session: SessionConfig = { key: b, validUntil: NOW + 86_400, dailyLimit: 100_000_000n, permissions: tradingPermissions(d) };
    const two = await upgradeInput({ sessions: [session, { ...session, key: up }] });
    chain.v1.add(two.account.toLowerCase());
    expect(await refusal(service.upgrade(two))).toMatchObject({ status: 403, code: "policy" });
    // Perpl orders without their guard are not the standard permissions.
    const unguarded = await upgradeInput({
      sessions: [{ ...session, permissions: tradingPermissions(d).map((p) => ({ ...p, guard: "0x0000000000000000000000000000000000000000" as Address })) }],
    });
    chain.v1.add(unguarded.account.toLowerCase());
    expect(await refusal(service.upgrade(unguarded))).toMatchObject({ status: 403, code: "policy" });
    expect(chain.sends).toHaveLength(0);
  });

  test("counts against the activation budget", async () => {
    const { chain, service } = setup({ limits: { activationsPerHour: 1 } });
    const first = await upgradeInput();
    chain.v1.add(first.account.toLowerCase());
    await service.upgrade(first);
    const second = await upgradeInput();
    chain.v1.add(second.account.toLowerCase());
    expect(await refusal(service.upgrade(second))).toMatchObject({ status: 429, code: "activation_budget" });
  });

  test("version 1 accounts keep trading and are told to upgrade instead of activating", async () => {
    const { chain, service } = setup();
    chain.v1.add(a);
    await service.executeSession(trade(a));
    expect(chain.sends).toHaveLength(1);
    const user = privateKeyToAccount(generatePrivateKey());
    chain.v1.add(user.address.toLowerCase());
    const auth = await user.signAuthorization({ contractAddress: d.passkeyAccount, chainId: 10143, nonce: 0 });
    const input: ActivateInput = {
      account: user.address,
      authorization: auth,
      owner: { x: `0x${"01".repeat(32)}`, y: `0x${"02".repeat(32)}` },
      session: { key: b, validUntil: NOW + 86_400, dailyLimit: 100_000_000n, permissions: tradingPermissions(d) },
      deadline: BigInt(NOW + 600),
      eoaSignature: "0x01",
    };
    expect(await refusal(service.activate(input))).toMatchObject({ status: 409, code: "upgrade_required" });
    // Delegated to version 1 but never initialized: activates afresh on the current PasskeyAccount.
    chain.uninitialized.add(user.address.toLowerCase());
    await service.activate(input);
    expect(chain.sends).toHaveLength(2);
  });
});

describe("owner batches", () => {
  test("transfer only AUSD and Trendr tokens", async () => {
    const { chain, service } = setup();
    const transfer = (token: Address): Call => ({
      target: token,
      value: 0n,
      data: encodeFunctionData({ abi: erc20Abi, functionName: "transfer", args: [b, 1n] }),
    });
    const auth = { authenticatorData: "0x00" as Hex, clientDataJSON: "{}", challengeIndex: 0n, typeIndex: 0n, r: `0x${"00".repeat(32)}` as Hex, s: `0x${"00".repeat(32)}` as Hex };
    const owner = (calls: Call[]) => service.executeOwner({ account: a, calls, deadline: BigInt(NOW + 600), auth });
    await owner([transfer(d.ausd), transfer(up)]);
    expect(chain.sends[0]!.gasCap).toBe(GAS_CAP.owner);
    expect(await refusal(owner([transfer(fake)]))).toMatchObject({ status: 403, code: "policy" });
    expect(chain.sends).toHaveLength(1);
  });
});
