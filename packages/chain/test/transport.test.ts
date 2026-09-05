import { afterEach, describe, expect, test } from "bun:test";
import { createPublicClient } from "viem";
import { pacedHttp, RateLimiter } from "../src/transport";

let stop: (() => void) | null = null;
afterEach(() => stop?.());

describe("RateLimiter", () => {
  test("paces requests to the configured rate after the burst", async () => {
    const limiter = new RateLimiter(20, 2);
    const started = Date.now();
    await Promise.all(Array.from({ length: 8 }, () => limiter.take()));
    // Two go at once; six more at 20 per second need about 300 ms.
    expect(Date.now() - started).toBeGreaterThanOrEqual(250);
    expect(Date.now() - started).toBeLessThan(800);
  });
});

describe("pacedHttp", () => {
  test("retries a rate-limited JSON-RPC response and returns the eventual result", async () => {
    let calls = 0;
    const server = Bun.serve({
      port: 0,
      async fetch(req) {
        const body = (await req.json()) as { id: number };
        calls++;
        if (calls <= 2) return Response.json({ jsonrpc: "2.0", id: body.id, error: { code: -32007, message: "requests limited to 15/sec" } });
        return Response.json({ jsonrpc: "2.0", id: body.id, result: "0x2a" });
      },
    });
    stop = () => server.stop(true);
    const client = createPublicClient({ transport: pacedHttp(`http://localhost:${server.port}`, { requestsPerSecond: 50 }) });
    expect(await client.getBlockNumber({ cacheTime: 0 })).toBe(42n);
    expect(calls).toBe(3);
  });

  test("retries HTTP 429 and server errors, and gives up after the configured attempts", async () => {
    let calls = 0;
    const server = Bun.serve({
      port: 0,
      fetch() {
        calls++;
        return new Response("slow down", { status: 429 });
      },
    });
    stop = () => server.stop(true);
    const client = createPublicClient({ transport: pacedHttp(`http://localhost:${server.port}`, { requestsPerSecond: 50, attempts: 3 }) });
    await expect(client.getBlockNumber({ cacheTime: 0 })).rejects.toThrow();
    expect(calls).toBe(3);
  });
});
