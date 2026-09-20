/**
 * Live on Monad Testnet, against the running backend (:4000), relayer (:4100) and executor (:4400):
 * a new passkey account grants Autopilot a Perpl-only session key and follows the Trendr bot; the
 * bot trades ETH on Perpl; the executor copies the open and the close into the account, gas-free.
 *
 *   AUTOPILOT_LIVE=1 bun test test/live.testnet.test.ts
 *
 * Needs DEPLOYER_PRIVATE_KEY (funds the account with test AUSD) and the bot's key in the env.
 */
import { describe, expect, test } from "bun:test";
import { seal } from "@trendr/autopilot";
import { deployments, initializeTypedData, type OwnerChallenge, ownerApprovalDigest, ownerExecuteDigest, ownerRequests, passkeyAccountAbi, type SessionConfig, tradingPermissions } from "@trendr/contracts";
import { closeMarketOrder, encodeExecOrder, fetchContext, openMarketOrder, perplNetwork, worstPrice } from "@trendr/perpl";
import { type Address, createPublicClient, createWalletClient, encodeFunctionData, erc20Abi, getAddress, http } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { monadTestnet } from "viem/chains";
import { softPasskey, toJson } from "../../relayer/test/flow";
import { PerplChain } from "../src/perpl-chain";

const live = process.env.AUTOPILOT_LIVE === "1";
const BACKEND = process.env.BACKEND_URL ?? "http://localhost:4000";
const RELAYER = process.env.RELAYER_URL ?? "http://localhost:4100";
const d = deployments[10143]!;
const n = perplNetwork(10143);
const rpc = process.env.RPC_URLS?.split(",")[0] ?? "https://testnet-rpc.monad.xyz";
const pub = createPublicClient({ chain: monadTestnet, transport: http(rpc) });
const chain = new PerplChain(pub as never, n.exchange);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function post(url: string, body: unknown, token?: string) {
  const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: toJson(body) });
  const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) throw new Error(`${url}: ${res.status} ${JSON.stringify(json)}`);
  return json;
}

async function until<T>(what: string, fn: () => Promise<T | null | undefined | false>, timeoutMs = 120_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const v = await fn();
    if (v) return v as T;
    await sleep(3000);
  }
  throw new Error(`timed out waiting for ${what}`);
}

describe.skipIf(!live)("Autopilot copy-trading on Monad Testnet", () => {
  test(
    "a passkey account follows the bot and copies its ETH trade through its Autopilot session",
    async () => {
      const deployer = createWalletClient({ chain: monadTestnet, transport: http(rpc), account: privateKeyToAccount(process.env.DEPLOYER_PRIVATE_KEY as `0x${string}`) });
      const bot = createWalletClient({ chain: monadTestnet, transport: http(rpc), account: privateKeyToAccount(process.env.AUTOPILOT_BOT_PRIVATE_KEY as `0x${string}`) });
      const eth = (await fetchContext(n)).markets.find((m) => m.symbol === "ETH")!;
      const leader = privateKeyToAccount(process.env.AUTOPILOT_BOT_PRIVATE_KEY as `0x${string}`).address;
      const botAccount = (await chain.account(leader))!;
      let rq = BigInt(Math.floor(Date.now() / 1000));

      // 0. The bot starts flat in ETH, so its next trade is an opening.
      const leftover = (await chain.holdings(botAccount.id, [eth])).get("ETH");
      if (leftover) {
        const m0 = (await chain.marks([eth])).get("ETH")!;
        const flat = closeMarketOrder({ market: eth, requestId: rq++, side: leftover.side, size: leftover.size, worstPrice: worstPrice(leftover.side === "long" ? "short" : "long", m0, 200) });
        await pub.waitForTransactionReceipt({ hash: await bot.sendTransaction({ to: n.exchange, data: encodeExecOrder(flat) }) });
        console.log(`closed the bot's leftover ETH ${leftover.side} ${leftover.size}`);
      }

      // 1. A new account: EIP-7702 activation through the relayer, with the app's trading session.
      const user = privateKeyToAccount(generatePrivateKey());
      const appSession = privateKeyToAccount(generatePrivateKey());
      const passkey = await softPasskey();
      const now = Math.floor(Date.now() / 1000);
      const session: SessionConfig = { key: appSession.address, validUntil: now + 86_400, dailyLimit: 50_000_000n, permissions: tradingPermissions(d) };
      const deadline = BigInt(now + 600);
      const authorization = await user.signAuthorization({ contractAddress: d.passkeyAccount, chainId: 10143, nonce: 0 });
      await post(`${RELAYER}/v1/accounts/activate`, {
        account: user.address,
        authorization: { address: authorization.address, chainId: authorization.chainId, nonce: authorization.nonce, r: authorization.r, s: authorization.s, yParity: authorization.yParity },
        owner: passkey.publicKey,
        session,
        deadline,
        eoaSignature: await user.signTypedData(initializeTypedData(10143, user.address, passkey.publicKey, session, deadline)),
      });
      console.log(`account ${user.address}`);
      // Test AUSD for the Perpl account (100 to open it) and margin.
      const fund = await deployer.writeContract({ address: d.ausd, abi: erc20Abi, functionName: "transfer", args: [user.address, 120_000_000n] });
      await pub.waitForTransactionReceipt({ hash: fund });

      // 2. Sign in to the backend with the app's session key: no passkey prompt.
      const issuedAt = Math.floor(Date.now() / 1000);
      const message = `Trendr sign-in\naccount: ${getAddress(user.address)}\nsigner: ${getAddress(appSession.address)}\nissued: ${issuedAt}`;
      const { token } = (await post(`${BACKEND}/v1/auth/session`, { account: user.address, signer: appSession.address, issuedAt, signature: await appSession.signMessage({ message }) })) as { token: string };

      // 3. Grant Autopilot its own Perpl-only session key, made and sealed to the executor here as the
      // app does (the backend only stores the box): one passkey prompt adds it.
      const { publicKey } = (await (await fetch(`${BACKEND}/v1/autopilot/grant/seal-key`)).json()) as { publicKey: string };
      const grantKey = generatePrivateKey();
      const sessionKey = privateKeyToAccount(grantKey).address;
      const sealedKey = await seal(grantKey, publicKey, { owner: user.address.toLowerCase(), sessionKey: sessionKey.toLowerCase() });
      const grant = (await post(`${BACKEND}/v1/autopilot/grant`, { dailyLimit: "120000000", validDays: 1, sessionKey, sealedKey }, token)) as {
        session: { key: Address; validUntil: number; dailyLimit: string; permissions: Array<{ target: Address; selector: `0x${string}`; recipientArg: number; guard: Address }> };
      };
      const add = [
        {
          target: user.address,
          value: 0n,
          data: encodeFunctionData({
            abi: passkeyAccountAbi,
            functionName: "addSession",
            args: [{ key: grant.session.key, validUntil: grant.session.validUntil, dailyLimit: BigInt(grant.session.dailyLimit), permissions: grant.session.permissions }],
          }),
        },
      ];
      const ownerNonce = await pub.readContract({ address: user.address, abi: passkeyAccountAbi, functionName: "ownerNonce" });
      const digest = ownerExecuteDigest(10143, user.address, add, ownerNonce, deadline);
      await post(`${RELAYER}/v1/owner/execute`, { account: user.address, calls: add, deadline, auth: await passkey.assert(digest) });
      const confirmed = (await post(`${BACKEND}/v1/autopilot/grant/confirm`, {}, token)) as { grant: { status: string } };
      expect(confirmed.grant.status).toBe("active");

      // 4. Follow the bot, approved by the passkey: 4 AUSD of margin per copied opening, at most 2x,
      // within 0.5% of the bot's fill.
      const settings = { mode: "fixed", fixedMarginAusd: 4, maxMarginAusd: 8, maxLeverage: 2, maxDailyLossAusd: 10, maxSlippagePct: 0.5, maxOpenLossAusd: 10 };
      const request = ownerRequests.follow(leader, settings);
      const challenge = (await post(`${BACKEND}/v1/owner-approvals`, { action: request.action }, token)) as unknown as OwnerChallenge;
      const approved = await passkey.assert(ownerApprovalDigest({ chainId: 10143, account: user.address, request, nonce: challenge.nonce, expiresAt: challenge.expiresAt }));
      await post(`${BACKEND}/v1/follows`, { leader, settings, approval: { nonce: challenge.nonce, ...approved } }, token);
      // Let the executor record the bot's current holdings before it trades.
      await sleep(35_000);

      // 5. The bot opens 0.01 ETH long at 3x on chain.
      const mark = (await chain.marks([eth])).get("ETH")!;
      const open = openMarketOrder({ market: eth, requestId: rq++, side: "long", size: 0.01, worstPrice: worstPrice("long", mark, 100), leverage: 3 });
      await pub.waitForTransactionReceipt({ hash: await bot.sendTransaction({ to: n.exchange, data: encodeExecOrder(open) }) });
      console.log(`bot opened ETH long (account ${botAccount.id})`);

      // 6. The executor opens the account's Perpl account and copies the long.
      const copied = await until("the copied ETH long", async () => {
        const a = await chain.account(user.address);
        return a ? (await chain.holdings(a.id, [eth])).get("ETH") : null;
      });
      console.log(`copied: ${copied.size} ETH at ${copied.entryPrice}, margin ${copied.marginAusd}`);
      expect(copied.side).toBe("long");
      // 4 AUSD at 2x (the leader's 3x is capped).
      expect(copied.marginAusd).toBeCloseTo(4, 0);
      expect(await pub.getBalance({ address: user.address })).toBe(0n);

      // 7. The bot closes; the executor closes the copy.
      const close = closeMarketOrder({ market: eth, requestId: rq++, side: "long", size: 0.01, worstPrice: worstPrice("short", mark, 200) });
      await pub.waitForTransactionReceipt({ hash: await bot.sendTransaction({ to: n.exchange, data: encodeExecOrder(close) }) });
      await until("the copied close", async () => {
        const a = await chain.account(user.address);
        return a && !(await chain.holdings(a.id, [eth])).has("ETH");
      });

      const perf = (await (await fetch(`${BACKEND}/v1/autopilot/performance/${user.address}`)).json()) as { stats: { trades: number; pnlAusd: number } };
      console.log(`copy performance: ${JSON.stringify(perf.stats)}`);
      expect(perf.stats.trades).toBe(1);
    },
    600_000,
  );
});
