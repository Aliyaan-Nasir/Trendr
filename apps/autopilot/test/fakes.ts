import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { PerplMarket } from "@trendr/perpl";
import { connect, ExecutorDb } from "../src/db";
import type { Log, VenueResolver } from "../src/executor";
import type { ChainHolding, OrderOutcome, PerplChain } from "../src/perpl-chain";
import { type PlaceOrder, type Sent, type Venue, VenueError } from "../src/venues";

/** The backend's schema on the test database, emptied. */
export async function testDb(): Promise<ExecutorDb> {
  const url = process.env.TEST_DATABASE_URL;
  if (!url) throw new Error("TEST_DATABASE_URL is required");
  const sql = connect(url);
  const dir = join(import.meta.dir, "../../../backend/src/db/migrations");
  for (const f of readdirSync(dir).filter((f) => f.endsWith(".sql")).sort()) await sql.unsafe(readFileSync(join(dir, f), "utf8"));
  await sql`TRUNCATE index_points, index_sync, autopilot_rules, autopilot_backtests, autopilot_grants, autopilot_positions, autopilot_orders, autopilot_audit, autopilot_control, follows, leader_holdings, perpl_request_ids, measurements RESTART IDENTITY CASCADE`;
  return new ExecutorDb(sql);
}

export const quiet: Log = { info: () => {}, warn: () => {}, error: () => {} };

export const BTC: PerplMarket = { id: 16, name: "BTC Perp", symbol: "BTC", priceDecimals: 1, sizeDecimals: 5, maxLeverage: 15, maintenanceMargin: 0.04, defaultMnp: 1000, maxSlippageBps: 1000, orderTtlBlocks: 20, isOpen: true };
export const ETH: PerplMarket = { ...BTC, id: 32, name: "ETH Perp", symbol: "ETH", priceDecimals: 2, sizeDecimals: 3 };

/** Perpl as a map of accounts to holdings, with scripted order outcomes. */
export class FakeChain {
  marksBy = new Map<string, number>([
    ["BTC", 80_000],
    ["ETH", 3_000],
  ]);
  /** account id to its holdings */
  books = new Map<bigint, Map<string, ChainHolding>>();
  accounts = new Map<string, bigint>();
  outcomes = new Map<string, OrderOutcome>();
  feeBps = 4;

  account = async (owner: string) => {
    const id = this.accounts.get(owner.toLowerCase());
    return id ? { id, balanceAusd: 1_000 } : null;
  };
  marks = async (markets: readonly PerplMarket[]) => new Map(markets.filter((m) => this.marksBy.has(m.symbol)).map((m) => [m.symbol, this.marksBy.get(m.symbol)!]));
  holdings = async (id: bigint, markets: readonly PerplMarket[]) => {
    const book = this.books.get(id) ?? new Map();
    return new Map([...book].filter(([m]) => markets.some((x) => x.symbol === m)));
  };
  outcomeOfTx = async (_tx: string, accountId: bigint, rq: bigint) => this.outcomes.get(`${accountId}:${rq}`) ?? null;
  findOrder = async (accountId: bigint, rq: bigint) => this.outcomes.get(`${accountId}:${rq}`) ?? null;

  /** Fills an order at the mark and updates the account's book, as the exchange would. */
  fill(accountId: bigint, o: PlaceOrder): OrderOutcome {
    const price = this.marksBy.get(o.market.symbol)!;
    const book = this.books.get(accountId) ?? new Map<string, ChainHolding>();
    this.books.set(accountId, book);
    const fee = (price * o.size * this.feeBps) / 10_000;
    const h = book.get(o.market.symbol);
    let pnl = 0;
    let margin = 0;
    if (o.action === "open") {
      margin = (price * o.size) / o.leverage;
      const size = (h?.size ?? 0) + o.size;
      const entry = h ? (h.entryPrice * h.size + price * o.size) / size : price;
      book.set(o.market.symbol, { side: o.side, size, entryPrice: entry, marginAusd: (h?.marginAusd ?? 0) + margin });
    } else if (h) {
      const size = Math.min(o.size, h.size);
      pnl = (o.side === "long" ? price - h.entryPrice : h.entryPrice - price) * size;
      if (size >= h.size - 1e-12) book.delete(o.market.symbol);
      else book.set(o.market.symbol, { ...h, size: h.size - size, marginAusd: h.marginAusd * ((h.size - size) / h.size) });
    }
    const out: OrderOutcome = { txHash: `0x${o.requestId.toString(16).padStart(64, "0")}`, blockNumber: 1n, filled: o.size, price, marginAusd: margin, pnlAusd: pnl, feeAusd: fee, failure: null };
    this.outcomes.set(`${accountId}:${o.requestId}`, out);
    return out;
  }
}

/** A venue that fills on the fake chain, or fails as scripted. */
export class FakeVenue implements Venue {
  readonly kind = "session" as const;
  /** A session's leverage cap, as the Testnet order guard sets it. */
  maxLeverage = 10;
  sent: PlaceOrder[] = [];
  /** Errors to throw on the next sends, in order. */
  failures: VenueError[] = [];
  constructor(
    readonly owner: `0x${string}`,
    private readonly id: bigint,
    private readonly chain: FakeChain,
  ) {
    chain.accounts.set(owner.toLowerCase(), id);
  }
  accountId = async () => this.id;
  requestSeed = async () => 0n;
  prepare = async () => {};
  send = async (o: PlaceOrder): Promise<Sent> => {
    const f = this.failures.shift();
    if (f) throw f;
    this.sent.push(o);
    const out = this.chain.fill(this.id, o);
    return { txHash: out.txHash, fromBlock: 1n };
  };
}

export class FakeVenues implements VenueResolver {
  constructor(readonly byOwner: Map<string, Venue>) {}
  forOwner = async (owner: string) => this.byOwner.get(owner.toLowerCase()) ?? null;
}

export const asChain = (c: FakeChain) => c as unknown as PerplChain;

/** A grant box exactly as the API server sealed it before v2: ephemeral key | IV | ciphertext, AAD the ephemeral key. */
export async function sealV1(plaintext: string, recipientPublicKey: string): Promise<string> {
  const recipient = await crypto.subtle.importKey("raw", new Uint8Array(Buffer.from(recipientPublicKey, "base64url")), { name: "ECDH", namedCurve: "P-256" }, false, []);
  const eph = (await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"])) as CryptoKeyPair;
  const ephRaw = new Uint8Array(await crypto.subtle.exportKey("raw", eph.publicKey));
  const shared = await crypto.subtle.deriveBits({ name: "ECDH", public: recipient }, eph.privateKey, 256);
  const ikm = await crypto.subtle.importKey("raw", shared, "HKDF", false, ["deriveKey"]);
  const info = new TextEncoder().encode("trendr-autopilot-grant-v1");
  const key = await crypto.subtle.deriveKey({ name: "HKDF", hash: "SHA-256", salt: ephRaw, info }, ikm, { name: "AES-GCM", length: 256 }, false, ["encrypt"]);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: ephRaw }, key, new TextEncoder().encode(plaintext)));
  return Buffer.concat([ephRaw, iv, ct]).toString("base64url");
}
export { VenueError };
