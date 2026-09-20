import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { generateSealKeyPair, seal } from "@trendr/autopilot";
import { PERPL_NETWORKS } from "@trendr/perpl";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import type { ExecutorDb } from "../src/db";
import type { PerplChain } from "../src/perpl-chain";
import { Venues } from "../src/resolver";
import type { SessionVenue } from "../src/venues";
import { sealV1, testDb } from "./fakes";

/**
 * Grants as the executor sees them: one made since the last refresh is found on demand, one the
 * account revoked on chain stops at the next refresh and is marked revoked, and a requested
 * replacement takes over only once the account has added it on chain. Keys arrive sealed by the
 * app and bound to their account and address; grants the API server sealed earlier still open.
 */

const OWNER = "0x00000000000000000000000000000000000000a1";
let db: ExecutorDb;
let keys: { publicKey: string; privateKey: string };
/** On-chain sessions by key: whether active, and whether they may place Perpl orders (default yes). */
const active = new Map<string, boolean>();
const permitted = new Map<string, boolean>();
/** The guard each key's Perpl orders name, when not the current one. */
const guards = new Map<string, string>();
const GUARD = "0x00000000000000000000000000000000000000f1";
const client = {
  getBlockNumber: async () => 1n,
  readContract: (async ({ functionName, args }: { functionName: string; args: readonly unknown[] }) => {
    const key = String(args[0]).toLowerCase();
    if (functionName === "guardOf") return (permitted.get(key) ?? true) ? (guards.get(key) ?? GUARD) : "0x0000000000000000000000000000000000000000";
    return { active: active.get(key) ?? false, validUntil: 2_000_000_000, dailyLimit: 250_000_000n, day: 0, spentToday: 0n, nonce: 0n };
  }) as never,
};

async function newKey(owner: string, sealAs?: { owner: string; sessionKey: string }) {
  const key = generatePrivateKey();
  const address = privateKeyToAccount(key).address.toLowerCase();
  return { address, sealed: await seal(key, keys.publicKey, sealAs ?? { owner, sessionKey: address }) };
}

async function grant(owner: string, k?: { address: string; sealed: string }) {
  k ??= await newKey(owner);
  await db.sql`INSERT INTO autopilot_grants (owner, session_key, sealed_key, status, valid_until, daily_limit)
    VALUES (${owner}, ${k.address}, ${k.sealed}, 'active', 2000000000, 100000000)
    ON CONFLICT (owner) DO UPDATE SET session_key = EXCLUDED.session_key, sealed_key = EXCLUDED.sealed_key, status = 'active', valid_until = 2000000000,
      next_session_key = NULL, next_sealed_key = NULL`;
  return k.address;
}

/** What the backend stores when an account with an active grant asks for a new key. */
async function requestReplacement(owner: string) {
  const k = await newKey(owner);
  await db.sql`UPDATE autopilot_grants SET next_session_key = ${k.address}, next_sealed_key = ${k.sealed} WHERE owner = ${owner}`;
  return k.address;
}

const row = async () => (await db.sql<{ session_key: string; status: string; next_session_key: string | null; valid_until: string; daily_limit: string }[]>`SELECT * FROM autopilot_grants WHERE owner = ${OWNER}`)[0]!;
const signer = (v: unknown) => (v as SessionVenue | null)?.signer.toLowerCase() ?? null;

beforeAll(async () => {
  db = await testDb();
  keys = await generateSealKeyPair();
});
afterAll(async () => {
  await db.sql.end();
});

describe("Venues", () => {
  const venues = () => new Venues(db, {} as PerplChain, client, PERPL_NETWORKS[10143]!, { orderGuard: GUARD, maxLeverage: 10 }, "http://relayer", async () => 0n, keys.privateKey, null);

  test("a grant made after the last refresh is read on demand", async () => {
    const v = venues();
    await v.refresh(1_000);
    expect(await v.forOwner(OWNER)).toBeNull();
    active.set(await grant(OWNER), true);
    const venue = await v.forOwner(OWNER);
    expect(venue?.owner.toLowerCase()).toBe(OWNER);
  });

  test("a session revoked on chain stops the grant and marks it revoked", async () => {
    const session = await grant(OWNER);
    active.set(session, true);
    const v = venues();
    await v.refresh(1_000);
    expect(await v.forOwner(OWNER)).not.toBeNull();
    active.set(session, false);
    await v.refresh(1_015);
    expect(await v.forOwner(OWNER)).toBeNull();
    expect((await row()).status).toBe("revoked");
  });

  test("an expired grant stops and is marked expired", async () => {
    active.set(await grant(OWNER), true);
    const v = venues();
    await v.refresh(2_000_000_000);
    expect(await v.forOwner(OWNER)).toBeNull();
    expect((await row()).status).toBe("expired");
  });

  test("a requested replacement leaves the active key trading until the account adds it on chain", async () => {
    const first = await grant(OWNER);
    active.set(first, true);
    const second = await requestReplacement(OWNER);
    const v = venues();
    await v.refresh(1_000);
    expect(signer(await v.forOwner(OWNER))).toBe(first);
    expect(await row()).toMatchObject({ session_key: first, status: "active", next_session_key: second });

    // One passkey batch adds the new key and drops the old one: the next refresh switches over.
    active.set(second, true);
    active.set(first, false);
    await v.refresh(1_015);
    expect(signer(await v.forOwner(OWNER))).toBe(second);
    expect(await row()).toMatchObject({ session_key: second, status: "active", next_session_key: null, valid_until: "2000000000", daily_limit: "250000000" });
    const audit = await db.sql<{ event: string }[]>`SELECT event FROM autopilot_audit WHERE owner = ${OWNER} ORDER BY id DESC LIMIT 1`;
    expect(audit[0]?.event).toBe("grant_switched");
  });

  test("a grant read on demand switches over too", async () => {
    await db.sql`DELETE FROM autopilot_grants WHERE owner = ${OWNER}`;
    const v = venues();
    await v.refresh(1_000);
    const first = await grant(OWNER);
    const second = await requestReplacement(OWNER);
    active.set(second, true);
    active.set(first, false);
    expect(signer(await v.forOwner(OWNER))).toBe(second);
    expect((await row()).session_key).toBe(second);
  });

  test("a replacement that cannot place Perpl orders never takes over, and a revoked old key still stops", async () => {
    const first = await grant(OWNER);
    active.set(first, true);
    const second = await requestReplacement(OWNER);
    active.set(second, true);
    permitted.set(second, false);
    active.set(first, false);
    const v = venues();
    await v.refresh(1_000);
    expect(await v.forOwner(OWNER)).toBeNull();
    expect(await row()).toMatchObject({ session_key: first, status: "revoked", next_session_key: second });
  });

  test("a replacement whose Perpl orders name a replaced guard never takes over", async () => {
    const first = await grant(OWNER);
    active.set(first, true);
    const second = await requestReplacement(OWNER);
    active.set(second, true);
    guards.set(second, "0x00000000000000000000000000000000000000f0");
    const v = venues();
    await v.refresh(1_000);
    expect(signer(await v.forOwner(OWNER))).toBe(first);
    expect(await row()).toMatchObject({ session_key: first, status: "active", next_session_key: second });
    // The session venue carries the cap the guard enforces.
    expect((await v.forOwner(OWNER))?.maxLeverage).toBe(10);
  });

  test("a revoked old key with its replacement not on chain stops", async () => {
    const first = await grant(OWNER);
    active.set(first, true);
    await requestReplacement(OWNER);
    active.set(first, false);
    const v = venues();
    await v.refresh(1_000);
    expect(await v.forOwner(OWNER)).toBeNull();
    expect((await row()).status).toBe("revoked");
  });

  test("a grant the API server sealed before v2 still trades", async () => {
    const key = generatePrivateKey();
    const address = privateKeyToAccount(key).address.toLowerCase();
    active.set(await grant(OWNER, { address, sealed: await sealV1(key, keys.publicKey) }), true);
    expect(signer(await venues().forOwner(OWNER))).toBe(address);
  });

  test("a key sealed for another account, or under another key's address, does not open", async () => {
    const stolen = await newKey("0x00000000000000000000000000000000000000b2");
    active.set(await grant(OWNER, stolen), true);
    await expect(venues().forOwner(OWNER)).rejects.toThrow();
    const real = await newKey(OWNER);
    const swapped = await newKey(OWNER, { owner: OWNER, sessionKey: real.address });
    active.set(await grant(OWNER, { address: real.address, sealed: swapped.sealed }), true);
    await expect(venues().forOwner(OWNER)).rejects.toThrow();
  });

  test("a stale read of the old key never revokes the key that replaced it", async () => {
    const first = await grant(OWNER);
    const second = await grant(OWNER);
    await db.setGrantStatus(OWNER, first, "revoked");
    expect(await row()).toMatchObject({ session_key: second, status: "active" });
  });
});
