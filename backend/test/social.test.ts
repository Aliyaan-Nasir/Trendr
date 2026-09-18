import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { ownerRequests } from "@trendr/contracts";
import { Hono } from "hono";
import { ContractFunctionZeroDataError, verifyMessage } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { OwnerApprovals } from "../src/api/owner-approval";
import type { ChainReader, ChainTrend } from "../src/chain";
import type { Sql } from "../src/db";
import { auditNotification, Dispatcher } from "../src/notify/dispatcher";
import { isPushEndpoint, Push } from "../src/notify/push";
import { moderationRoutes } from "../src/social/moderation";
import { callMessage, identitySignInMessage, linkMessage, postMessage, profileMessage, resolveCalls, socialRoutes, wilson } from "../src/social/routes";
import { parseServices, status } from "../src/status";
import { testDb } from "./helpers";
import { type TestPasskey, testPasskey } from "./passkey";

const identity = privateKeyToAccount("0x0000000000000000000000000000000000000000000000000000000000000a11");
const other = privateKeyToAccount("0x0000000000000000000000000000000000000000000000000000000000000b22");
const account = privateKeyToAccount("0x0000000000000000000000000000000000000000000000000000000000000c33");
const T = 1_800_000_000;
let now = T * 1000;
let sql: Sql;
let app: ReturnType<typeof socialRoutes>;
let approvals: OwnerApprovals;
let passkey: TestPasskey;
const trend: ChainTrend = { id: "0x00000000000000000000000000000000000000000000000000000000000000aa", identifier: "topic:openai", assetClass: 6, status: "Active", createdAt: T - 86_400, updatedAt: T, statusSince: T - 86_400, index: 40, peakIndex: 50, surfacer: "0x0000000000000000000000000000000000000000" };
const trends: ChainTrend[] = [trend];
const chain = { trends: async () => trends, lastRunId: async () => BigInt(T - 60), client: { getBlock: async () => ({ timestamp: BigInt(T - 2), number: 100n }) } } as unknown as ChainReader;

beforeAll(async () => {
  sql = await testDb();
  passkey = await testPasskey();
  // Only `account` is a passkey account; anything else has no code.
  const client = {
    readContract: async ({ functionName, address }: { functionName: string; address: string }) => {
      if (functionName === "owner" && address.toLowerCase() === account.address.toLowerCase()) return passkey.owner;
      throw new ContractFunctionZeroDataError({ functionName });
    },
  };
  approvals = new OwnerApprovals(sql, client as never, 10143, () => now);
  app = socialRoutes({ sql, chain, approvals, sessionSecret: "s".repeat(64), isRevoked: async () => false, now: () => now });
});
afterAll(async () => {
  await sql.end();
});
beforeEach(async () => {
  now = T * 1000;
  await sql`TRUNCATE posts, calls, callers, vault_items, push_subscriptions, cursors, index_points, autopilot_audit, moderation_log RESTART IDENTITY CASCADE`;
});

const post = (path: string, body: unknown, headers: Record<string, string> = {}) => app.request(path, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
async function call(direction: "up" | "down", who = identity, horizonSec = 86_400) {
  const c = { identifier: "topic:openai", direction, horizonSec, note: "launch week", issuedAt: Math.floor(now / 1000) };
  return post("/calls", { ...c, caller: who.address, signature: await who.signMessage({ message: callMessage(c) }) });
}

describe("calls", () => {
  test("are signed by the identity key, open at the live index and resolve from checkpoints", async () => {
    const res = await call("up");
    expect(res.status).toBe(201);
    const { call: c } = (await res.json()) as { call: { id: number; caller: string; openingIndex: number; resolvesAt: number } };
    expect(c).toMatchObject({ caller: identity.address.toLowerCase(), openingIndex: 40, resolvesAt: T + 86_400 });
    await call("down", other);
    // Not due yet.
    expect(await resolveCalls(sql, chain, T + 100)).toEqual({ resolved: 0 });
    await sql`INSERT INTO index_points (trend_id, observed_at, points) VALUES (${trend.id}, ${T + 86_000}, 39), (${trend.id}, ${T + 86_500}, 46)`;
    expect(await resolveCalls(sql, chain, T + 90_000)).toEqual({ resolved: 2 });
    const rows = await sql<{ caller: string; outcome: string; closing_index: number }[]>`SELECT caller, outcome, closing_index FROM calls ORDER BY id`;
    // The first checkpoint at or after the end (46) settles both.
    expect(rows.map((r) => [r.outcome, r.closing_index])).toEqual([["hit", 46], ["miss", 46]]);
  });

  test("refuse tampered, stale, duplicate and dead-trend calls", async () => {
    const c = { identifier: "topic:openai", direction: "up" as const, horizonSec: 86_400, note: "", issuedAt: Math.floor(now / 1000), caller: identity.address };
    const signature = await identity.signMessage({ message: callMessage(c) });
    // Changing anything after signing recovers someone else, which is not the claimed caller.
    expect((await post("/calls", { ...c, direction: "down", signature })).status).toBe(401);
    expect((await post("/calls", { ...c, signature })).status).toBe(201);
    expect((await post("/calls", { ...c, signature })).status).toBe(409);
    const old = { ...c, issuedAt: c.issuedAt - 400 };
    expect((await post("/calls", { ...old, signature: await identity.signMessage({ message: callMessage(old) }) })).status).toBe(401);
    const dead = { ...c, identifier: "topic:nothing" };
    expect((await post("/calls", { ...dead, signature: await identity.signMessage({ message: callMessage(dead) }) })).status).toBe(400);
  });

  test("ranks callers by the Wilson bound of their hit rate", () => {
    expect(wilson(9, 10)).toBeGreaterThan(wilson(1, 1));
    expect(wilson(0, 0)).toBe(0);
  });
});

describe("threads, profiles and links", () => {
  test("posts appear in the trend's thread with the caller's handle", async () => {
    const p = { identifier: "topic:openai", body: "GPT launch is everywhere", replyTo: null, callId: null, issuedAt: Math.floor(now / 1000) };
    expect((await post("/posts", { ...p, caller: identity.address, signature: await identity.signMessage({ message: postMessage(p) }) })).status).toBe(201);
    const prof = { handle: "trendwatcher", bio: "attention trader", issuedAt: Math.floor(now / 1000) };
    const res = await app.request("/callers/me", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...prof, caller: identity.address, signature: await identity.signMessage({ message: profileMessage(prof) }) }) });
    expect(res.status).toBe(200);
    const taken = await app.request("/callers/me", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...prof, caller: other.address, signature: await other.signMessage({ message: profileMessage(prof) }) }) });
    expect(taken.status).toBe(409);
    const thread = (await (await app.request("/trends/topic:openai/thread")).json()) as { posts: Array<{ handle: string; body: string }> };
    expect(thread.posts[0]).toMatchObject({ handle: "trendwatcher", body: "GPT launch is everywhere" });
    expect(((await (await app.request("/callers/trendwatcher")).json()) as { caller: { address: string } }).caller.address).toBe(identity.address.toLowerCase());
    // No such caller: a 404, or an empty answer when the client asks for it as optional.
    expect((await app.request("/callers/nobody_here")).status).toBe(404);
    const optional = await app.request("/callers/nobody_here?optional=1");
    expect(optional.status).toBe(200);
    expect(await optional.json()).toEqual({ caller: null });
  });

  test("linking needs the identity's signature and the account passkey's approval, never a session key's", async () => {
    await sql`TRUNCATE owner_approvals`;
    const issuedAt = Math.floor(now / 1000);
    const message = linkMessage(identity.address, account.address, issuedAt);
    const approve = async (who = identity) => passkey.approve(account.address, ownerRequests.linkIdentity(who.address), (await approvals.issue(account.address, "link-identity"))!);
    const good = { identity: identity.address, account: account.address, issuedAt, identitySignature: await identity.signMessage({ message }) };
    // The former session-key signature alone is refused, readably.
    const bySession = await post("/callers/link", { ...good, signer: other.address, accountSignature: await other.signMessage({ message }) });
    expect(bySession.status).toBe(403);
    expect(await bySession.json()).toEqual({ error: "approve this with your passkey", code: "owner_approval" });
    // The identity must sign too, and the approval must be for this identity.
    expect((await post("/callers/link", { ...good, identitySignature: await other.signMessage({ message }), approval: await approve() })).status).toBe(401);
    expect((await post("/callers/link", { ...good, approval: await approve(other) })).status).toBe(403);
    const approval = await approve();
    expect((await post("/callers/link", { ...good, approval })).status).toBe(200);
    expect((await sql<{ linked_account: string }[]>`SELECT linked_account FROM callers WHERE address = ${identity.address.toLowerCase()}`)[0]!.linked_account).toBe(account.address.toLowerCase());
    // Spent: replaying the same approval is refused.
    expect((await post("/callers/link", { ...good, approval })).status).toBe(403);
    // An account linked to one caller cannot be claimed by another, and no approval is spent asking.
    const otherMessage = linkMessage(other.address, account.address, issuedAt);
    expect((await post("/callers/link", { identity: other.address, account: account.address, issuedAt, identitySignature: await other.signMessage({ message: otherMessage }), approval: await approve(other) })).status).toBe(409);
  });
});

describe("moderation", () => {
  const ADMIN = "0x00000000000000000000000000000000000000ad";
  const mod = () => {
    const m = new Hono<{ Variables: { admin: string } }>();
    m.use("*", async (c, next) => {
      c.set("admin", ADMIN);
      await next();
    });
    m.route("/", moderationRoutes({ sql }));
    return m;
  };
  const send = (path: string, body: unknown) => mod().request(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

  test("renames a caller as profile metadata and logs the old profile", async () => {
    const prof = { handle: "e2e_xyz", bio: "suite", issuedAt: Math.floor(now / 1000) };
    await app.request("/callers/me", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...prof, caller: identity.address, signature: await identity.signMessage({ message: profileMessage(prof) }) }) });
    const prof2 = { handle: "taken_one", bio: "", issuedAt: Math.floor(now / 1000) };
    await app.request("/callers/me", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...prof2, caller: other.address, signature: await other.signMessage({ message: profileMessage(prof2) }) }) });
    const who = identity.address.toLowerCase();
    expect((await send(`/social/callers/${who}/profile`, { handle: "Bad Handle", reason: "x" })).status).toBe(400);
    expect((await send(`/social/callers/${who}/profile`, { handle: "maya_reads", bio: "Reads attention early." })).status).toBe(400);
    expect((await send(`/social/callers/${who}/profile`, { handle: "taken_one", reason: "test handle" })).status).toBe(409);
    expect((await send("/social/callers/0x00000000000000000000000000000000000000ff/profile", { handle: "nobody_1", reason: "x" })).status).toBe(404);
    const res = await send(`/social/callers/${who}/profile`, { handle: "maya_reads", bio: "Reads attention early.", reason: "test handle from the end-to-end suite" });
    expect(res.status).toBe(200);
    const profile = (await (await app.request("/callers/maya_reads")).json()) as { caller: { address: string; bio: string } };
    expect(profile.caller).toMatchObject({ address: who, bio: "Reads attention early." });
    const log = await sql<{ admin: string; action: string; before: { address: string; handle: string; bio: string } }[]>`SELECT admin, action, before FROM moderation_log`;
    expect([...log]).toEqual([{ admin: ADMIN, action: "rename_caller", before: { address: who, handle: "e2e_xyz", bio: "suite" } }]);
    // The owner can still change it with their own key afterwards.
    const prof3 = { handle: "maya_again", bio: "", issuedAt: Math.floor(now / 1000) };
    expect((await app.request("/callers/me", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...prof3, caller: identity.address, signature: await identity.signMessage({ message: profileMessage(prof3) }) }) })).status).toBe(200);
  });

  test("removes a signed call or post from every public view and keeps the original in the log", async () => {
    const created = (await (await call("up")).json()) as { call: { id: number } };
    const p = { identifier: "topic:openai", body: "junk text", replyTo: null, callId: created.call.id, issuedAt: Math.floor(now / 1000) };
    const posted = (await (await post("/posts", { ...p, caller: identity.address, signature: await identity.signMessage({ message: postMessage(p) }) })).json()) as { post: { id: number } };
    expect((await send(`/social/posts/${posted.post.id}/remove`, {})).status).toBe(400);
    expect((await send("/social/posts/abc/remove", { reason: "x" })).status).toBe(400);
    expect((await send(`/social/posts/${posted.post.id}/remove`, { reason: "test content" })).status).toBe(200);
    expect((await send(`/social/posts/${posted.post.id}/remove`, { reason: "test content" })).status).toBe(404);
    expect((await send(`/social/calls/${created.call.id}/remove`, { reason: "test content" })).status).toBe(200);
    const thread = (await (await app.request("/trends/topic:openai/thread")).json()) as { posts: unknown[]; calls: unknown[] };
    expect(thread).toEqual({ posts: [], calls: [] });
    const board = (await (await app.request("/callers/leaderboard")).json()) as { callers: unknown[] };
    expect(board.callers).toEqual([]);
    const log = await sql<{ action: string; target: string; before: { body?: string; signature: string } }[]>`SELECT action, target, before FROM moderation_log ORDER BY id`;
    expect(log.map((l) => [l.action, l.target])).toEqual([["remove_post", `posts:${posted.post.id}`], ["remove_call", `calls:${created.call.id}`]]);
    expect(log[0]!.before.body).toBe("junk text");
    expect(log[1]!.before.signature).toMatch(/^0x/);
    const listed = (await (await mod().request(`/social/content?caller=${identity.address.toLowerCase()}`)).json()) as { calls: unknown[]; posts: unknown[] };
    expect(listed).toEqual({ calls: [], posts: [] });
  });
});

describe("vault", () => {
  async function session(who = identity) {
    const issuedAt = Math.floor(now / 1000);
    const res = await post("/identity/session", { identity: who.address, issuedAt, signature: await who.signMessage({ message: identitySignInMessage(who.address, issuedAt) }) });
    return ((await res.json()) as { token: string }).token;
  }
  test("stores ciphertext per identity, forward-only versions, invisible to others", async () => {
    const token = await session();
    const auth = { authorization: `Bearer ${token}` };
    const put = (version: number, ciphertext: string) =>
      app.request("/vault/strategy/btc-breakout", { method: "PUT", headers: { "content-type": "application/json", ...auth }, body: JSON.stringify({ ciphertext, iv: "AAAAAAAAAAAAAAAA", version }) });
    expect((await put(1, "c2VhbGVk")).status).toBe(200);
    expect((await put(2, "bmV3ZXI")).status).toBe(200);
    expect((await put(2, "c3RhbGU")).status).toBe(409);
    const items = (await (await app.request("/vault", { headers: auth })).json()) as { items: Array<{ ciphertext: string; version: number }> };
    expect(items.items).toEqual([expect.objectContaining({ ciphertext: "bmV3ZXI", version: 2 })]);
    const theirs = (await (await app.request("/vault", { headers: { authorization: `Bearer ${await session(other)}` } })).json()) as { items: unknown[] };
    expect(theirs.items).toEqual([]);
    expect((await app.request("/vault")).status).toBe(401);
  });
});

describe("notifications", () => {
  test("each Autopilot event notifies the owner's subscribed devices once", async () => {
    const sent: Array<{ endpoint: string; payload: unknown }> = [];
    const push = new Push(sql, { publicKey: "p".repeat(87), privateKey: "k".repeat(43), subject: "mailto:ops@example.org" }, {
      send: async (sub, payload) => {
        sent.push({ endpoint: sub.endpoint, payload: JSON.parse(payload) });
        return { statusCode: 201 };
      },
    });
    await push.subscribe(account.address, { endpoint: "https://fcm.googleapis.com/fcm/send/1", p256dh: "x".repeat(87), auth: "y".repeat(22), topics: ["autopilot"] });
    await push.subscribe(account.address, { endpoint: "https://fcm.googleapis.com/fcm/send/2", p256dh: "x".repeat(87), auth: "y".repeat(22), topics: ["calls"] });
    const dispatcher = new Dispatcher(sql, push);
    await dispatcher.tick(); // starts the cursors at the present
    const owner = account.address.toLowerCase();
    await sql`INSERT INTO autopilot_audit (owner, rule_id, event, detail) VALUES (${owner}, 7, 'order_filled', ${sql.json({ orderId: 1, action: "open", side: "long", price: 80_000 } as never)}), (${owner}, 7, 'waiting', '{}')`;
    expect(await dispatcher.tick()).toEqual({ notified: 1 });
    expect(sent).toEqual([{ endpoint: "https://fcm.googleapis.com/fcm/send/1", payload: { title: "Autopilot: opened long", body: "Filled at 80000", url: "/autopilot/7", tag: "order-1" } }]);
    expect(await dispatcher.tick()).toEqual({ notified: 0 });
  });

  test("a copy's loss cap notifies its follower on the copy topic", () => {
    const n = auditNotification({ id: "1", owner: "0xf", rule_id: null, follow_id: "4", event: "copy_loss_cap", detail: { leader: "0xb", openPnlAusd: -12.5, capAusd: 10, positions: 2 } });
    expect(n).toEqual({
      topic: "copy",
      payload: { title: "Copy trade: loss cap reached", body: "Your open copies were down 12.50 AUSD against a 10.00 AUSD cap. Autopilot is closing them and paused this follow.", url: "/copy", tag: "loss-cap-4" },
    });
  });

  test("drops subscriptions the push service says are gone", async () => {
    const push = new Push(sql, { publicKey: "p", privateKey: "k", subject: "mailto:x@y.z" }, { send: async () => Promise.reject(Object.assign(new Error("gone"), { statusCode: 410 })) });
    await push.subscribe(account.address, { endpoint: "https://updates.push.services.mozilla.com/wpush/v2/gone", p256dh: "x", auth: "y", topics: ["autopilot"] });
    expect(await push.notify(account.address, "autopilot", { title: "t", body: "b", url: "/" })).toBe(0);
    expect(await sql`SELECT 1 FROM push_subscriptions`).toHaveLength(0);
  });

  test("accept only browser push services over https on the default port", () => {
    for (const ok of [
      "https://fcm.googleapis.com/fcm/send/abc:def",
      "https://updates.push.services.mozilla.com/wpush/v2/gAAAA",
      "https://web.push.apple.com/QGc1",
      "https://wns2-par02p.notify.windows.com/w/?token=AwYAAAB",
      "https://fcm.googleapis.com:443/fcm/send/x",
    ]) {
      expect(isPushEndpoint(ok)).toBe(true);
    }
    for (const bad of [
      "http://fcm.googleapis.com/fcm/send/x",
      "https://fcm.googleapis.com:8443/fcm/send/x",
      "https://10.0.0.5:8443/hook",
      "https://user:pw@fcm.googleapis.com/fcm/send/x",
      "https://fcm.googleapis.com.evil.example/fcm/send/x",
      "https://evil.example/notify.windows.com",
      "https://notify.windows.com.evil.example/w",
      "https://fcm.googleapis.com./fcm/send/x",
      "not a url",
    ]) {
      expect(isPushEndpoint(bad)).toBe(false);
    }
  });

  test("an endpoint stays with the account that holds it, and stored endpoints elsewhere are dropped unsent", async () => {
    const sent: string[] = [];
    const push = new Push(sql, { publicKey: "p", privateKey: "k", subject: "mailto:x@y.z" }, {
      send: async (sub) => {
        sent.push(sub.endpoint);
        return { statusCode: 201 };
      },
    });
    const endpoint = "https://fcm.googleapis.com/fcm/send/shared";
    expect(await push.subscribe(account.address, { endpoint, p256dh: "a", auth: "b", topics: ["autopilot"] })).toBe(true);
    // Someone who learns the endpoint cannot move it to their account.
    expect(await push.subscribe(other.address, { endpoint, p256dh: "evil", auth: "evil", topics: ["autopilot"] })).toBe(false);
    expect([...(await sql`SELECT account, p256dh FROM push_subscriptions WHERE endpoint = ${endpoint}`)]).toEqual([{ account: account.address.toLowerCase(), p256dh: "a" }]);
    // The owner may update it.
    expect(await push.subscribe(account.address, { endpoint, p256dh: "c", auth: "d", topics: ["calls"] })).toBe(true);
    expect((await sql<{ p256dh: string }[]>`SELECT p256dh FROM push_subscriptions WHERE endpoint = ${endpoint}`)[0]!.p256dh).toBe("c");
    // A row from before endpoints were checked is deleted, never posted to.
    await sql`INSERT INTO push_subscriptions (endpoint, account, p256dh, auth, topics) VALUES ('https://10.0.0.5:8443/hook', ${account.address.toLowerCase()}, 'x', 'y', '{calls}')`;
    expect(await push.notify(account.address, "calls", { title: "t", body: "b", url: "/" })).toBe(1);
    expect(sent).toEqual([endpoint]);
    expect(await sql`SELECT 1 FROM push_subscriptions WHERE endpoint = 'https://10.0.0.5:8443/hook'`).toHaveLength(0);
  });
});

describe("status", () => {
  test("reports services, the oracle and the chain head as up or down", async () => {
    const services = parseServices("keeper=http://k/health, relayer=http://r/v1/health,bad");
    expect(services.map((s) => s.name)).toEqual(["keeper", "relayer"]);
    const fetchImpl = (async (url: string) => new Response("{}", { status: url.includes("k/") ? 200 : 503 })) as unknown as typeof fetch;
    const s = await status(chain, services, { oracleStaleSec: 600, fetchImpl }, T);
    expect(s.services.map((x) => [x.name, x.ok])).toEqual([["keeper", true], ["relayer", false]]);
    expect(s.oracle).toEqual({ ok: true, lastRunAgeSec: 60, staleTrends: 0 });
    expect(s.chain).toMatchObject({ ok: true, ageSec: 2 });
    expect(s.ok).toBe(false);
  });
});

export { verifyMessage };
