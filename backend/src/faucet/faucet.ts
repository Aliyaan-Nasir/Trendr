import { balancedHttp } from "@trendr/chain";
import { passkeyAccountAbi } from "@trendr/contracts";
import { type Address, createWalletClient, erc20Abi, type Hex, parseAbi, type PublicClient } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { monadTestnet } from "viem/chains";
import type { Sql } from "../db";

/**
 * Testnet AUSD for beta testers: a fixed amount per account per day from a faucet wallet, which
 * tops itself up from Agora's Testnet faucet when it runs low. Only activated Trendr accounts are
 * paid (an EIP-7702 delegation to a Trendr PasskeyAccount, current or replaced, initialized), since any fresh
 * key can sign in as itself, and a daily cap across all accounts bounds what a crowd of them can
 * take. Testnet only: AUSD on Mainnet is real money and never comes from here.
 */

export const AGORA_FAUCET = "0xd236c18D274E54FAccC3dd9DDA4b27965a73ee6C" as const;
const faucetAbi = parseAbi(["function requestFunds(address to)"]);

export class FaucetError extends Error {
  constructor(
    message: string,
    readonly status: 403 | 409 | 429 | 503,
  ) {
    super(message);
  }
}

/** The code an EIP-7702 account carries while it delegates to `delegate`: 0xef0100 || address. */
export const delegationCode = (delegate: Address): Hex => `0xef0100${delegate.slice(2).toLowerCase()}`;

/** Whether `code` delegates to one of `delegates` (the current PasskeyAccount and replaced ones). */
export const delegatesToOneOf = (code: Hex | undefined, delegates: readonly Address[]): boolean =>
  delegates.some((d) => code?.toLowerCase() === delegationCode(d));

export class Faucet {
  private readonly wallet;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly sql: Sql,
    private readonly client: Pick<PublicClient, "getCode" | "readContract" | "waitForTransactionReceipt">,
    privateKey: Hex,
    rpcUrls: readonly string[],
    private readonly ausd: `0x${string}`,
    readonly amount: bigint,
    /** PasskeyAccount implementations Trendr accounts run (the deployment's and replaced ones): only accounts delegating to one are paid. */
    private readonly delegates: readonly Address[],
    /** Drips in any 24 hours, across all accounts. */
    private readonly dailyCap: number,
  ) {
    this.wallet = createWalletClient({ chain: monadTestnet, transport: balancedHttp(rpcUrls), account: privateKeyToAccount(privateKey) });
  }

  get address() {
    return this.wallet.account.address;
  }

  /** Sends `amount` test AUSD to an activated `account`, once per day per account and within the daily cap. One send at a time. */
  drip(account: `0x${string}`): Promise<{ hash: Hex; amount: string }> {
    const run = this.queue.then(() => this.dripNow(account));
    this.queue = run.catch(() => undefined);
    return run;
  }

  /** True for an activated Trendr account: delegated to a Trendr PasskeyAccount and initialized. */
  async isTrendrAccount(account: Address): Promise<boolean> {
    const code = await this.client.getCode({ address: account });
    if (!delegatesToOneOf(code, this.delegates)) return false;
    return this.client.readContract({ address: account, abi: passkeyAccountAbi, functionName: "isInitialized" });
  }

  private async dripNow(account: `0x${string}`) {
    const recent = await this.sql<{ n: number }[]>`SELECT count(*)::int AS n FROM faucet_drips WHERE account = ${account.toLowerCase()} AND created_at > now() - interval '24 hours'`;
    if ((recent[0]?.n ?? 0) > 0) throw new FaucetError("This account already received test AUSD today.", 429);
    const today = await this.sql<{ n: number }[]>`SELECT count(*)::int AS n FROM faucet_drips WHERE created_at > now() - interval '24 hours'`;
    if ((today[0]?.n ?? 0) >= this.dailyCap) throw new FaucetError("The faucet has paid out today's test AUSD. Try again tomorrow.", 429);
    const eligible = await this.isTrendrAccount(account).catch(() => {
      throw new FaucetError("Could not check the account on chain; try again.", 503);
    });
    if (!eligible) throw new FaucetError("The faucet pays activated Trendr accounts only.", 403);
    let held = await this.client.readContract({ address: this.ausd, abi: erc20Abi, functionName: "balanceOf", args: [this.address] });
    if (held < this.amount) {
      try {
        const topUp = await this.wallet.writeContract({ address: AGORA_FAUCET, abi: faucetAbi, functionName: "requestFunds", args: [this.address], chain: monadTestnet });
        await this.client.waitForTransactionReceipt({ hash: topUp });
        held = await this.client.readContract({ address: this.ausd, abi: erc20Abi, functionName: "balanceOf", args: [this.address] });
      } catch {
        // Agora's faucet limits how often it pays; the check below reports it.
      }
      if (held < this.amount) throw new FaucetError("The faucet is refilling. Try again in a few minutes.", 503);
    }
    const hash = await this.wallet.writeContract({ address: this.ausd, abi: erc20Abi, functionName: "transfer", args: [account, this.amount], chain: monadTestnet });
    const receipt = await this.client.waitForTransactionReceipt({ hash });
    if (receipt.status !== "success") throw new FaucetError("The transfer failed; try again.", 503);
    await this.sql`INSERT INTO faucet_drips (account, amount, tx_hash) VALUES (${account.toLowerCase()}, ${this.amount.toString()}, ${hash})`;
    return { hash, amount: this.amount.toString() };
  }
}
