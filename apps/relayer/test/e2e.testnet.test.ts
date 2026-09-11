/**
 * The same account flow live on Monad Testnet: real EIP-7702 delegation, Monad's P256 precompile,
 * eth_sendRawTransactionSync and gas billed by limit. Spends Testnet MON from the relayer key and
 * Testnet AUSD from Agora's faucet. Run with RELAYER_TESTNET=1, RELAYER_PRIVATE_KEYS and
 * FUNDER_PRIVATE_KEY (pays the faucet calls) set.
 */
import { describe, test } from "bun:test";
import {
  decodeL2,
  deployments,
  iKuruOrderBookAbi,
  minimumOut,
  outcomeListingAbi,
  outcomeMarketsAbi,
  quoteBuy,
  quoteSell,
  trendrErrorAbis,
} from "@trendr/contracts";
import { fetchContext, fetchTicker, PERPL_NETWORKS } from "@trendr/perpl";
import pino from "pino";
import { createPublicClient, createWalletClient, erc20Abi, type Hex, http, keccak256, parseAbi, toBytes } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { monadChain, ViemChainClient } from "@trendr/chain";
import { buildServer } from "../src/server";
import { RelayerService } from "../src/service";
import { runAccountFlow } from "./flow";

const enabled = process.env.RELAYER_TESTNET === "1";
const rpc = process.env.RPC_URL ?? "https://testnet-rpc.monad.xyz";
const d = deployments[10143]!;
const FAUCET = "0xd236c18D274E54FAccC3dd9DDA4b27965a73ee6C" as const;

describe.skipIf(!enabled)("relayer end to end on Monad Testnet", () => {
  test("activate, trade with a session, withdraw with the passkey", async () => {
    const chain = monadChain(10_143, rpc);
    const pub = createPublicClient({ chain, transport: http(rpc) });
    const funder = createWalletClient({ chain, transport: http(rpc), account: privateKeyToAccount(process.env.FUNDER_PRIVATE_KEY as Hex) });
    const keys = (process.env.RELAYER_PRIVATE_KEYS ?? "").split(",").filter(Boolean) as Hex[];
    const service = new RelayerService(new ViemChainClient(rpc, 10_143, keys, undefined, trendrErrorAbis), {
      deployment: d,
      maxSessionDailyLimit: 1_000_000_000n,
      maxSessionLifetime: 30 * 86_400,
    });
    const app = buildServer({ service, allowedOrigins: ["https://app.trendr.test"], log: pino({ level: "silent" }) });
    const seriesId = (await pub.readContract({
      address: d.outcomeMarkets,
      abi: outcomeMarketsAbi,
      functionName: "latestSeries",
      args: [keccak256(toBytes("topic:openai")), 86_400],
    })) as Hex;

    // Trade the series' UP token against the live Kuru book, with 1% slippage on the quote.
    const up = (await pub.readContract({ address: d.outcomeMarkets, abi: outcomeMarketsAbi, functionName: "seriesOf", args: [seriesId] })).up;
    const market = await pub.readContract({ address: d.outcomeListing, abi: outcomeListingAbi, functionName: "marketOf", args: [up] });
    const book = async () => decodeL2(await pub.readContract({ address: market, abi: iKuruOrderBookAbi, functionName: "getL2Book", args: [10, 10] }));

    // Perpl's BTC market on Testnet, opened with Perpl's Testnet minimum of 100 AUSD.
    const perplNetwork = PERPL_NETWORKS[10143]!;
    const btc = (await fetchContext(perplNetwork)).markets.find((m) => m.symbol === "BTC")!;

    const result = await runAccountFlow({
      app,
      pub,
      chainId: 10_143,
      d,
      seriesId,
      thief: funder.account.address,
      now: async () => Number((await pub.getBlock()).timestamp),
      perpl: { market: btc, ticker: () => fetchTicker(perplNetwork, btc), openWith: 100_000_000n },
      spot: {
        token: up,
        minOutForBuy: async (ausdIn) => minimumOut(quoteBuy(await book(), ausdIn), 100),
        minOutForSell: async (amountIn) => minimumOut(quoteSell(await book(), amountIn), 100),
      },
      // The funder sends AUSD it already holds; Agora's faucet tops it up when low.
      fund: async (to, amount) => {
        const balance = await pub.readContract({ address: d.ausd, abi: erc20Abi, functionName: "balanceOf", args: [funder.account.address] });
        if (balance < amount) {
          const faucet = parseAbi(["function requestFunds(address to)"]);
          await pub.waitForTransactionReceipt({ hash: await funder.writeContract({ address: FAUCET, abi: faucet, functionName: "requestFunds", args: [funder.account.address] }) });
        }
        await pub.waitForTransactionReceipt({
          hash: await funder.writeContract({ address: d.ausd, abi: erc20Abi, functionName: "transfer", args: [to, amount] }),
        });
      },
      log: (line) => console.log(line),
    });
    console.log(JSON.stringify(result));
  }, 300_000);
});
