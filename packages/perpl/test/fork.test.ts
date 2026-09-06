/**
 * Trading the real Perpl Exchange on a fork of Monad Testnet: open a Perpl account with AUSD, go
 * long BTC at market, close it, and read the account back. This is the on-chain path Trendr
 * accounts use through the relayer. Run with PERPL_FORK=1 (needs anvil and network access).
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createPublicClient, createWalletClient, erc20Abi, type Hex, http, numberToHex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { closeMarketOrder, exchangeAbi, fetchContext, fetchTicker, openAccountCalls, openMarketOrder, PERPL_NETWORKS, type PerplMarket, worstPrice } from "../src";

const enabled = process.env.PERPL_FORK === "1";
const n = PERPL_NETWORKS[10143]!;
const FUNDER = "0xda55F7263b7e4D9B36b2F542EEC99fc3b5Dfae7a" as const; // holds Testnet AUSD
const KEY = "0x8b3a350cf5c34c9194ca85829a2df0ec3153be0318b5e2d3348e872092edffba" as const;
const port = 9300 + Math.floor(Math.random() * 300);
const rpc = `http://127.0.0.1:${port}`;
const pub = createPublicClient({ transport: http(rpc) });
const trader = createWalletClient({ transport: http(rpc), account: privateKeyToAccount(KEY) });
let anvil: ReturnType<typeof Bun.spawn> | undefined;
let btc: PerplMarket;

async function wait(hash: Hex) {
  const r = await pub.waitForTransactionReceipt({ hash });
  if (r.status !== "success") throw new Error(`reverted: ${hash}`);
  return r;
}

describe.skipIf(!enabled)("Perpl on a Monad Testnet fork", () => {
  beforeAll(async () => {
    anvil = Bun.spawn(["anvil", "--fork-url", "https://testnet-rpc.monad.xyz", "--port", String(port), "--silent"], { stdout: "ignore", stderr: "ignore" });
    for (let i = 0; i < 200; i++) {
      try {
        await pub.getChainId();
        break;
      } catch {
        await Bun.sleep(100);
      }
    }
    btc = (await fetchContext(n)).markets.find((m) => m.symbol === "BTC")!;
    await pub.request({ method: "anvil_setBalance", params: [trader.account.address, numberToHex(10n ** 20n)] } as never);
    await pub.request({ method: "anvil_impersonateAccount", params: [FUNDER] } as never);
    const funder = createWalletClient({ transport: http(rpc), account: FUNDER });
    await wait(await funder.writeContract({ address: n.collateral, abi: erc20Abi, functionName: "transfer", args: [trader.account.address, 200_000_000n], chain: null }));
  }, 120_000);

  afterAll(() => anvil?.kill());

  test("open an account, go long BTC at market and close", async () => {
    for (const c of openAccountCalls(n.exchange, n.collateral, 150_000_000n, true)) {
      await wait(await trader.sendTransaction({ to: c.target, data: c.data, chain: null }));
    }
    const account = await pub.readContract({ address: n.exchange, abi: exchangeAbi, functionName: "getAccountByAddr", args: [trader.account.address] });
    expect(account.accountId).toBeGreaterThan(0n);
    expect(account.balanceCNS).toBe(150_000_000n);

    const ticker = await fetchTicker(n, btc);
    const open = openMarketOrder({ market: btc, requestId: 1n, side: "long", size: 0.001, worstPrice: worstPrice("long", ticker.ask, 100), leverage: 2 });
    await wait(await trader.writeContract({ address: n.exchange, abi: exchangeAbi, functionName: "execOrder", args: [open], chain: null }));
    const [position] = await pub.readContract({ address: n.exchange, abi: exchangeAbi, functionName: "getPosition", args: [BigInt(btc.id), account.accountId] });
    expect(position.lotLNS).toBe(100n);
    expect(position.positionType).toBe(0);

    const close = closeMarketOrder({ market: btc, requestId: 2n, side: "long", size: 0.001, worstPrice: worstPrice("short", ticker.bid, 100) });
    await wait(await trader.writeContract({ address: n.exchange, abi: exchangeAbi, functionName: "execOrder", args: [close], chain: null }));
    const [after] = await pub.readContract({ address: n.exchange, abi: exchangeAbi, functionName: "getPosition", args: [BigInt(btc.id), account.accountId] });
    expect(after.lotLNS).toBe(0n);
    const back = await pub.readContract({ address: n.exchange, abi: exchangeAbi, functionName: "getAccountById", args: [account.accountId] });
    // A round trip of 0.001 BTC costs two taker fees and the spread, well under 1 AUSD.
    expect(back.balanceCNS).toBeGreaterThan(149_000_000n);
    console.log(`account ${account.accountId} balance after round trip ${Number(back.balanceCNS) / 1e6} AUSD`);
  }, 180_000);
});
