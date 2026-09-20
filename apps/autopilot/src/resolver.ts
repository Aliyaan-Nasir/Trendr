import { open } from "@trendr/autopilot";
import { passkeyAccountAbi } from "@trendr/contracts";
import { exchangeAbi, type PerplNetwork } from "@trendr/perpl";
import { type Address, getAbiItem, getAddress, isAddressEqual, type LocalAccount, type PublicClient, toFunctionSelector } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import type { ExecutorDb, GrantRow } from "./db";
import type { VenueResolver } from "./executor";
import type { PerplChain } from "./perpl-chain";
import { SessionVenue, type Venue } from "./venues";

const EXEC_ORDER = toFunctionSelector(getAbiItem({ abi: exchangeAbi, name: "execOrder" }));

/**
 * Venues per owner: the bot's own venue, and for accounts a session venue built from the grant the
 * app sealed to this executor (bound to the account and the key; older grants the API server sealed
 * still open). Grants are re-read every tick and checked against the
 * account's on-chain session, so a revoked or expired one stops trading at once; a grant made
 * since the last tick is read on demand. A replacement key the account asked for takes over once
 * the account has added it on chain, and the old key trades until then. Opened keys stay only in
 * memory.
 */
export class Venues implements VenueResolver {
  private grants = new Map<string, GrantRow>();
  private readonly keys = new Map<string, LocalAccount>();

  constructor(
    private readonly db: ExecutorDb,
    private readonly chain: PerplChain,
    private readonly client: Pick<PublicClient, "getBlockNumber" | "readContract">,
    private readonly network: PerplNetwork,
    /** The deployment's Perpl order guard, which a grant's orders must name, and its leverage cap. */
    private readonly session: { orderGuard: Address; maxLeverage: number },
    private readonly relayerUrl: string,
    private readonly minAccountOpen: () => Promise<bigint>,
    private readonly sealPrivateKey: string | undefined,
    private readonly bot: { address: Address; venue: Venue } | null,
  ) {}

  async refresh(nowSec: number): Promise<void> {
    const next = new Map<string, GrantRow>();
    for (const g of await this.db.grants()) {
      const live = await this.usable(g, nowSec);
      if (live) next.set(g.owner, live);
    }
    this.grants = next;
  }

  /** The grant to trade with, or null after marking it expired, or revoked when the account revoked its session on chain. */
  private async usable(g: GrantRow, nowSec: number): Promise<GrantRow | null> {
    const current = (g.nextSessionKey ? await this.switchOver(g, g.nextSessionKey, nowSec) : null) ?? g;
    if (current.validUntil <= nowSec) {
      await this.db.setGrantStatus(current.owner, current.sessionKey, "expired");
      await this.db.audit(current.owner, "grant_expired", { sessionKey: current.sessionKey });
      return null;
    }
    const session = await this.sessionOf(current.owner, current.sessionKey);
    // A failed read keeps the grant; the chain refuses a dead session anyway.
    if (session && !session.active) {
      await this.db.setGrantStatus(current.owner, current.sessionKey, "revoked");
      await this.db.audit(current.owner, "grant_revoked_on_chain", { sessionKey: current.sessionKey });
      return null;
    }
    return current;
  }

  /**
   * Switches a grant to its waiting key once the account has added it on chain with Perpl orders
   * going through the current order guard (the app drops the old key in the same passkey batch).
   * Null while it is not there yet.
   */
  private async switchOver(g: GrantRow, nextKey: string, nowSec: number): Promise<GrantRow | null> {
    const session = await this.sessionOf(g.owner, nextKey);
    if (!session?.active || Number(session.validUntil) <= nowSec) return null;
    const guard = await this.client
      .readContract({ address: getAddress(g.owner), abi: passkeyAccountAbi, functionName: "guardOf", args: [getAddress(nextKey), this.network.exchange, EXEC_ORDER] })
      .catch(() => null);
    if (!guard || !isAddressEqual(guard, this.session.orderGuard)) return null;
    const switched = await this.db.switchGrant(g.owner, nextKey, Number(session.validUntil), session.dailyLimit);
    if (switched) await this.db.audit(g.owner, "grant_switched", { from: g.sessionKey, sessionKey: switched.sessionKey, validUntil: switched.validUntil, dailyLimit: switched.dailyLimit.toString() });
    return switched;
  }

  private sessionOf(owner: string, key: string) {
    return this.client.readContract({ address: getAddress(owner), abi: passkeyAccountAbi, functionName: "sessionOf", args: [getAddress(key)] }).catch(() => null);
  }

  async forOwner(owner: string): Promise<Venue | null> {
    const o = owner.toLowerCase();
    if (this.bot && o === this.bot.address.toLowerCase()) return this.bot.venue;
    let g = this.grants.get(o);
    if (!g) {
      // Granted since the last refresh (a rule can be enabled in the same tick as its grant).
      const fresh = await this.db.grant(o);
      const live = fresh ? await this.usable(fresh, Math.floor(Date.now() / 1000)) : null;
      if (live) {
        this.grants.set(o, live);
        g = live;
      }
    }
    if (!g || !this.sealPrivateKey) return null;
    const cacheKey = `${o}:${g.sessionKey}`;
    let key = this.keys.get(cacheKey);
    if (!key) {
      key = privateKeyToAccount((await open(g.sealedKey, this.sealPrivateKey, { owner: o, sessionKey: g.sessionKey })) as `0x${string}`);
      if (key.address.toLowerCase() !== g.sessionKey) throw new Error(`grant for ${o} does not open to its session key`);
      // A replaced key is dead on chain; keep only the current one in memory.
      for (const k of this.keys.keys()) if (k.startsWith(`${o}:`)) this.keys.delete(k);
      this.keys.set(cacheKey, key);
    }
    return new SessionVenue(getAddress(o), key, this.chain, this.client, this.network, this.relayerUrl, await this.minAccountOpen(), this.session.maxLeverage);
  }
}
