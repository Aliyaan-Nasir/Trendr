import { describe, expect, test } from "bun:test";
import type { Sent } from "@trendr/chain";
import { deployments, tradingPermissions } from "@trendr/contracts";
import pino from "pino";
import { buildServer, type ServerOptions } from "../src/server";
import { RelayError, type RelayerService } from "../src/service";

const log = pino({ level: "silent" });
const d = deployments[10143]!;
const a = "0x00000000000000000000000000000000000000aa";
const word = `0x${"11".repeat(32)}`;
const sent: Sent = { hash: `0x${"ab".repeat(32)}`, status: "success", blockNumber: 1n, gasUsed: 1n, gasLimit: 1n, logs: [] };
const usage = { limits: {}, lastHour: { gas: 0, activations: 0 }, today: { accounts: 0, busiestAccountGas: 0, reverts: 0 }, coolingDown: 0, busyAccounts: 0 };

function server(service: Partial<RelayerService>, o: Partial<ServerOptions> = {}) {
  return buildServer({ service: { usage: async () => usage, ...service } as RelayerService, allowedOrigins: [], log, ...o });
}

/** Bun's server as Hono sees it: the socket peer of each request. */
const socket = (address: string) => ({ requestIP: () => ({ address, family: address.includes(":") ? "IPv6" : "IPv4", port: 40_000 }) });

const get = (app: ReturnType<typeof server>, peer: string, forwardedFor?: string) =>
  app.request("/v1/health", { headers: forwardedFor ? { "x-forwarded-for": forwardedFor } : {} }, socket(peer));

const post = (app: ReturnType<typeof server>, path: string, body: unknown, peer = "203.0.113.7") =>
  app.request(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }, socket(peer));

const sessionBody = { account: a, calls: [{ target: d.ausd, value: "0", data: "0x095ea7b3" }], sessionKey: a, deadline: "1", signature: "0x" };
const activateBody = {
  account: a,
  authorization: { address: d.passkeyAccount, chainId: 10143, nonce: 0, r: word, s: word, yParity: 0 },
  owner: { x: word, y: word },
  session: {
    key: a,
    validUntil: 1,
    dailyLimit: "1",
    permissions: tradingPermissions(d).map((p) => ({ target: p.target, selector: p.selector, recipientArg: p.recipientArg, guard: p.guard })),
  },
  deadline: "1",
  eoaSignature: "0x",
};
const upgradeBody = { account: a, authorization: activateBody.authorization, sessions: [activateBody.session], deadline: "1", eoaSignature: "0x" };

describe("client address", () => {
  test("without trusted proxies, X-Forwarded-For is ignored and the socket peer counts", async () => {
    const app = server({}, { perIpPerMinute: 2 });
    expect((await get(app, "198.51.100.9", "1.1.1.1")).status).toBe(200);
    expect((await get(app, "198.51.100.9", "2.2.2.2")).status).toBe(200);
    const refused = await get(app, "198.51.100.9", "3.3.3.3");
    expect(refused.status).toBe(429);
    // Two a minute: a token comes back within 30 seconds.
    expect(Number(refused.headers.get("retry-after"))).toBeGreaterThanOrEqual(1);
    expect(Number(refused.headers.get("retry-after"))).toBeLessThanOrEqual(30);
    expect((await get(app, "198.51.100.10", "3.3.3.3")).status).toBe(200);
  });

  test("behind one proxy, only the entry it appended counts", async () => {
    const app = server({}, { perIpPerMinute: 2, trustedProxyHops: 1 });
    // The proxy's own address is the socket peer for everyone.
    expect((await get(app, "10.0.0.2", "6.6.6.1, 203.0.113.7")).status).toBe(200);
    expect((await get(app, "10.0.0.2", "6.6.6.2, 203.0.113.7")).status).toBe(200);
    expect((await get(app, "10.0.0.2", "6.6.6.3, 203.0.113.7")).status).toBe(429);
    expect((await get(app, "10.0.0.2", "203.0.113.8")).status).toBe(200);
  });

  test("a real Bun server gives the socket peer, and a spoofed header changes nothing", async () => {
    const app = server({}, { perIpPerMinute: 1 });
    const bun = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: app.fetch });
    try {
      const url = `http://127.0.0.1:${bun.port}/v1/health`;
      expect((await fetch(url, { headers: { "x-forwarded-for": "1.1.1.1" } })).status).toBe(200);
      expect((await fetch(url, { headers: { "x-forwarded-for": "2.2.2.2" } })).status).toBe(429);
    } finally {
      await bun.stop(true);
    }
  });

  test("warns once when a proxy seems to be in front but no hops are trusted", async () => {
    const lines: string[] = [];
    const sink = pino({ level: "warn" }, { write: (line: string) => lines.push(line) });
    const app = server({}, { log: sink });
    await get(app, "10.0.0.2");
    expect(lines).toHaveLength(0);
    await get(app, "10.0.0.2", "203.0.113.7");
    await get(app, "10.0.0.2", "203.0.113.8");
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("TRUSTED_PROXY_HOPS");
    const trusted: string[] = [];
    const behindProxy = server({}, { log: pino({ level: "warn" }, { write: (line: string) => trusted.push(line) }), trustedProxyHops: 1 });
    await get(behindProxy, "10.0.0.2", "203.0.113.7");
    expect(trusted).toHaveLength(0);
  });

  test("IPv6 callers are limited by their /64", async () => {
    const app = server({}, { perIpPerMinute: 2 });
    expect((await get(app, "2001:db8:1:2::1")).status).toBe(200);
    expect((await get(app, "2001:db8:1:2::2")).status).toBe(200);
    expect((await get(app, "2001:db8:1:2:ffff::3")).status).toBe(429);
    expect((await get(app, "2001:db8:1:3::1")).status).toBe(200);
  });
});

describe("activation", () => {
  test("is limited per client address before the service sees it", async () => {
    let calls = 0;
    const app = server({ activate: async () => (calls++, sent) }, { activationsPerIpPerHour: 1 });
    expect((await post(app, "/v1/accounts/activate", activateBody)).status).toBe(200);
    const again = await post(app, "/v1/accounts/activate", { ...activateBody, account: "0x00000000000000000000000000000000000000bb" });
    expect(again.status).toBe(429);
    expect(await again.json()).toEqual({ error: "rate_limited", message: "too many requests of this kind from this address" });
    // One activation an hour: the next token is about an hour away.
    expect(Number(again.headers.get("retry-after"))).toBeGreaterThan(3_500);
    expect(calls).toBe(1);
    expect((await post(app, "/v1/accounts/activate", activateBody, "203.0.113.8")).status).toBe(200);
    // Other routes are not affected.
    const app2 = server({ executeSession: async () => sent }, { activationsPerIpPerHour: 1 });
    for (let i = 0; i < 3; i++) expect((await post(app2, "/v1/session/execute", sessionBody)).status).toBe(200);
  });
});

describe("upgrade", () => {
  test("takes one session whose permissions name their guards", async () => {
    let got: unknown = null;
    const app = server({ upgrade: async (i) => ((got = i), sent) });
    expect((await post(app, "/v1/accounts/upgrade", upgradeBody)).status).toBe(200);
    expect((got as { sessions: unknown[] }).sessions).toHaveLength(1);
    const unguarded = { ...upgradeBody, sessions: [{ ...activateBody.session, permissions: activateBody.session.permissions.map(({ guard: _, ...p }) => p) }] };
    expect((await post(app, "/v1/accounts/upgrade", unguarded)).status).toBe(400);
    expect((await post(app, "/v1/accounts/upgrade", { ...upgradeBody, sessions: [] })).status).toBe(400);
    expect((await post(app, "/v1/accounts/upgrade", { ...upgradeBody, sessions: [activateBody.session, activateBody.session] })).status).toBe(400);
  });

  test("shares the per-address activation limit", async () => {
    const app = server({ activate: async () => sent, upgrade: async () => sent }, { activationsPerIpPerHour: 1 });
    expect((await post(app, "/v1/accounts/activate", activateBody)).status).toBe(200);
    expect((await post(app, "/v1/accounts/upgrade", upgradeBody)).status).toBe(429);
  });
});

describe("refusals", () => {
  test("budget refusals carry their code and when to retry", async () => {
    const app = server({
      executeSession: async () => {
        throw new RelayError(429, "account_budget", "this account has used its gas allowance for today", 42);
      },
      executeOwner: async () => {
        throw new RelayError(409, "account_busy", "this account already has requests in flight; wait for them to finish");
      },
    });
    const refused = await post(app, "/v1/session/execute", sessionBody);
    expect(refused.status).toBe(429);
    expect(refused.headers.get("retry-after")).toBe("42");
    expect(await refused.json()).toEqual({ error: "account_budget", message: "this account has used its gas allowance for today" });
    const auth = { authenticatorData: "0x00", clientDataJSON: "{}", challengeIndex: "0", typeIndex: "0", r: word, s: word };
    const busy = await post(app, "/v1/owner/execute", { account: a, calls: sessionBody.calls, deadline: "1", auth });
    expect(busy.status).toBe(409);
    expect(busy.headers.get("retry-after")).toBeNull();
    expect(((await busy.json()) as { error: string }).error).toBe("account_busy");
  });
});
