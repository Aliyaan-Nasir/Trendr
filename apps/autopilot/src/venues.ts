import { passkeyAccountAbi, sessionExecuteTypedData } from "@trendr/contracts";
import {
  closeMarketOrder,
  depositCalls,
  encodeExecOrder,
  type ExchangeCall,
  openAccountCalls,
  openMarketOrder,
  type OrderSpec,
  type PerplApi,
  type PerplMarket,
  type PerplNetwork,
  toSizeUnits,
  tradeCall,
} from "@trendr/perpl";
import { type Address, erc20Abi, getAddress, type Hex, type LocalAccount, type PublicClient, type WalletClient } from "viem";
import { CNS, type PerplChain } from "./perpl-chain";

/**
 * Where an order goes. The Trendr bot trades through Perpl's signed API (or, while Perpl has the
 * API path down for it, directly on chain from its wallet); accounts trade through the session key
 * they granted Autopilot, in a batch the relayer pays gas for. Every venue reports the
 * transaction (when it knows it) and the block to search from, and the outcome is read from chain.
 */

export interface PlaceOrder {
  market: PerplMarket;
  action: "open" | "close" | "reduce";
  /** The position's side (a close of a long sells). */
  side: "long" | "short";
  size: number;
  leverage: number;
  worstPrice: number;
  requestId: bigint;
}

export interface Sent {
  txHash: Hex | null;
  fromBlock: bigint;
}

/** A refusal; `retryable` when trying again later may succeed (rate limits, outages). */
export class VenueError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
  ) {
    super(message);
  }
}

export interface Venue {
  readonly kind: "api" | "chain" | "session";
  readonly owner: Address;
  /**
   * The most leverage an opening may name here, beyond the market's own limit: an account's session
   * key opens at up to Trendr's Perpl order guard cap (it refuses more); the bot is not capped.
   */
  readonly maxLeverage: number;
  accountId(): Promise<bigint | null>;
  /** Request ids must exceed this (the API's last forwarded id); 0 elsewhere. */
  requestSeed(): Promise<bigint>;
  /** Makes sure the Perpl account exists and can post `marginAusd`, funding it when the venue may. */
  prepare(marginAusd: number): Promise<void>;
  send(o: PlaceOrder): Promise<Sent>;
}

function orderDesc(o: PlaceOrder) {
  return o.action === "open"
    ? openMarketOrder({ market: o.market, requestId: o.requestId, side: o.side, size: o.size, worstPrice: o.worstPrice, leverage: o.leverage })
    : closeMarketOrder({ market: o.market, requestId: o.requestId, side: o.side, size: o.size, worstPrice: o.worstPrice });
}

const isTransient = (e: unknown) => /timeout|timed out|fetch failed|ECONN|socket|429|503|502|rate|unavailable|nonce/i.test(e instanceof Error ? e.message : String(e));

/** The Trendr bot through Perpl's signed API (orders forwarded on chain by Perpl). */
export class ApiVenue implements Venue {
  readonly kind = "api" as const;
  readonly maxLeverage = Number.POSITIVE_INFINITY;
  constructor(
    readonly owner: Address,
    private readonly api: PerplApi,
    private readonly chain: PerplChain,
    private readonly client: Pick<PublicClient, "getBlockNumber">,
  ) {}

  accountId = async () => (await this.chain.account(this.owner))?.id ?? null;

  async requestSeed(): Promise<bigint> {
    const w = await this.api.wallet();
    return BigInt(w.as[0]?.lfr ?? 0);
  }

  async prepare(marginAusd: number): Promise<void> {
    const a = await this.chain.account(this.owner);
    if (!a) throw new VenueError("the bot has no Perpl account", false);
    if (a.balanceAusd < marginAusd) throw new VenueError(`the bot's Perpl balance ${a.balanceAusd.toFixed(2)} AUSD is below the ${marginAusd.toFixed(2)} needed`, false);
  }

  async send(o: PlaceOrder): Promise<Sent> {
    const id = await this.accountId();
    if (!id) throw new VenueError("the bot has no Perpl account", false);
    const head = await this.client.getBlockNumber();
    // Perpl's view of the head lags ours a little; stay well inside the order's lifetime.
    const lastBlock = head + BigInt(Math.max(4, Math.floor(o.market.orderTtlBlocks / 2)));
    const type = o.action === "open" ? (o.side === "long" ? 1 : 2) : o.side === "long" ? 3 : 4;
    const spec: OrderSpec = {
      rq: Number(o.requestId),
      mkt: o.market.id,
      acc: Number(id),
      t: type,
      // A limit at the worst acceptable price, immediate or cancel: a market order with a hard bound.
      p: Math.round(o.worstPrice * 10 ** o.market.priceDecimals),
      s: Number(toSizeUnits(o.market, o.size)),
      fl: 4,
      lv: o.action === "open" ? Math.round(o.leverage * 100) : 0,
      lb: Number(lastBlock),
    };
    let res: Awaited<ReturnType<PerplApi["submit"]>>;
    try {
      res = await this.api.submit([spec]);
    } catch (e) {
      throw new VenueError(e instanceof Error ? e.message : String(e), isTransient(e));
    }
    const s = res.statuses?.[0] ?? res.status;
    if (s.code !== 0) throw new VenueError(`Perpl refused the order: ${s.error ?? `code ${s.code}`}`, s.code === 429 || s.code === 503);
    return { txHash: null, fromBlock: head };
  }
}

/** The Trendr bot's wallet calling the Exchange directly (gas from the bot's MON). */
export class ChainVenue implements Venue {
  readonly kind = "chain" as const;
  readonly maxLeverage = Number.POSITIVE_INFINITY;
  readonly owner: Address;
  constructor(
    private readonly wallet: WalletClient & { account: LocalAccount },
    private readonly chain: PerplChain,
    private readonly client: Pick<PublicClient, "getBlockNumber" | "waitForTransactionReceipt" | "readContract">,
    private readonly network: PerplNetwork,
  ) {
    this.owner = wallet.account.address;
  }

  accountId = async () => (await this.chain.account(this.owner))?.id ?? null;
  requestSeed = async () => 0n;

  async prepare(marginAusd: number): Promise<void> {
    const a = await this.chain.account(this.owner);
    if (!a) throw new VenueError("the bot has no Perpl account", false);
    if (a.balanceAusd >= marginAusd) return;
    const shortfall = BigInt(Math.ceil((marginAusd - a.balanceAusd) * CNS));
    const held = await this.client.readContract({ address: this.network.collateral, abi: erc20Abi, functionName: "balanceOf", args: [this.owner] });
    if (held < shortfall) throw new VenueError("the bot's wallet cannot cover the margin", false);
    for (const c of depositCalls(this.network.exchange, this.network.collateral, shortfall)) await this.sendCall(c);
  }

  async send(o: PlaceOrder): Promise<Sent> {
    const head = await this.client.getBlockNumber();
    const hash = await this.sendCall({ target: this.network.exchange, value: 0n, data: encodeExecOrder(orderDesc(o)) });
    return { txHash: hash, fromBlock: head };
  }

  private async sendCall(c: ExchangeCall): Promise<Hex> {
    try {
      const hash = await this.wallet.sendTransaction({ account: this.wallet.account, chain: this.wallet.chain, to: c.target, data: c.data, value: 0n });
      const r = await this.client.waitForTransactionReceipt({ hash });
      if (r.status !== "success") throw new VenueError(`transaction ${hash} reverted`, false);
      return hash;
    } catch (e) {
      if (e instanceof VenueError) throw e;
      throw new VenueError(e instanceof Error ? e.message.slice(0, 300) : String(e), isTransient(e));
    }
  }
}

/** An account trading through its Autopilot session key, gas paid by the relayer. */
export class SessionVenue implements Venue {
  readonly kind = "session" as const;
  constructor(
    readonly owner: Address,
    private readonly sessionKey: LocalAccount,
    private readonly chain: PerplChain,
    private readonly client: Pick<PublicClient, "getBlockNumber" | "readContract">,
    private readonly network: PerplNetwork,
    private readonly relayerUrl: string,
    private readonly minAccountOpen: bigint,
    /** The order guard's cap (perplSessionMaxLeverage of the deployment). */
    readonly maxLeverage: number,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  /** The granted session key this venue signs with. */
  get signer(): Address {
    return this.sessionKey.address;
  }

  accountId = async () => (await this.chain.account(this.owner))?.id ?? null;
  requestSeed = async () => 0n;

  /** Opens the Perpl account or tops it up from the account's AUSD; both count against the session's daily cap. */
  async prepare(marginAusd: number): Promise<void> {
    const a = await this.chain.account(this.owner);
    const need = BigInt(Math.ceil(marginAusd * CNS * 1.01));
    if (!a) {
      const amount = need > this.minAccountOpen ? need : this.minAccountOpen;
      await this.relay(openAccountCalls(this.network.exchange, this.network.collateral, amount, false));
      return;
    }
    const balance = BigInt(Math.floor(a.balanceAusd * CNS));
    if (balance >= need) return;
    await this.relay(depositCalls(this.network.exchange, this.network.collateral, need - balance));
  }

  async send(o: PlaceOrder): Promise<Sent> {
    const head = await this.client.getBlockNumber();
    const hash = await this.relay([tradeCall(this.network.exchange, orderDesc(o))]);
    return { txHash: hash, fromBlock: head };
  }

  private async relay(calls: ExchangeCall[]): Promise<Hex> {
    const session = await this.client.readContract({ address: this.owner, abi: passkeyAccountAbi, functionName: "sessionOf", args: [this.sessionKey.address] });
    if (!session.active || Number(session.validUntil) <= Math.floor(Date.now() / 1000)) throw new VenueError("the Autopilot session is no longer active on the account", false);
    const deadline = BigInt(Math.floor(Date.now() / 1000) + 120);
    const typed = sessionExecuteTypedData(this.network.chainId, this.owner, calls, this.sessionKey.address, session.nonce, deadline);
    const signature = await this.sessionKey.signTypedData(typed as never);
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.relayerUrl}/v1/session/execute`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ account: getAddress(this.owner), calls, sessionKey: this.sessionKey.address, deadline, signature }, (_k, v) => (typeof v === "bigint" ? v.toString() : v)),
        signal: AbortSignal.timeout(60_000),
      });
    } catch (e) {
      throw new VenueError(`relayer unreachable: ${e instanceof Error ? e.message : String(e)}`, true);
    }
    const body = (await res.json().catch(() => ({}))) as { hash?: Hex; status?: string; error?: string; message?: string };
    if (!res.ok) throw new VenueError(`relayer refused: ${body.message ?? body.error ?? res.status}`, res.status === 429 || res.status >= 500);
    if (body.status !== "success" || !body.hash) throw new VenueError(`the batch reverted (${body.hash ?? "no hash"})`, false);
    return body.hash;
  }
}
