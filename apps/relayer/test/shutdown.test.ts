import { describe, expect, test } from "bun:test";
import { drain } from "../src/shutdown";

/** SIGTERM on a redeploy: relays in flight answer, new requests are refused, and the wait is bounded. */
describe("drain", () => {
  test("lets a request in flight answer, then refuses new connections", async () => {
    let release!: () => void;
    const held = new Promise<void>((r) => {
      release = r;
    });
    const server = Bun.serve({
      port: 0,
      fetch: async () => {
        await held;
        return new Response("relayed");
      },
    });
    const url = `http://localhost:${server.port}/`;
    const inFlight = fetch(url).then((r) => r.text());
    await Bun.sleep(50);
    const drained = drain(server, 5_000);
    setTimeout(release, 100);
    expect(await inFlight).toBe("relayed");
    expect(await drained).toBe(true);
    await expect(fetch(url)).rejects.toThrow();
  });

  test("gives up after the drain window when a request never answers", async () => {
    const server = { stop: () => new Promise<void>(() => {}) };
    const started = Date.now();
    expect(await drain(server, 50)).toBe(false);
    expect(Date.now() - started).toBeLessThan(1_000);
  });
});
