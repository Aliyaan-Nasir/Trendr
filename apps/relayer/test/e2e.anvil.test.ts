/**
 * End to end against a local Anvil (Osaka: EIP-7702 and the P256 precompile) with the real
 * contracts from script/Deploy.s.sol. Run with RELAYER_E2E=1 (needs anvil and forge on PATH).
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import {
  type Call,
  type Deployment,
  outcomeListingAbi,
  outcomeMarketsAbi,
  ownerExecuteDigest,
  passkeyAccountAbi,
  perplPermissions,
  type SessionConfig,
  sessionExecuteTypedData,
  trendRegistryAbi,
  trendrErrorAbis,
  tradingPermissions,
  upgradeTypedData,
} from "@trendr/contracts";
import { encodeExecOrder, type OrderDesc } from "@trendr/perpl";
import pino from "pino";
import { type Address, createPublicClient, createWalletClient, encodeAbiParameters, encodeFunctionData, erc20Abi, type Hex, http, keccak256, parseAbi, toBytes } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { monadChain, ViemChainClient } from "@trendr/chain";
import { buildServer } from "../src/server";
import { RelayerService } from "../src/service";
import { runAccountFlow, softPasskey, toJson } from "./flow";

const enabled = process.env.RELAYER_E2E === "1";
const ANVIL_KEYS = [
  "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
  "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
] as const;
const contractsDir = join(import.meta.dir, "..", "..", "..", "contracts");
const port = 8600 + Math.floor(Math.random() * 1000);
const rpc = `http://127.0.0.1:${port}`;
const chain = monadChain(31_337, rpc);
const pub = createPublicClient({ chain, transport: http(rpc) });
const deployer = createWalletClient({ chain, transport: http(rpc), account: privateKeyToAccount(ANVIL_KEYS[0]) });

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
let app: ReturnType<typeof buildServer>;
let seriesId: Hex;
let upToken: Address;
/** PasskeyAccount version 1 (contracts/test/legacy), deployed here as the replaced implementation. */
let v1: Address;
/** Perpl stand-in (contracts/test/mocks) at a mark of 83,037.7 for perpetual 16. */
let perpl: Address;
let staleGuard: Address;
const MARK = 830_377n;

async function artifact(file: string, name: string) {
  const a = await Bun.file(join(contractsDir, "out", file, `${name}.json`)).json();
  return { abi: a.abi, bytecode: a.bytecode.object as Hex };
}

const mockPerplAbi = parseAbi([
  "function setMark(uint256 perpId, uint256 mark, uint256 timestamp)",
  "function depositCollateral(uint256 amount)",
  "function executedCount() view returns (uint256)",
]);

/** Version 1's session encoding: permissions without a guard. */
const v1SessionAbi = [
  {
    type: "tuple",
    components: [
      { name: "key", type: "address" },
      { name: "validUntil", type: "uint48" },
      { name: "dailyLimit", type: "uint128" },
      {
        name: "permissions",
        type: "tuple[]",
        components: [
          { name: "target", type: "address" },
          { name: "selector", type: "bytes4" },
          { name: "recipientArg", type: "uint8" },
        ],
      },
    ],
  },
] as const;

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

describe.skipIf(!enabled)("relayer end to end on Anvil", () => {
  beforeAll(async () => {
    anvil = Bun.spawn(["anvil", "--hardfork", "osaka", "--port", String(port), "--silent"], { stdout: "ignore", stderr: "ignore" });
    await waitForRpc();
    const deploy = Bun.spawnSync(
      ["forge", "script", "script/Deploy.s.sol", "--rpc-url", rpc, "--private-key", ANVIL_KEYS[0], "--broadcast", "--non-interactive"],
      { cwd: contractsDir, env: { ...process.env, CRE_MODE: "mock" } },
    );
    if (deploy.exitCode !== 0) throw new Error(`deploy failed: ${deploy.stderr.toString()}`);
    d = (await Bun.file(join(contractsDir, "deployments", "31337.json")).json()) as Deployment;

    // A trend through the registry (the deployer is the local forwarder and broadcaster), then a series.
    const now = (await pub.getBlock()).timestamp;
    const report = encodeAbiParameters(REPORT, [
      {
        runId: 1n,
        observedAt: now,
        newTrends: [{ identifier: "topic:e2e", assetClass: 6, index: 40_000_000n, surfacer: deployer.account.address, smartMoneyConfirmed: false }],
        updates: [],
        settlements: [],
      },
    ]);
    await pub.waitForTransactionReceipt({
      hash: await deployer.writeContract({ address: d.trendRegistry, abi: trendRegistryAbi, functionName: "onReport", args: ["0x", report] }),
    });
    await pub.waitForTransactionReceipt({
      hash: await deployer.writeContract({ address: d.outcomeMarkets, abi: outcomeMarketsAbi, functionName: "openSeries", args: ["topic:e2e", 86_400] }),
    });
    seriesId = (await pub.readContract({
      address: d.outcomeMarkets,
      abi: outcomeMarketsAbi,
      functionName: "latestSeries",
      args: [keccak256(toBytes("topic:e2e")), 86_400],
    })) as Hex;

    // List the series on the local Kuru stand-in, which swaps at 0.50 from its own balance.
    await pub.waitForTransactionReceipt({
      hash: await deployer.writeContract({ address: d.outcomeListing, abi: outcomeListingAbi, functionName: "list", args: [seriesId] }),
    });
    const mint = parseAbi(["function mint(address to, uint256 amount)"]);
    const send = async (hash: Promise<Hex>) => pub.waitForTransactionReceipt({ hash: await hash });
    await send(deployer.writeContract({ address: d.ausd, abi: mint, functionName: "mint", args: [deployer.account.address, 2_000_000_000n] }));
    await send(deployer.writeContract({ address: d.ausd, abi: erc20Abi, functionName: "approve", args: [d.outcomeMarkets, 1_000_000_000n] }));
    await send(deployer.writeContract({ address: d.outcomeMarkets, abi: outcomeMarketsAbi, functionName: "mint", args: [seriesId, 1_000_000_000n, d.kuruRouter] }));
    await send(deployer.writeContract({ address: d.ausd, abi: erc20Abi, functionName: "transfer", args: [d.kuruRouter, 1_000_000_000n] }));
    upToken = (await pub.readContract({ address: d.outcomeMarkets, abi: outcomeMarketsAbi, functionName: "seriesOf", args: [seriesId] })).up;

    // The replaced version 1 implementation, and Perpl with its order guard.
    const deployed = async (file: string, name: string, args: unknown[]) => {
      const { abi, bytecode } = await artifact(file, name);
      const r = await pub.waitForTransactionReceipt({ hash: await deployer.deployContract({ abi, bytecode, args }) });
      return r.contractAddress!;
    };
    v1 = await deployed("PasskeyAccountV1.sol", "PasskeyAccountV1", [d.ausd]);
    perpl = await deployed("MockPerplExchange.sol", "MockPerplExchange", [d.ausd]);
    const guard = await deployed("PerplOrderGuard.sol", "PerplOrderGuard", [perpl, 200n, 120n, 1000n]);
    // A guard deployed before it, which sessions may no longer name.
    staleGuard = await deployed("PerplOrderGuard.sol", "PerplOrderGuard", [perpl, 200n, 120n, 5000n]);
    d = { ...d, perplExchange: perpl, perplOrderGuard: guard, perplSessionMaxLeverageHdths: 1000 };

    const service = new RelayerService(
      new ViemChainClient(rpc, 31_337, [ANVIL_KEYS[1]], undefined, trendrErrorAbis),
      { deployment: d, maxSessionDailyLimit: 1_000_000_000n, maxSessionLifetime: 30 * 86_400, legacyPasskeyAccounts: [v1] },
      () => Number(now),
    );
    app = buildServer({ service, allowedOrigins: ["https://app.trendr.test"], log: pino({ level: "silent" }) });
  }, 120_000);

  afterAll(() => {
    anvil?.kill();
  });

  test("activate, trade with a session, withdraw with the passkey", async () => {
    await runAccountFlow({
      app,
      pub,
      chainId: 31_337,
      d,
      seriesId,
      thief: deployer.account.address,
      now: async () => Number((await pub.getBlock()).timestamp),
      spot: {
        token: upToken,
        // The stand-in pays 2 tokens per AUSD and 0.5 AUSD per token, all or nothing.
        minOutForBuy: async (ausdIn) => ausdIn * 2n,
        minOutForSell: async (amountIn) => amountIn / 2n,
      },
      fund: async (to, amount) => {
        const mint = parseAbi(["function mint(address to, uint256 amount)"]);
        await pub.waitForTransactionReceipt({ hash: await deployer.writeContract({ address: d.ausd, abi: mint, functionName: "mint", args: [to, amount] }) });
      },
    });
  }, 120_000);

  test("a version 1 account upgrades once, keeps its owner and nonces, and trades within the gross limit and the Perpl band", async () => {
    const post = async (path: string, body: unknown) => {
      const res = await app.request(path, { method: "POST", headers: { "content-type": "application/json" }, body: toJson(body) });
      return { status: res.status, body: (await res.json()) as Record<string, string> };
    };
    const now = Number((await pub.getBlock()).timestamp);
    const deadline = BigInt(now + 600);
    const user = privateKeyToAccount(generatePrivateKey());
    const key = privateKeyToAccount(generatePrivateKey());
    const passkey = await softPasskey();
    const mint = parseAbi(["function mint(address to, uint256 amount)"]);
    await pub.waitForTransactionReceipt({ hash: await deployer.writeContract({ address: d.ausd, abi: mint, functionName: "mint", args: [user.address, 100_000_000n] }) });

    // 1. A version 1 account as the app made them before: delegate and initialize, version 1's session format.
    const v1Permissions = tradingPermissions(d).map(({ target, selector, recipientArg }) => ({ target, selector, recipientArg }));
    const v1Session = { key: key.address, validUntil: now + 86_400, dailyLimit: 40_000_000n, permissions: v1Permissions };
    const v1Hash = keccak256(
      encodeAbiParameters(
        [{ type: "address" }, { type: "uint48" }, { type: "uint128" }, { type: "bytes32" }],
        [v1Session.key, v1Session.validUntil, v1Session.dailyLimit, keccak256(encodeAbiParameters([v1SessionAbi[0].components[3]], [v1Permissions]))],
      ),
    );
    const initSig = await user.signTypedData({
      domain: { name: "Trendr PasskeyAccount", version: "1", chainId: 31_337, verifyingContract: user.address },
      types: { Initialize: [{ name: "ownerX", type: "bytes32" }, { name: "ownerY", type: "bytes32" }, { name: "sessionHash", type: "bytes32" }, { name: "deadline", type: "uint256" }] },
      primaryType: "Initialize",
      message: { ownerX: passkey.publicKey.x, ownerY: passkey.publicKey.y, sessionHash: v1Hash, deadline },
    });
    const v1Init = [
      {
        type: "function",
        name: "initialize",
        stateMutability: "nonpayable",
        inputs: [{ type: "bytes32" }, { type: "bytes32" }, v1SessionAbi[0], { type: "uint256" }, { type: "bytes" }],
        outputs: [],
      },
    ] as const;
    const toV1 = await user.signAuthorization({ contractAddress: v1, chainId: 31_337, nonce: 0 });
    await pub.waitForTransactionReceipt({
      hash: await deployer.sendTransaction({
        to: user.address,
        authorizationList: [toV1],
        data: encodeFunctionData({ abi: v1Init, functionName: "initialize", args: [passkey.publicKey.x, passkey.publicKey.y, v1Session, deadline, initSig] }),
      }),
    });
    expect(await (await app.request(`/v1/accounts/${user.address}`)).json()).toEqual({ delegatedTo: v1.toLowerCase(), active: true, version: 1 });

    // Version 1 accounts keep trading until they upgrade.
    const mintCalls = (amount: bigint): Call[] => [
      { target: d.ausd, value: 0n, data: encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [d.outcomeMarkets, amount] }) },
      { target: d.outcomeMarkets, value: 0n, data: encodeFunctionData({ abi: outcomeMarketsAbi, functionName: "mint", args: [seriesId, amount, user.address] }) },
    ];
    const sign = (calls: Call[], nonce: bigint) => key.signTypedData(sessionExecuteTypedData(31_337, user.address, calls, key.address, nonce, deadline));
    const oldSignature = await sign(mintCalls(5_000_000n), 0n);
    const oldTrade = { account: user.address, calls: mintCalls(5_000_000n), sessionKey: key.address, deadline, signature: oldSignature };
    expect((await post("/v1/session/execute", oldTrade)).status).toBe(200);

    // 2. The upgrade: one EIP-7702 authorization to the current PasskeyAccount and the account key's
    //    Upgrade signature over the new session, which keeps the same key.
    const session: SessionConfig = { key: key.address, validUntil: now + 86_400, dailyLimit: 40_000_000n, permissions: tradingPermissions(d) };
    const upgradeSig = await user.signTypedData(upgradeTypedData(31_337, user.address, [session], deadline));
    const nonce = await pub.getTransactionCount({ address: user.address });
    const toV2 = await user.signAuthorization({ contractAddress: d.passkeyAccount, chainId: 31_337, nonce });
    const authorization = { address: toV2.address, chainId: toV2.chainId, nonce: toV2.nonce, r: toV2.r, s: toV2.s, yParity: toV2.yParity };
    const upgrade = { account: user.address, authorization, sessions: [session], deadline, eoaSignature: upgradeSig };
    // Only to the current implementation.
    const toOld = await user.signAuthorization({ contractAddress: v1, chainId: 31_337, nonce });
    expect((await post("/v1/accounts/upgrade", { ...upgrade, authorization: { ...authorization, address: v1, r: toOld.r, s: toOld.s, yParity: toOld.yParity } })).body.error).toBe("wrong_delegate");
    const upgraded = await post("/v1/accounts/upgrade", upgrade);
    expect(upgraded.status).toBe(200);
    expect(await (await app.request(`/v1/accounts/${user.address}`)).json()).toEqual({ delegatedTo: d.passkeyAccount.toLowerCase(), active: true, version: 2 });
    expect((await post("/v1/accounts/upgrade", upgrade)).body.error).toBe("already_upgraded");

    // Same owner, same nonces; the version 1 batch cannot replay.
    const [x, y] = (await pub.readContract({ address: user.address, abi: passkeyAccountAbi, functionName: "owner" })) as readonly [Hex, Hex];
    expect([x, y]).toEqual([passkey.publicKey.x, passkey.publicKey.y]);
    expect(await pub.readContract({ address: user.address, abi: passkeyAccountAbi, functionName: "accountVersion" })).toBe(2);
    const s = await pub.readContract({ address: user.address, abi: passkeyAccountAbi, functionName: "sessionOf", args: [key.address] });
    expect(s.active).toBe(true);
    expect(s.nonce).toBe(1n);
    expect((await post("/v1/session/execute", oldTrade)).body.message).toBe("BadSignature()");

    // 3. Trading on version 2: 5 AUSD of version 1's spend today stands, so 35 is left of 40.
    const sessionExecute = async (calls: Call[]) => {
      const n = (await pub.readContract({ address: user.address, abi: passkeyAccountAbi, functionName: "sessionOf", args: [key.address] })).nonce;
      return post("/v1/session/execute", { account: user.address, calls, sessionKey: key.address, deadline, signature: await sign(calls, n) });
    };
    expect((await sessionExecute(mintCalls(10_000_000n))).status).toBe(200);
    // Redeeming sets does not pay for more spending: 10 in, 30 out, 25 left.
    const recycle: Call[] = [
      { target: d.outcomeMarkets, value: 0n, data: encodeFunctionData({ abi: outcomeMarketsAbi, functionName: "redeemSets", args: [seriesId, 10_000_000n, user.address] }) },
      ...mintCalls(30_000_000n),
    ];
    const refusedGross = await sessionExecute(recycle);
    expect(refusedGross.status).toBe(422);
    expect(refusedGross.body.message).toBe("SpendLimitExceeded(30000000, 25000000)");

    // Perpl: a deposit counts against the limit; orders pass only immediate and within 2% of the mark.
    await pub.waitForTransactionReceipt({
      hash: await deployer.writeContract({ address: perpl, abi: mockPerplAbi, functionName: "setMark", args: [16n, MARK, BigInt((await pub.getBlock()).timestamp)] }),
    });
    const deposit: Call[] = [
      { target: d.ausd, value: 0n, data: encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [perpl, 10_000_000n] }) },
      { target: perpl, value: 0n, data: encodeFunctionData({ abi: mockPerplAbi, functionName: "depositCollateral", args: [10_000_000n] }) },
    ];
    expect((await sessionExecute(deposit)).status).toBe(200);
    const order = (price: bigint, immediate = true): OrderDesc => ({
      orderDescId: 1n, perpId: 16n, orderType: 0, orderId: 0n, pricePNS: price, lotLNS: 1n, expiryBlock: 0n, postOnly: false, fillOrKill: false,
      immediateOrCancel: immediate, maxMatches: 0n, leverageHdths: 500n, lastExecutionBlock: 0n, amountCNS: 0n, maxNegPnlCollatBPS: 1000n,
    });
    const orderCall = (o: OrderDesc): Call[] => [{ target: perpl, value: 0n, data: encodeExecOrder(o) }];
    expect((await sessionExecute(orderCall(order((MARK * 10_050n) / 10_000n)))).status).toBe(200);
    const thief = await sessionExecute(orderCall(order((MARK * 10_500n) / 10_000n)));
    expect(thief.status).toBe(422);
    expect(thief.body.message).toBe(`GuardRejected(0, PriceOutsideBand(0, ${(MARK * 10_500n) / 10_000n}, ${MARK}))`);
    const resting = await sessionExecute(orderCall(order(MARK, false)));
    expect(resting.body.message).toBe("GuardRejected(0, MustBeImmediate(0))");
    // Openings at up to 10x; closes at any leverage.
    const levered = (leverageHdths: bigint, orderType = 0): OrderDesc => ({ ...order(MARK), orderType, leverageHdths });
    const at20x = await sessionExecute(orderCall(levered(2000n)));
    expect(at20x.status).toBe(422);
    expect(at20x.body.message).toBe("GuardRejected(0, LeverageNotAllowed(0, 2000, 1000))");
    expect((await sessionExecute(orderCall(levered(1000n)))).status).toBe(200);
    expect((await sessionExecute(orderCall(levered(0n, 2)))).status).toBe(200);
    expect(await pub.readContract({ address: perpl, abi: mockPerplAbi, functionName: "executedCount" })).toBe(3n);

    // 4. The passkey still owns the account.
    const withdraw: Call[] = [{ target: d.ausd, value: 0n, data: encodeFunctionData({ abi: erc20Abi, functionName: "transfer", args: [deployer.account.address, 1_000_000n] }) }];
    const ownerNonce = (await pub.readContract({ address: user.address, abi: passkeyAccountAbi, functionName: "ownerNonce" })) as bigint;
    const owner = await post("/v1/owner/execute", {
      account: user.address,
      calls: withdraw,
      deadline,
      auth: await passkey.assert(ownerExecuteDigest(31_337, user.address, withdraw, ownerNonce, deadline)),
    });
    expect(owner.status).toBe(200);

    // A grant naming a replaced guard (no 10x cap) is not sponsored, before the passkey is checked.
    const staleGrant: Call[] = [
      {
        target: user.address,
        value: 0n,
        data: encodeFunctionData({
          abi: passkeyAccountAbi,
          functionName: "addSession",
          args: [{ key: privateKeyToAccount(generatePrivateKey()).address, validUntil: Number(deadline), dailyLimit: 1n, permissions: perplPermissions(perpl, staleGuard) }],
        }),
      },
    ];
    const refusedGrant = await post("/v1/owner/execute", {
      account: user.address,
      calls: staleGrant,
      deadline,
      auth: await passkey.assert(ownerExecuteDigest(31_337, user.address, staleGrant, ownerNonce + 1n, deadline)),
    });
    expect(refusedGrant.status).toBe(403);
    expect(refusedGrant.body.message).toBe("call 0: session Perpl orders must go through the current order guard");
  }, 120_000);

  test("accounts that are not active are refused", async () => {
    const stranger = privateKeyToAccount(generatePrivateKey());
    const res = await app.request("/v1/session/execute", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: toJson({
        account: stranger.address,
        calls: [{ target: d.ausd, value: 0n, data: encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [d.outcomeMarkets, 1n] }) }],
        sessionKey: stranger.address,
        deadline: BigInt(Number((await pub.getBlock()).timestamp) + 600),
        signature: "0x",
      }),
    });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toBe("not_active");
  });
});
