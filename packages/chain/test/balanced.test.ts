import { afterEach, describe, expect, test } from "bun:test";
import { createPublicClient, encodeErrorResult, parseAbi } from "viem";
import { balancedHttp, EndpointPool, isEndpointFailure, providerOf, redactUrl, redactUrls } from "../src/balanced";
import { MonadRealtime } from "../src/realtime";

type Mode = "ok" | "500" | "429" | "limited" | "revert" | "down";
let servers: { stop: (force?: boolean) => void }[] = [];
afterEach(() => {
  for (const s of servers) s.stop(true);
  servers = [];
});

/** A fake JSON-RPC endpoint answering eth_blockNumber with its own number, in a chosen mode. */
function endpoint(n: number, mode: () => Mode) {
  const hits = { count: 0 };
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      hits.count++;
      const body = (await req.json()) as { id: number; method: string };
      const m = mode();
      if (m === "500") return new Response("boom", { status: 500 });
      if (m === "429") return new Response("slow down", { status: 429 });
      if (m === "limited") return Response.json({ jsonrpc: "2.0", id: body.id, error: { code: -32007, message: "requests limited to 15/sec" } });
      if (m === "revert") {
        const data = encodeErrorResult({ abi: parseAbi(["error Nope()"]), errorName: "Nope" });
        return Response.json({ jsonrpc: "2.0", id: body.id, error: { code: 3, message: "execution reverted", data } });
      }
      return Response.json({ jsonrpc: "2.0", id: body.id, result: `0x${n.toString(16)}` });
    },
  });
  servers.push(server);
  return { url: mode() === "down" ? "http://127.0.0.1:1" : `http://localhost:${server.port}`, hits };
}

const client = (urls: string[], cooldownMs = 50) => createPublicClient({ transport: balancedHttp(urls, { requestsPerSecond: 1000, cooldownMs }) });

describe("balancedHttp", () => {
  test("rotates requests across healthy endpoints", async () => {
    const a = endpoint(1, () => "ok");
    const b = endpoint(2, () => "ok");
    const c = endpoint(3, () => "ok");
    const rpc = client([a.url, b.url, c.url]);
    const seen = [];
    for (let i = 0; i < 6; i++) seen.push(await rpc.getBlockNumber({ cacheTime: 0 }));
    expect(new Set(seen)).toEqual(new Set([1n, 2n, 3n]));
    expect([a.hits.count, b.hits.count, c.hits.count]).toEqual([2, 2, 2]);
  });

  test("fails over on server errors, HTTP 429, JSON-RPC rate limits and dead endpoints", async () => {
    for (const bad of ["500", "429", "limited", "down"] as const) {
      const a = endpoint(1, () => bad);
      const b = endpoint(2, () => "ok");
      const rpc = client([a.url, b.url]);
      for (let i = 0; i < 4; i++) expect(await rpc.getBlockNumber({ cacheTime: 0 })).toBe(2n);
    }
  });

  test("benches a failing endpoint, then tries it again after the cooldown", async () => {
    let mode: Mode = "500";
    const a = endpoint(1, () => mode);
    const b = endpoint(2, () => "ok");
    const rpc = client([a.url, b.url], 100);
    for (let i = 0; i < 6; i++) await rpc.getBlockNumber({ cacheTime: 0 });
    // One failure benched it; the other five went straight to the healthy endpoint.
    expect(a.hits.count).toBe(1);
    mode = "ok";
    await Bun.sleep(150);
    const seen = new Set();
    for (let i = 0; i < 4; i++) seen.add(await rpc.getBlockNumber({ cacheTime: 0 }));
    expect(seen).toEqual(new Set([1n, 2n]));
  });

  test("returns a revert at once instead of asking another node", async () => {
    const a = endpoint(1, () => "revert");
    const b = endpoint(2, () => "revert");
    const rpc = client([a.url, b.url]);
    await expect(rpc.call({ to: "0x0000000000000000000000000000000000000001", data: "0x" })).rejects.toThrow();
    expect(a.hits.count + b.hits.count).toBe(1);
  });

  test("a lone endpoint retries a rate limit or server error with backoff instead of failing at once", async () => {
    for (const bad of ["429", "500", "limited"] as const) {
      // The first two requests are refused, the third answers.
      const box = { hits: { count: 0 } };
      const a = endpoint(7, () => (box.hits.count <= 2 ? bad : "ok"));
      box.hits = a.hits;
      expect(await client([a.url]).getBlockNumber({ cacheTime: 0 })).toBe(7n);
      expect(a.hits.count).toBe(3);
    }
  });

  test("reports when every endpoint fails", async () => {
    const a = endpoint(1, () => "500");
    const b = endpoint(2, () => "429");
    await expect(client([a.url, b.url]).getBlockNumber({ cacheTime: 0 })).rejects.toThrow();
  });
});

describe("EndpointPool", () => {
  test("doubles the cooldown while an endpoint keeps failing and resets on success", () => {
    let now = 0;
    const pool = new EndpointPool(["a", "b"], { cooldownMs: 1000, now: () => now });
    pool.failed(0);
    expect(pool.health[0]!.benchedUntil).toBe(1000);
    pool.failed(0);
    expect(pool.health[0]!.benchedUntil).toBe(2000);
    expect(pool.order()[0]).toBe(1);
    now = 2500;
    pool.succeeded(0);
    expect(pool.health[0]!.benchedUntil).toBe(0);
  });

  test("redacts credentials in reported URLs", () => {
    expect(redactUrl("https://monad-testnet.g.alchemy.com/v2/abcdefghijklmnopqrstuvwx")).toBe("https://monad-testnet.g.alchemy.com/v2/abcd...");
    // Errors quote request URLs inline; every one is cut short, the rest of the text is kept.
    expect(redactUrls('HTTP request failed.\nURL: https://some-name.monad-testnet.quiknode.pro/abcdef0123456789abcdef/ Details: {"error":"x"}')).toBe(
      'HTTP request failed.\nURL: https://some-name.monad-testnet.quiknode.pro/abcd.../ Details: {"error":"x"}',
    );
    expect(redactUrls("ws to wss://monad-testnet.g.alchemy.com/v2/abcdefghijklmnopqrstuvwx, retry")).toBe("ws to wss://monad-testnet.g.alchemy.com/v2/abcd..., retry");
    expect(redactUrls("no urls here")).toBe("no urls here");
    expect(providerOf("https://some-name.monad-testnet.quiknode.pro/abcdef0123456789abcdef/")).toBe("quiknode.pro");
    expect(isEndpointFailure(new Error("execution reverted"))).toBe(false);
  });

  test("a provider's plan limit fails over like an outage", () => {
    expect(isEndpointFailure(new Error("Under the Free tier plan, you can make eth_getLogs requests with up to a 10 block range."))).toBe(true);
    expect(isEndpointFailure(new Error("invalid argument 0: hex string without 0x prefix"))).toBe(false);
  });
});

describe("MonadRealtime endpoints", () => {
  test("moves to the next WebSocket endpoint when one drops", async () => {
    const opened: number[] = [];
    const make = (n: number) => {
      const s = Bun.serve({
        port: 0,
        fetch(req, srv) {
          return srv.upgrade(req) ? undefined : new Response("no", { status: 400 });
        },
        websocket: {
          open(ws) {
            opened.push(n);
            if (n === 1) ws.close();
          },
          message(ws, raw) {
            const msg = JSON.parse(String(raw));
            ws.send(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: "0x1" }));
          },
        },
      });
      servers.push(s);
      return `ws://localhost:${s.port}`;
    };
    const rt = new MonadRealtime([make(1), make(2)], { minBackoffMs: 20 }).onHeads(() => {}).start();
    for (let i = 0; i < 100 && !opened.includes(2); i++) await Bun.sleep(20);
    rt.stop();
    expect(opened.slice(0, 2)).toEqual([1, 2]);
  });
});
