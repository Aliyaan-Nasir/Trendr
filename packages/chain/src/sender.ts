import {
  type Abi,
  type Address,
  type Chain as ViemChain,
  createPublicClient,
  createWalletClient,
  defineChain,
  type Hex,
  type Log,
  type PublicClient,
  type SignedAuthorization,
  type WalletClient,
} from "viem";
import { nonceManager, privateKeyToAccount } from "viem/accounts";
import { revertReason } from "./revert";
import { balancedHttp } from "./balanced";
import { pacedHttp } from "./transport";

export interface Sent {
  hash: Hex;
  status: "success" | "reverted";
  blockNumber: bigint;
  gasUsed: bigint;
  gasLimit: bigint;
  logs: Log[];
}

export interface SendParams {
  to: Address;
  data: Hex;
  /** MON (wei) sent along; none when unset. */
  value?: bigint;
  authorizationList?: SignedAuthorization[];
  /** Upper bound for the gas limit; Monad bills the limit, so it stays tight. */
  gasCap: bigint;
  /**
   * An exact gas limit, for a call whose cost is fixed by the protocol: a plain MON transfer to an
   * account without code takes 21000. The call is still simulated, but its estimate is not held
   * to `gasCap`, because Monad estimates such a transfer above 21000.
   */
  gas?: bigint;
}

/** Thrown when a simulation reverts; carries the decoded reason when there is one. */
export class SimulationRevert extends Error {
  constructor(readonly reason: string) {
    super(`simulation reverted: ${reason}`);
  }
}

/** The chain operations services need, so they can be tested without a node. */
export interface Chain {
  readonly chainId: number;
  code(address: Address): Promise<Hex | undefined>;
  nonce(address: Address): Promise<number>;
  read(args: { address: Address; abi: Abi; functionName: string; args?: readonly unknown[] }): Promise<unknown>;
  /** Estimates gas for the call from the next sender key; throws SimulationRevert on revert. */
  estimate(params: Omit<SendParams, "gasCap">): Promise<bigint>;
  /** Simulates, then sends with the estimate plus 20%, never above the cap. */
  send(params: SendParams): Promise<Sent>;
  senders(): Address[];
}

/** Serializes work per key so each key sends one transaction at a time. */
class Lane {
  private tail: Promise<unknown> = Promise.resolve();
  run<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.tail.then(fn, fn);
    this.tail = next.catch(() => undefined);
    return next;
  }
}

/** Multicall3 is deployed at its usual address on Monad Mainnet and Testnet. */
const MULTICALL3 = "0xcA11bde05977b3631167028862bE2a173976CA11";

export function monadChain(chainId: number, rpcUrl: string): ViemChain {
  const live = chainId === 143 || chainId === 10143;
  return defineChain({
    id: chainId,
    name: chainId === 143 ? "Monad" : chainId === 10143 ? "Monad Testnet" : `Chain ${chainId}`,
    nativeCurrency: { name: "MON", symbol: "MON", decimals: 18 },
    rpcUrls: { default: { http: [rpcUrl] } },
    // Monad makes a block every 400 ms; viem polls receipts and blocks at half of it, at least 500 ms.
    blockTime: 400,
    contracts: live ? { multicall3: { address: MULTICALL3 } } : undefined,
  });
}

/**
 * Sends from a pool of keys, round robin, one transaction in flight per key. Every send is
 * simulated first, because Monad bills the gas limit even when a transaction reverts.
 */
export class ViemChainClient implements Chain {
  readonly chainId: number;
  readonly client: PublicClient;
  private readonly wallets: WalletClient[];
  private readonly lanes: Lane[];
  private cursor = 0;
  private syncSupported = true;

  /**
   * @param rpcUrl One endpoint, or several to load-balance across with failover.
   * @param errorAbis ABIs whose custom errors decode revert reasons.
   */
  constructor(
    rpcUrl: string | readonly string[],
    chainId: number,
    keys: readonly Hex[],
    private readonly warn: (message: string) => void = () => {},
    private readonly errorAbis: readonly Abi[] = [],
  ) {
    const urls = typeof rpcUrl === "string" ? [rpcUrl] : [...rpcUrl];
    const chain = monadChain(chainId, urls[0]!);
    const transport = urls.length > 1 ? balancedHttp(urls) : pacedHttp(urls[0]!);
    this.chainId = chainId;
    this.client = createPublicClient({ chain, transport });
    this.wallets = keys.map((k) => createWalletClient({ chain, transport, account: privateKeyToAccount(k, { nonceManager }) }));
    this.lanes = keys.map(() => new Lane());
  }

  senders(): Address[] {
    return this.wallets.map((w) => w.account!.address);
  }

  code(address: Address) {
    return this.client.getCode({ address });
  }

  nonce(address: Address) {
    return this.client.getTransactionCount({ address, blockTag: "pending" });
  }

  read(args: { address: Address; abi: Abi; functionName: string; args?: readonly unknown[] }) {
    return this.client.readContract(args as never);
  }

  async estimate(p: Omit<SendParams, "gasCap">): Promise<bigint> {
    const wallet = this.wallets[this.cursor % this.wallets.length]!;
    try {
      return await this.client.estimateGas({
        account: wallet.account!,
        to: p.to,
        data: p.data,
        value: p.value,
        authorizationList: p.authorizationList,
      });
    } catch (e) {
      throw new SimulationRevert(revertReason(e, this.errorAbis));
    }
  }

  async send(p: SendParams): Promise<Sent> {
    const i = this.cursor++ % this.wallets.length;
    const wallet = this.wallets[i]!;
    return this.lanes[i]!.run(async () => {
      let estimate: bigint;
      try {
        estimate = await this.client.estimateGas({
          account: wallet.account!,
          to: p.to,
          data: p.data,
          value: p.value,
          authorizationList: p.authorizationList,
        });
      } catch (e) {
        throw new SimulationRevert(revertReason(e, this.errorAbis));
      }
      if (p.gas === undefined && estimate > p.gasCap) throw new SimulationRevert(`needs ${estimate} gas, above the cap of ${p.gasCap}`);
      const padded = estimate + estimate / 5n;
      const gas = p.gas ?? (padded < p.gasCap ? padded : p.gasCap);
      const request = {
        account: wallet.account!,
        chain: wallet.chain,
        to: p.to,
        data: p.data,
        value: p.value,
        gas,
        authorizationList: p.authorizationList,
      };
      if (this.syncSupported) {
        try {
          // eth_sendRawTransactionSync returns the receipt at the Proposed stage. No timeout is
          // passed: Monad answers within its own limit.
          const receipt = await wallet.sendTransactionSync({ ...request, throwOnReceiptRevert: false } as never);
          return {
            hash: receipt.transactionHash,
            status: receipt.status,
            blockNumber: receipt.blockNumber,
            gasUsed: receipt.gasUsed,
            gasLimit: gas,
            logs: receipt.logs,
          };
        } catch (e) {
          if (!isMethodMissing(e)) throw e;
          this.syncSupported = false;
          this.warn("eth_sendRawTransactionSync is not available; falling back to send and wait");
        }
      }
      const hash = await wallet.sendTransaction(request as never);
      const receipt = await this.client.waitForTransactionReceipt({ hash });
      return { hash, status: receipt.status, blockNumber: receipt.blockNumber, gasUsed: receipt.gasUsed, gasLimit: gas, logs: receipt.logs };
    });
  }
}

function isMethodMissing(e: unknown): boolean {
  const text = e instanceof Error ? `${e.message} ${(e as { details?: string }).details ?? ""}` : String(e);
  return /method not found|not supported|does not exist|unknown method|-32601/i.test(text);
}
