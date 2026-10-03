import { afterEach, describe, expect, test } from "bun:test";
import { createPublicClient } from "viem";
import { describeError } from "../src/lib/account/AccountProvider";
import { createRelayerClient, RelayerError } from "../src/lib/account/relayer";
import { ApiError, autopilot, auth, setReauth, setUserToken } from "../src/lib/api";
import { nextEndpoint, readTransport } from "../src/lib/chain/transport";
import { rateLimitMessage, retryAfterSec, waitText } from "../src/lib/rate-limit";

/** How the app copes with refusals and outages: re-auth, rate limits and RPC failover. */

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
  setReauth(null);
  setUserToken(null);
});

type Reply = { status: number; body: unknown; headers?: Record<string, string> };
/** Answers each backend call from `reply`, recording the bearer token it carried. */
function backend(reply: (n: number, token: string | null) => Reply) {
  const seen: (string | null)[] = [];
  globalThis.fetch = (async (_url: string, init?: RequestInit) => {
    const token = (init?.headers as Record<string, string> | undefined)?.authorization?.replace("Bearer ", "") ?? null;
    seen.push(token);
    const r = reply(seen.length, token);
    return new Response(JSON.stringify(r.body), { status: r.status, headers: { "content-type": "application/json", ...r.headers } });
  }) as typeof fetch;
  return seen;
}

describe("signed-in calls", () => {
  test("a 401 signs in again once and retries with the new token", async () => {
    setUserToken("stale");
    let signIns = 0;
    setReauth(async () => {
      signIns++;
      setUserToken("fresh");
      return "fresh";
    });
    const seen = backend((_n, token) => (token === "fresh" ? { status: 200, body: { ok: true } } : { status: 401, body: { error: "session expired" } }));
    expect(await autopilot.rules()).toEqual({ ok: true } as never);
    expect(seen).toEqual(["stale", "fresh"]);
    expect(signIns).toBe(1);
  });

  test("concurrent 401s share one sign-in; a second 401 is not retried again", async () => {
    setUserToken("stale");
    let signIns = 0;
    setReauth(async () => {
      signIns++;
      await Bun.sleep(10);
      setUserToken("fresh");
      return "fresh";
    });
    backend(() => ({ status: 401, body: { error: "session expired" } }));
    const results = await Promise.all([autopilot.rules().catch((e: unknown) => e), autopilot.rules().catch((e: unknown) => e)]);
    expect(signIns).toBe(1);
    for (const r of results) expect((r as ApiError).status).toBe(401);
  });

  test("without a way to sign in again, the 401 stands", async () => {
    setUserToken("stale");
    backend(() => ({ status: 401, body: { error: "session expired" } }));
    const e = (await autopilot.rules().catch((x: unknown) => x)) as ApiError;
    expect(e).toBeInstanceOf(ApiError);
    expect(e.message).toBe("session expired");
  });
});

describe("rate limits", () => {
  test("Retry-After in seconds or as a date", () => {
    expect(retryAfterSec("42")).toBe(42);
    expect(retryAfterSec(new Date(Date.UTC(2026, 9, 11, 12, 1)).toUTCString(), Date.UTC(2026, 9, 11, 12, 0))).toBe(60);
    expect(retryAfterSec(null)).toBeNull();
    expect(retryAfterSec("soon")).toBeNull();
    expect([waitText(3), waitText(40), waitText(600), waitText(7_200)]).toEqual(["a few seconds", "40 seconds", "10 minutes", "2 hours"]);
  });

  test("a bare refusal says when to try again; a specific one keeps its reason", () => {
    expect(rateLimitMessage("too many requests", 120)).toBe("Too many requests. Try again in 2 minutes.");
    expect(rateLimitMessage("slow down", null)).toBe("Too many requests. Wait a moment and try again.");
    expect(rateLimitMessage("daily link limit reached for this account", null)).toBe("Daily link limit reached for this account.");
    expect(rateLimitMessage("link proposals are paused for today; try again tomorrow", null)).toBe("Link proposals are paused for today; try again tomorrow.");
    expect(rateLimitMessage("too many passkey approvals in progress; wait a few minutes", 300)).toBe("Too many passkey approvals in progress; wait a few minutes. Try again in 5 minutes.");
  });

  test("the backend's 429 becomes a readable ApiError with the wait, shown as is", async () => {
    backend(() => ({ status: 429, body: { error: "too many requests" }, headers: { "retry-after": "30" } }));
    const e = (await auth.session("0x1", "0x1", 1, "0x").catch((x: unknown) => x)) as ApiError;
    expect(e).toBeInstanceOf(ApiError);
    expect(e.status).toBe(429);
    expect(e.retryAfter).toBe(30);
    expect(e.message).toBe("Too many requests. Try again in 30 seconds.");
    expect(describeError(e)).toBe(e.message);
  });

  test("the relayer's refusals carry their wait into the message", async () => {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ error: "rate_limited", message: "too many requests" }), { status: 429, headers: { "retry-after": "20" } })) as unknown as typeof fetch;
    const e = (await createRelayerClient("http://relayer.test").status("0x1").catch((x: unknown) => x)) as RelayerError;
    expect(e).toBeInstanceOf(RelayerError);
    expect(e.retryAfter).toBe(20);
    expect(describeError(e)).toBe("Too many requests. Try again in 20 seconds.");
    expect(describeError(new RelayerError(429, "relayer_budget", "busy", 900))).toBe("Trendr is very busy right now. Try again in 15 minutes.");
    expect(describeError(new RelayerError(429, "relayer_budget", "busy"))).toBe("Trendr is very busy right now. Try again in a few minutes.");
  });
});

describe("RPC failover", () => {
  const servers: { stop: (force?: boolean) => void }[] = [];
  afterEach(() => {
    for (const s of servers.splice(0)) s.stop(true);
  });
  /** A JSON-RPC endpoint answering eth_blockNumber with `n`, or failing with `status`. */
  const endpoint = (n: number, status = 200) => {
    let hits = 0;
    const server = Bun.serve({
      port: 0,
      async fetch(req) {
        hits++;
        const body = (await req.json()) as { id: number } | { id: number }[];
        if (status !== 200) return new Response("unavailable", { status });
        const answer = (b: { id: number }) => ({ jsonrpc: "2.0", id: b.id, result: `0x${n.toString(16)}` });
        return Response.json(Array.isArray(body) ? body.map(answer) : answer(body));
      },
    });
    servers.push(server);
    return { url: `http://localhost:${server.port}`, hits: () => hits };
  };

  test("a read falls over from a rate-limited or failing endpoint to the next", async () => {
    const limited = endpoint(1, 429);
    const down = endpoint(2, 503);
    const good = endpoint(3);
    const client = createPublicClient({ transport: readTransport([limited.url, down.url, good.url]) });
    expect(await client.getBlockNumber({ cacheTime: 0 })).toBe(3n);
    expect(limited.hits()).toBeGreaterThan(0);
    expect(down.hits()).toBeGreaterThan(0);
  });

  test("the head stream moves to the next endpoint when one drops", () => {
    expect([nextEndpoint(0, 3), nextEndpoint(2, 3), nextEndpoint(0, 1), nextEndpoint(0, 0)]).toEqual([1, 0, 0, 0]);
  });
});
