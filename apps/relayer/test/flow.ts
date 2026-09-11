/**
 * The account flow the app performs, driven through the relayer's HTTP API: activation through an
 * EIP-7702 delegation, session trading, and a passkey-signed owner batch, with the attacks that
 * must fail. Shared by the Anvil and Monad Testnet end-to-end tests.
 */
import { expect } from "bun:test";
import {
  base64url,
  type Call,
  challengeFor,
  type Deployment,
  initializeTypedData,
  outcomeMarketsAbi,
  outcomeTokenAbi,
  ownerExecuteDigest,
  p256PublicKey,
  passkeyAccountAbi,
  type SessionConfig,
  sessionExecuteTypedData,
  spotBuyCalls,
  spotSellCalls,
  toWebAuthnAuth,
  tradingPermissions,
} from "@trendr/contracts";
import {
  closeMarketOrder,
  exchangeAbi,
  openAccountCalls,
  openMarketOrder,
  type PerplMarket,
  type PerplTicker,
  tradeCall,
  withdrawCall,
  worstPrice,
} from "@trendr/perpl";
import { type Address, encodeFunctionData, erc20Abi, type Hex, hashTypedData, type PublicClient } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import type { buildServer } from "../src/server";

/** A software passkey: a P256 key that answers like a WebAuthn authenticator. */
export async function softPasskey(rpId = "app.trendr.test") {
  const pair = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"])) as CryptoKeyPair;
  const spki = new Uint8Array(await crypto.subtle.exportKey("spki", pair.publicKey));
  const enc = new TextEncoder();
  const sha256 = async (b: Uint8Array) => new Uint8Array(await crypto.subtle.digest("SHA-256", Uint8Array.from(b)));
  return {
    publicKey: p256PublicKey(spki),
    async assert(digest: Hex) {
      const clientDataJSON = enc.encode(
        JSON.stringify({ type: "webauthn.get", challenge: base64url(challengeFor(digest)), origin: `https://${rpId}`, crossOrigin: false }),
      );
      // rpIdHash | flags (user present, user verified) | sign count
      const authenticatorData = new Uint8Array([...(await sha256(enc.encode(rpId))), 0x05, 0, 0, 0, 1]);
      const signed = new Uint8Array([...authenticatorData, ...(await sha256(clientDataJSON))]);
      const signature = new Uint8Array(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, pair.privateKey, Uint8Array.from(signed)));
      return toWebAuthnAuth({ authenticatorData, clientDataJSON, signature });
    },
  };
}

export const toJson = (value: unknown) => JSON.stringify(value, (_k, v) => (typeof v === "bigint" ? v.toString() : v));

export interface FlowContext {
  app: ReturnType<typeof buildServer>;
  pub: PublicClient;
  chainId: number;
  d: Deployment;
  seriesId: Hex;
  /** Gives the new account `amount` AUSD (raw units). */
  fund(account: Address, amount: bigint): Promise<void>;
  /** Seconds since epoch as the chain sees it. */
  now(): Promise<number>;
  /** An address that must never receive the account's assets. */
  thief: Address;
  /** A listed token to trade on Kuru through TrendrSpot, with the least each trade may return. */
  spot?: {
    token: Address;
    minOutForBuy(ausdIn: bigint): Promise<bigint>;
    minOutForSell(amountIn: bigint): Promise<bigint>;
  };
  /** A Perpl market to open an account on and trade from the session. */
  perpl?: {
    market: PerplMarket;
    ticker(): Promise<PerplTicker>;
    /** AUSD (raw) to open the Perpl account with. */
    openWith: bigint;
  };
  log?: (line: string) => void;
}

export async function runAccountFlow(ctx: FlowContext) {
  const { app, pub, chainId, d, seriesId } = ctx;
  const log = ctx.log ?? (() => {});
  const post = async (path: string, body: unknown) => {
    const res = await app.request(path, { method: "POST", headers: { "content-type": "application/json" }, body: toJson(body) });
    return { status: res.status, body: (await res.json()) as Record<string, string> };
  };

  const user = privateKeyToAccount(generatePrivateKey());
  const sessionAccount = privateKeyToAccount(generatePrivateKey());
  const passkey = await softPasskey();
  const now = await ctx.now();
  await ctx.fund(user.address, 50_000_000n + (ctx.perpl?.openWith ?? 0n));
  expect(await pub.getBalance({ address: user.address })).toBe(0n);
  log(`account ${user.address}`);

  // 1. Activation: one EIP-7702 authorization plus the EIP-712 Initialize signature.
  const session: SessionConfig = {
    key: sessionAccount.address,
    validUntil: now + 86_400,
    dailyLimit: 40_000_000n,
    permissions: tradingPermissions(d),
  };
  const deadline = BigInt(now + 600);
  const nonce = await pub.getTransactionCount({ address: user.address });
  const authorization = await user.signAuthorization({ contractAddress: d.passkeyAccount, chainId, nonce });
  const eoaSignature = await user.signTypedData(initializeTypedData(chainId, user.address, passkey.publicKey, session, deadline));
  const activation = {
    account: user.address,
    authorization: {
      address: authorization.address,
      chainId: authorization.chainId,
      nonce: authorization.nonce,
      r: authorization.r,
      s: authorization.s,
      yParity: authorization.yParity,
    },
    owner: passkey.publicKey,
    session,
    deadline,
    eoaSignature,
  };
  const activated = await post("/v1/accounts/activate", activation);
  if (activated.status !== 200) log(`activation refused: ${JSON.stringify(activated.body)}`);
  expect(activated.status).toBe(200);
  log(`activate ${activated.body.hash} gas ${activated.body.gasUsed}/${activated.body.gasLimit}`);
  expect(await pub.getCode({ address: user.address })).toBe(`0xef0100${d.passkeyAccount.slice(2).toLowerCase()}`);
  const status = await app.request(`/v1/accounts/${user.address}`);
  expect(await status.json()).toEqual({ delegatedTo: d.passkeyAccount.toLowerCase(), active: true, version: 2 });
  expect((await post("/v1/accounts/activate", activation)).body.error).toBe("already_active");
  const onchainInit = await pub.readContract({
    address: user.address,
    abi: passkeyAccountAbi,
    functionName: "initializeDigest",
    args: [passkey.publicKey.x, passkey.publicKey.y, session, deadline],
  });
  expect(onchainInit).toBe(hashTypedData(initializeTypedData(chainId, user.address, passkey.publicKey, session, deadline)));

  // 2. A session trade: approve plus mint, signed by the session key, gas paid by the relayer.
  const calls: Call[] = [
    { target: d.ausd, value: 0n, data: encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [d.outcomeMarkets, 10_000_000n] }) },
    {
      target: d.outcomeMarkets,
      value: 0n,
      data: encodeFunctionData({ abi: outcomeMarketsAbi, functionName: "mint", args: [seriesId, 10_000_000n, user.address] }),
    },
  ];
  const signSession = (cs: Call[], n: bigint) =>
    sessionAccount.signTypedData(sessionExecuteTypedData(chainId, user.address, cs, sessionAccount.address, n, deadline));
  const onchainSession = await pub.readContract({
    address: user.address,
    abi: passkeyAccountAbi,
    functionName: "sessionExecuteDigest",
    args: [calls, sessionAccount.address, 0n, deadline],
  });
  expect(onchainSession).toBe(hashTypedData(sessionExecuteTypedData(chainId, user.address, calls, sessionAccount.address, 0n, deadline)));

  const signature = await signSession(calls, 0n);
  const traded = await post("/v1/session/execute", { account: user.address, calls, sessionKey: sessionAccount.address, deadline, signature });
  expect(traded.status).toBe(200);
  log(`session trade ${traded.body.hash} gas ${traded.body.gasUsed}/${traded.body.gasLimit}`);
  const series = (await pub.readContract({ address: d.outcomeMarkets, abi: outcomeMarketsAbi, functionName: "seriesOf", args: [seriesId] })) as {
    up: Address;
  };
  expect(await pub.readContract({ address: series.up, abi: outcomeTokenAbi, functionName: "balanceOf", args: [user.address] })).toBe(10_000_000n);

  // The daily limit counts each call's outflow: redeeming 10 AUSD of sets does not pay for spending
  // 35 when only 30 of the 40 are left, though the batch's net outflow (25) would fit.
  const recycle: Call[] = [
    { target: d.outcomeMarkets, value: 0n, data: encodeFunctionData({ abi: outcomeMarketsAbi, functionName: "redeemSets", args: [seriesId, 10_000_000n, user.address] }) },
    { target: d.ausd, value: 0n, data: encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [d.outcomeMarkets, 35_000_000n] }) },
    { target: d.outcomeMarkets, value: 0n, data: encodeFunctionData({ abi: outcomeMarketsAbi, functionName: "mint", args: [seriesId, 35_000_000n, user.address] }) },
  ];
  const overGross = await post("/v1/session/execute", {
    account: user.address,
    calls: recycle,
    sessionKey: sessionAccount.address,
    deadline,
    signature: await signSession(recycle, 1n),
  });
  expect(overGross.status).toBe(422);
  expect(overGross.body.message).toBe("SpendLimitExceeded(35000000, 30000000)");
  log(`gross limit: ${overGross.body.message}`);

  // Replaying the same signed batch is rejected before any gas is spent.
  expect((await post("/v1/session/execute", { account: user.address, calls, sessionKey: sessionAccount.address, deadline, signature })).status).toBe(422);

  // A session cannot mint to someone else, even with a valid signature.
  const elsewhere: Call[] = [
    calls[0]!,
    { ...calls[1]!, data: encodeFunctionData({ abi: outcomeMarketsAbi, functionName: "mint", args: [seriesId, 10_000_000n, ctx.thief] }) },
  ];
  const stolen = await post("/v1/session/execute", {
    account: user.address,
    calls: elsewhere,
    sessionKey: sessionAccount.address,
    deadline,
    signature: await signSession(elsewhere, 1n),
  });
  expect(stolen.status).toBe(422);
  expect(stolen.body.message).toBe("CallNotAllowed(1)");

  // Calls outside the relayer allowlist are refused outright.
  const transfer: Call[] = [{ target: d.ausd, value: 0n, data: encodeFunctionData({ abi: erc20Abi, functionName: "transfer", args: [ctx.thief, 1n] }) }];
  const refused = await post("/v1/session/execute", {
    account: user.address,
    calls: transfer,
    sessionKey: sessionAccount.address,
    deadline,
    signature: await signSession(transfer, 1n),
  });
  expect(refused.status).toBe(403);

  // Approving a token the protocol did not make is refused before any gas is spent, even to a
  // protocol contract: its approve could burn the whole gas limit and still succeed.
  const foreign: Call[] = [
    { target: ctx.thief, value: 0n, data: encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [d.trendrSpot, 1n] }) },
  ];
  const foreignApproval = await post("/v1/session/execute", {
    account: user.address,
    calls: foreign,
    sessionKey: sessionAccount.address,
    deadline,
    signature: await signSession(foreign, 1n),
  });
  expect(foreignApproval.status).toBe(403);
  expect(foreignApproval.body.message).toBe("call 0: approvals are limited to AUSD and Trendr tokens");

  let ownerNonce = 0n;
  const ownerExecute = async (calls: Call[]) => {
    const digest = ownerExecuteDigest(chainId, user.address, calls, ownerNonce, deadline);
    const res = await post("/v1/owner/execute", { account: user.address, calls, deadline, auth: await passkey.assert(digest) });
    if (res.status === 200) ownerNonce++;
    return res;
  };
  let sessionNonce = 1n;
  const sessionExecute = async (calls: Call[]) => {
    const res = await post("/v1/session/execute", {
      account: user.address,
      calls,
      sessionKey: sessionAccount.address,
      deadline,
      signature: await signSession(calls, sessionNonce),
    });
    if (res.status === 200) sessionNonce++;
    return res;
  };

  // 2b. Gas-free spot trades on Kuru from the session, through TrendrSpot: buy, then sell half.
  let spotHashes: string[] = [];
  if (ctx.spot) {
    const { token } = ctx.spot;
    const tokenBalance = () => pub.readContract({ address: token, abi: erc20Abi, functionName: "balanceOf", args: [user.address] });
    const before = await tokenBalance();
    const buy = spotBuyCalls(d, token, 5_000_000n, await ctx.spot.minOutForBuy(5_000_000n), user.address);
    const bought = await sessionExecute(buy);
    expect(bought.status).toBe(200);
    const got = (await tokenBalance()) - before;
    expect(got).toBeGreaterThan(0n);
    log(`spot buy ${bought.body.hash}: 5 AUSD for ${got} raw tokens`);

    const half = got / 2n;
    const ausdBefore = await pub.readContract({ address: d.ausd, abi: erc20Abi, functionName: "balanceOf", args: [user.address] });
    const sell = spotSellCalls(d, token, half, await ctx.spot.minOutForSell(half), user.address);
    const sold = await sessionExecute(sell);
    expect(sold.status).toBe(200);
    const proceeds = (await pub.readContract({ address: d.ausd, abi: erc20Abi, functionName: "balanceOf", args: [user.address] })) - ausdBefore;
    expect(proceeds).toBeGreaterThan(0n);
    log(`spot sell ${sold.body.hash}: ${half} raw tokens for ${proceeds} raw AUSD`);
    spotHashes = [bought.body.hash!, sold.body.hash!];

    // A session cannot send the proceeds of a spot trade anywhere but the account.
    const diverted = spotBuyCalls(d, token, 1_000_000n, 1n, ctx.thief);
    const refusedSpot = await sessionExecute(diverted);
    expect(refusedSpot.status).toBe(422);
    expect(refusedSpot.body.message).toContain("CallNotAllowed");
  }

  // 2c. Perpl: one passkey batch opens the Perpl account and turns on order forwarding; the session
  // goes long and closes, gas-free; one passkey batch withdraws everything back.
  let perplHashes: string[] = [];
  if (ctx.perpl && d.perplExchange) {
    const { market } = ctx.perpl;
    const exchange = d.perplExchange;
    const opened = await ownerExecute(openAccountCalls(exchange, d.ausd, ctx.perpl.openWith, true));
    expect(opened.status).toBe(200);
    const perplAccount = await pub.readContract({ address: exchange, abi: exchangeAbi, functionName: "getAccountByAddr", args: [user.address] });
    expect(perplAccount.balanceCNS).toBe(ctx.perpl.openWith);
    log(`perpl account ${perplAccount.accountId} opened ${opened.body.hash}`);

    const size = 1 / 10 ** market.sizeDecimals > 0.001 ? 1 / 10 ** market.sizeDecimals : 0.001;
    const t = await ctx.perpl.ticker();
    const open = openMarketOrder({ market, requestId: 1n, side: "long", size, worstPrice: worstPrice("long", t.ask, 100), leverage: 2 });
    const long = await sessionExecute([tradeCall(exchange, open)]);
    expect(long.status).toBe(200);
    const [position] = await pub.readContract({ address: exchange, abi: exchangeAbi, functionName: "getPosition", args: [BigInt(market.id), perplAccount.accountId] });
    expect(position.lotLNS).toBeGreaterThan(0n);
    log(`perpl long ${long.body.hash}: ${position.lotLNS} lots at ${position.pricePNS}`);

    const t2 = await ctx.perpl.ticker();
    const close = closeMarketOrder({ market, requestId: 2n, side: "long", size, worstPrice: worstPrice("short", t2.bid, 100) });
    const closed = await sessionExecute([tradeCall(exchange, close)]);
    expect(closed.status).toBe(200);
    const [after] = await pub.readContract({ address: exchange, abi: exchangeAbi, functionName: "getPosition", args: [BigInt(market.id), perplAccount.accountId] });
    expect(after.lotLNS).toBe(0n);

    const free = (await pub.readContract({ address: exchange, abi: exchangeAbi, functionName: "getAccountById", args: [perplAccount.accountId] })).balanceCNS;
    const ausdBefore = await pub.readContract({ address: d.ausd, abi: erc20Abi, functionName: "balanceOf", args: [user.address] });
    const withdrawn = await ownerExecute([withdrawCall(exchange, free)]);
    expect(withdrawn.status).toBe(200);
    const returned = (await pub.readContract({ address: d.ausd, abi: erc20Abi, functionName: "balanceOf", args: [user.address] })) - ausdBefore;
    expect(returned).toBe(free);
    log(`perpl close ${closed.body.hash}, withdrew ${Number(free) / 1e6} AUSD ${withdrawn.body.hash}`);
    perplHashes = [opened.body.hash!, long.body.hash!, closed.body.hash!, withdrawn.body.hash!];
  }

  // 3. The owner withdraws with a passkey assertion over the OwnerExecute digest.
  const recipient = privateKeyToAccount(generatePrivateKey()).address;
  const withdraw: Call[] = [
    { target: d.ausd, value: 0n, data: encodeFunctionData({ abi: erc20Abi, functionName: "transfer", args: [recipient, 5_000_000n] }) },
  ];
  const digest = ownerExecuteDigest(chainId, user.address, withdraw, ownerNonce, deadline);
  expect(await pub.readContract({ address: user.address, abi: passkeyAccountAbi, functionName: "ownerExecuteDigest", args: [withdraw, ownerNonce, deadline] })).toBe(
    digest,
  );
  const owner = await post("/v1/owner/execute", { account: user.address, calls: withdraw, deadline, auth: await passkey.assert(digest) });
  expect(owner.status).toBe(200);
  log(`owner withdrawal ${owner.body.hash} gas ${owner.body.gasUsed}/${owner.body.gasLimit}`);
  expect(await pub.readContract({ address: d.ausd, abi: erc20Abi, functionName: "balanceOf", args: [recipient] })).toBe(5_000_000n);

  // The owner moves AUSD and Trendr tokens only: another contract's transfer could burn the gas.
  const foreignTransfer: Call[] = [
    { target: ctx.thief, value: 0n, data: encodeFunctionData({ abi: erc20Abi, functionName: "transfer", args: [recipient, 1n] }) },
  ];
  const refusedTransfer = await post("/v1/owner/execute", {
    account: user.address,
    calls: foreignTransfer,
    deadline,
    auth: await passkey.assert(ownerExecuteDigest(chainId, user.address, foreignTransfer, ownerNonce, deadline)),
  });
  expect(refusedTransfer.status).toBe(403);
  expect(refusedTransfer.body.message).toBe("call 0: transfers are limited to AUSD and Trendr tokens");

  // A different passkey cannot act as owner.
  const impostor = await softPasskey();
  const forged = await post("/v1/owner/execute", {
    account: user.address,
    calls: withdraw,
    deadline,
    auth: await impostor.assert(ownerExecuteDigest(chainId, user.address, withdraw, ownerNonce + 1n, deadline)),
  });
  expect(forged.status).toBe(422);
  expect(forged.body.message).toBe("BadSignature()");

  // The account never held MON.
  expect(await pub.getBalance({ address: user.address })).toBe(0n);
  return {
    account: user.address,
    hashes: { activate: activated.body.hash, trade: traded.body.hash, spot: spotHashes, perpl: perplHashes, withdraw: owner.body.hash },
  };
}
