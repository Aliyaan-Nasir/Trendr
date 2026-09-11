/**
 * The Aurora deposit conversion end to end on a fork of Monad Mainnet (Anvil with --network monad:
 * Monad gas, EIP-7702 and the P256 precompile), against the real USDC, AUSD and stable pool: a
 * Trendr account holding USDC converts it to AUSD in one passkey batch relayed through the real
 * relayer policy and service, and every variation the policy must refuse is refused before gas.
 * Run with RELAYER_MAINNET_FORK=1 (needs anvil and forge); MONAD_MAINNET_RPC_URL picks the RPC to
 * fork (default: the public one) and MAINNET_FORK_BLOCK pins a block. Nothing touches Mainnet
 * itself: the fork is local, and the deploy is a plain `forge create` that writes no files.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import {
  type Call,
  conversionMinOut,
  type Deployment,
  deployments,
  encodeInitialize,
  initializeTypedData,
  ownerExecuteDigest,
  passkeyAccountAbi,
  type SessionConfig,
  stableSwapAbi,
  tradingPermissions,
  trendrErrorAbis,
  usdcConversion,
  usdcToAusdCalls,
} from "@trendr/contracts";
import { monadChain, ViemChainClient } from "@trendr/chain";
import pino from "pino";
import { type Address, createPublicClient, createTestClient, createWalletClient, encodeFunctionData, erc20Abi, http, parseEther } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { buildServer } from "../src/server";
import { RelayerService } from "../src/service";
import { softPasskey, toJson } from "./flow";

const enabled = process.env.RELAYER_MAINNET_FORK === "1";
const contractsDir = join(import.meta.dir, "..", "..", "..", "contracts");
const port = 9600 + Math.floor(Math.random() * 300);
const rpc = `http://127.0.0.1:${port}`;
const chain = monadChain(143, rpc);
const pub = createPublicClient({ chain, transport: http(rpc) });
const anvilRpc = createTestClient({ chain, mode: "anvil", transport: http(rpc) });
const conversion = usdcConversion(143)!;
/** Kuru's MarginAccount holds about 555k USDC on Mainnet; the fork lends some of it to the account. */
const USDC_HOLDER = "0x2A68ba1833cDf93fa9Da1EEbd7F46242aD8E90c5" as const;
const AMOUNT = 25_000_000n;

// Anvil's well-known keys carry EIP-7702 delegations on Monad Mainnet, so every key here is fresh.
const deployerKey = generatePrivateKey();
const relayerKey = generatePrivateKey();
const user = privateKeyToAccount(generatePrivateKey());
const thief = privateKeyToAccount(generatePrivateKey()).address;

let anvil: ReturnType<typeof Bun.spawn> | undefined;
let app: ReturnType<typeof buildServer>;
let passkey: Awaited<ReturnType<typeof softPasskey>>;
let ownerNonce = 0n;

const balance = (token: Address, who: Address) => pub.readContract({ address: token, abi: erc20Abi, functionName: "balanceOf", args: [who] });
const now = async () => Number((await pub.getBlock()).timestamp);

async function post(path: string, body: unknown) {
  const res = await app.request(path, { method: "POST", headers: { "content-type": "application/json" }, body: toJson(body) });
  return { status: res.status, body: (await res.json()) as Record<string, string> };
}

/** One passkey-signed owner batch through the relayer's HTTP API. */
async function ownerExecute(calls: Call[]) {
  const deadline = BigInt((await now()) + 600);
  const auth = await passkey.assert(ownerExecuteDigest(143, user.address, calls, ownerNonce, deadline));
  const res = await post("/v1/owner/execute", { account: user.address, calls, deadline, auth });
  if (res.status === 200) ownerNonce++;
  return res;
}

async function waitForRpc() {
  for (let i = 0; i < 200; i++) {
    try {
      if ((await pub.getChainId()) === 143) return;
    } catch {
      await Bun.sleep(150);
    }
  }
  throw new Error("anvil did not start");
}

describe.skipIf(!enabled)("Aurora USDC to AUSD conversion on a Mainnet fork", () => {
  beforeAll(async () => {
    const forkUrl = process.env.MONAD_MAINNET_RPC_URL || "https://rpc.monad.xyz";
    const pin = process.env.MAINNET_FORK_BLOCK ? ["--fork-block-number", process.env.MAINNET_FORK_BLOCK] : [];
    anvil = Bun.spawn(["anvil", "--fork-url", forkUrl, ...pin, "--network", "monad", "--port", String(port), "--silent"], { stdout: "ignore", stderr: "ignore" });
    await waitForRpc();
    const deployer = privateKeyToAccount(deployerKey).address;
    const relayer = privateKeyToAccount(relayerKey).address;
    for (const a of [deployer, relayer, USDC_HOLDER]) await anvilRpc.setBalance({ address: a, value: parseEther("1000") });

    // The real PasskeyAccount, against Mainnet AUSD.
    const created = Bun.spawnSync(
      ["forge", "create", "src/account/PasskeyAccount.sol:PasskeyAccount", "--rpc-url", rpc, "--private-key", deployerKey, "--broadcast", "--json", "--constructor-args", conversion.ausd],
      { cwd: contractsDir },
    );
    if (created.exitCode !== 0) throw new Error(`forge create failed: ${created.stderr.toString()}`);
    const passkeyAccount = (JSON.parse(created.stdout.toString()) as { deployedTo: Address }).deployedTo;
    const d: Deployment = { ...deployments[10143]!, chainId: 143, startBlock: Number(await pub.getBlockNumber()), ausd: conversion.ausd, passkeyAccount };

    // Activation as the relayer sends it: the 7702 authorization plus initialize, from a gas payer.
    passkey = await softPasskey();
    const t = await now();
    const session: SessionConfig = { key: privateKeyToAccount(generatePrivateKey()).address, validUntil: t + 86_400, dailyLimit: 10_000_000n, permissions: tradingPermissions(d) };
    const deadline = BigInt(t + 600);
    const authorization = await user.signAuthorization({ contractAddress: passkeyAccount, chainId: 143, nonce: 0 });
    const eoaSignature = await user.signTypedData(initializeTypedData(143, user.address, passkey.publicKey, session, deadline));
    const payer = createWalletClient({ chain, transport: http(rpc), account: privateKeyToAccount(relayerKey) });
    const activation = await payer.sendTransaction({
      to: user.address,
      data: encodeInitialize(passkey.publicKey, session, deadline, eoaSignature),
      authorizationList: [authorization],
      gas: 1_500_000n,
    });
    expect((await pub.waitForTransactionReceipt({ hash: activation })).status).toBe("success");
    expect(await pub.readContract({ address: user.address, abi: passkeyAccountAbi, functionName: "isInitialized" })).toBe(true);

    // An Aurora deposit lands: USDC in the account.
    await anvilRpc.impersonateAccount({ address: USDC_HOLDER });
    const holder = createWalletClient({ chain, transport: http(rpc), account: USDC_HOLDER });
    const funded = await holder.writeContract({ address: conversion.usdc, abi: erc20Abi, functionName: "transfer", args: [user.address, AMOUNT] });
    await pub.waitForTransactionReceipt({ hash: funded });
    await anvilRpc.stopImpersonatingAccount({ address: USDC_HOLDER });

    const service = new RelayerService(
      new ViemChainClient(rpc, 143, [relayerKey], undefined, trendrErrorAbis),
      { deployment: d, maxSessionDailyLimit: 250_000_000n, maxSessionLifetime: 7 * 86_400 },
      () => Math.floor(Date.now() / 1000),
    );
    app = buildServer({ service, allowedOrigins: ["https://app.trendr.test"], log: pino({ level: "silent" }) });
  }, 180_000);

  afterAll(() => {
    anvil?.kill();
  });

  test("the policy refuses every variation of the conversion before any gas", async () => {
    const before = await pub.getTransactionCount({ address: privateKeyToAccount(relayerKey).address });
    const quote = await pub.readContract({ address: conversion.pool, abi: stableSwapAbi, functionName: "get_dy", args: [1n, 0n, AMOUNT] });
    const minOut = conversionMinOut(AMOUNT, quote)!;
    const [approve, exchange] = usdcToAusdCalls(conversion, user.address, AMOUNT, minOut);
    const elsewhere = usdcToAusdCalls(conversion, thief, AMOUNT, minOut)[1]!;
    const backwards: Call = {
      target: conversion.pool,
      value: 0n,
      data: encodeFunctionData({ abi: stableSwapAbi, functionName: "exchange", args: [0n, 1n, AMOUNT, 1n, user.address] }),
    };
    const steal: Call = { target: conversion.usdc, value: 0n, data: encodeFunctionData({ abi: erc20Abi, functionName: "transfer", args: [thief, AMOUNT] }) };
    const approveThief: Call = { target: conversion.usdc, value: 0n, data: encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [thief, AMOUNT] }) };
    for (const [calls, message] of [
      [[approve!, elsewhere], "call 1: a conversion pays the account itself"],
      [[backwards], "call 0: the conversion pool only exchanges USDC for AUSD"],
      [[steal], "call 0: USDC calls are limited to approving the conversion pool"],
      [[approveThief], "call 0: USDC calls are limited to approving the conversion pool"],
    ] as const) {
      const res = await ownerExecute([...calls]);
      expect(res.status).toBe(403);
      expect(res.body.message).toBe(message);
    }
    // A session can never convert, whatever it signs.
    const session = await post("/v1/session/execute", { account: user.address, calls: [approve, exchange], sessionKey: thief, deadline: BigInt((await now()) + 600), signature: "0x" });
    expect(session.status).toBe(403);
    expect(await pub.getTransactionCount({ address: privateKeyToAccount(relayerKey).address })).toBe(before);
    expect(await balance(conversion.usdc, user.address)).toBe(AMOUNT);
  });

  test("the account converts its USDC to AUSD in one relayed passkey batch", async () => {
    const quote = await pub.readContract({ address: conversion.pool, abi: stableSwapAbi, functionName: "get_dy", args: [1n, 0n, AMOUNT] });
    const minOut = conversionMinOut(AMOUNT, quote);
    expect(minOut).not.toBeNull();
    const calls = usdcToAusdCalls(conversion, user.address, AMOUNT, minOut!);
    const ausdBefore = await balance(conversion.ausd, user.address);

    const res = await ownerExecute(calls);
    expect(res.status).toBe(200);
    const received = (await balance(conversion.ausd, user.address)) - ausdBefore;
    console.log(`converted ${Number(AMOUNT) / 1e6} USDC to ${Number(received) / 1e6} AUSD (quote ${Number(quote) / 1e6}); gas ${res.body.gasUsed} of limit ${res.body.gasLimit}`);
    expect(received).toBeGreaterThanOrEqual(minOut!);
    expect(await balance(conversion.usdc, user.address)).toBe(0n);
    expect(await pub.readContract({ address: conversion.usdc, abi: erc20Abi, functionName: "allowance", args: [user.address, conversion.pool] })).toBe(0n);
    // The account never needed MON.
    expect(await pub.getBalance({ address: user.address })).toBe(0n);
  }, 60_000);
});
