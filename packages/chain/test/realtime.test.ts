import { afterEach, describe, expect, test } from "bun:test";
import type { ServerWebSocket } from "bun";
import { type Head, MonadRealtime, type StreamLog } from "../src/realtime";

/** A fake Monad WebSocket endpoint that records subscriptions and lets tests push events. */
function fakeNode() {
  const sockets = new Set<ServerWebSocket<unknown>>();
  const subscriptions: { id: string; kind: string }[] = [];
  let counter = 0;
  const server = Bun.serve({
    port: 0,
    fetch(req, srv) {
      return srv.upgrade(req) ? undefined : new Response("no", { status: 400 });
    },
    websocket: {
      open(ws) {
        sockets.add(ws);
      },
      close(ws) {
        sockets.delete(ws);
      },
      message(ws, raw) {
        const msg = JSON.parse(String(raw));
        const id = `0x${(++counter).toString(16)}`;
        subscriptions.push({ id, kind: msg.params[0] });
        ws.send(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: id }));
      },
    },
  });
  const push = (kind: string, result: Record<string, unknown>) => {
    const sub = [...subscriptions].reverse().find((s) => s.kind === kind);
    for (const ws of sockets) ws.send(JSON.stringify({ jsonrpc: "2.0", method: "eth_subscription", params: { subscription: sub!.id, result } }));
  };
  return {
    url: `ws://localhost:${server.port}`,
    subscriptions,
    head: (n: number, state: string, blockId = `0xb${n}`) =>
      push("monadNewHeads", { number: `0x${n.toString(16)}`, hash: `0xh${n}`, blockId, timestamp: "0x10", commitState: state }),
    log: (n: number, index: number, state: string, blockId = `0xb${n}`) =>
      push("monadLogs", {
        address: "0x00000000000000000000000000000000000000aa",
        topics: ["0x01"],
        data: "0x",
        blockNumber: `0x${n.toString(16)}`,
        blockHash: `0xh${n}`,
        blockId,
        transactionHash: `0xt${n}${blockId}`,
        logIndex: `0x${index.toString(16)}`,
        commitState: state,
      }),
    drop: () => {
      for (const ws of sockets) ws.close();
    },
    stop: () => server.stop(true),
  };
}

const until = async (cond: () => boolean, ms = 3000) => {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error("timed out");
    await Bun.sleep(10);
  }
};

let cleanup: (() => void)[] = [];
afterEach(() => {
  for (const c of cleanup) c();
  cleanup = [];
});

describe("MonadRealtime", () => {
  test("delivers each head once, at Voted, never from an abandoned proposal", async () => {
    const node = fakeNode();
    const heads: Head[] = [];
    const rt = new MonadRealtime(node.url).onHeads((h) => heads.push(h)).start();
    cleanup.push(() => rt.stop(), node.stop);
    await until(() => node.subscriptions.length === 1);

    node.head(10, "Proposed", "0xloser");
    node.head(10, "Proposed", "0xwinner");
    node.head(10, "Voted", "0xwinner");
    node.head(10, "Finalized", "0xwinner");
    node.head(11, "Proposed");
    node.head(12, "Finalized"); // skipped Voted
    node.head(11, "Voted"); // late: older than what was delivered
    await until(() => heads.length >= 2);
    await Bun.sleep(50);
    expect(heads.map((h) => [h.number, h.blockId, h.commitState])).toEqual([
      [10n, "0xwinner", "Voted"],
      [12n, "0xb12", "Finalized"],
    ]);
  });

  test("delivers logs once their block is voted", async () => {
    const node = fakeNode();
    const logs: StreamLog[] = [];
    const rt = new MonadRealtime(node.url).onLogs({ address: "0x00000000000000000000000000000000000000aa" }, (l) => logs.push(l)).start();
    cleanup.push(() => rt.stop(), node.stop);
    await until(() => node.subscriptions.length === 1);

    node.log(20, 0, "Proposed", "0xgone");
    node.log(20, 0, "Proposed");
    node.log(20, 1, "Proposed");
    node.log(20, 0, "Voted");
    node.log(20, 1, "Voted");
    node.log(20, 0, "Finalized");
    await until(() => logs.length >= 2);
    await Bun.sleep(50);
    expect(logs.map((l) => [l.blockNumber, l.logIndex, l.blockId])).toEqual([
      [20n, 0, "0xb20"],
      [20n, 1, "0xb20"],
    ]);
  });

  test("reconnects and subscribes again after the node drops the connection", async () => {
    const node = fakeNode();
    const heads: bigint[] = [];
    const rt = new MonadRealtime(node.url, { minBackoffMs: 20 }).onHeads((h) => heads.push(h.number)).start();
    cleanup.push(() => rt.stop(), node.stop);
    await until(() => node.subscriptions.length === 1);
    node.head(1, "Voted");
    await until(() => heads.length === 1);

    node.drop();
    await until(() => node.subscriptions.length === 2);
    node.head(2, "Voted");
    await until(() => heads.length === 2);
    expect(heads).toEqual([1n, 2n]);
    expect(rt.status.reconnects).toBe(1);
  });

  test("reconnects when the feed goes silent", async () => {
    const node = fakeNode();
    const rt = new MonadRealtime(node.url, { silenceMs: 150, minBackoffMs: 20 }).onHeads(() => {}).start();
    cleanup.push(() => rt.stop(), node.stop);
    await until(() => node.subscriptions.length === 1);
    await until(() => node.subscriptions.length >= 2, 3000);
    expect(rt.status.reconnects).toBeGreaterThanOrEqual(1);
  });
});
