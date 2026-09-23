import { createServer, type Server } from "node:http";
import { describe, expect, it } from "vitest";
import { rpcUrls, viewClient } from "../src/lib/rpc";
import { addr, at, CHAIN, delegate, newIndexer, PASSKEY_IMPL_V2, rpc, setCode, tx } from "./helpers";

const GENUINE = addr(0x7a);
const CONTRACT = addr(0x7b);
const OTHER_DELEGATE = addr(0x7c);
const SWITCHER = addr(0x7d);
const OLD_STATE = addr(0x7e);
const EVIL_IMPL = addr(0xe7);
const VERSION_2 = addr(0x7f);

delegate(GENUINE);
// A sign-up on PasskeyAccount version 2.
delegate(VERSION_2, PASSKEY_IMPL_V2);
// A contract of its own that emits PasskeyAccount's event.
setCode(CONTRACT, "0x6080604052348015600e575f80fd5b50");
// An EOA delegated to other code that emits the event.
delegate(OTHER_DELEGATE, EVIL_IMPL);
// Emits the event from other code, then re-delegates to PasskeyAccount later on.
delegate(SWITCHER, EVIL_IMPL);
delegate(SWITCHER, undefined, 50);
delegate(OLD_STATE);

const initialized = (account: `0x${string}`, block: number) =>
  ({
    contract: "PasskeyAccount",
    event: "Initialized",
    srcAddress: account,
    ...at(block),
    params: { ownerX: `0x${"01".repeat(32)}`, ownerY: `0x${"02".repeat(32)}` },
  }) as const;

describe("PasskeyAccount", () => {
  it("counts an address as a Trendr account only if it ran PasskeyAccount when the event was emitted", async (t) => {
    const indexer = newIndexer();
    await indexer.process({
      chains: {
        [CHAIN]: {
          simulate: [
            initialized(CONTRACT, 1),
            initialized(OTHER_DELEGATE, 2),
            initialized(SWITCHER, 3),
            initialized(GENUINE, 4),
            initialized(VERSION_2, 4),
            // A spoofer's Perpl account is not a Trendr account's.
            {
              contract: "PerplExchange",
              event: "AccountCreated",
              ...at(5, 0, tx(5)),
              params: { account: OTHER_DELEGATE, id: 2001n },
            },
          ],
        },
      },
    });

    t.expect(await indexer.Account.getOrThrow(GENUINE)).toMatchObject({ kind: "PASSKEY", isPasskey: true });
    t.expect(await indexer.Account.getOrThrow(VERSION_2)).toMatchObject({ kind: "PASSKEY", isPasskey: true });
    for (const spoofer of [CONTRACT, OTHER_DELEGATE, SWITCHER]) {
      t.expect(await indexer.Account.get(spoofer)).toBeUndefined();
    }
    t.expect(await indexer.Protocol.getOrThrow("trendr")).toMatchObject({ passkeyAccountCount: 2 });
    t.expect(await indexer.PerplAccount.getOrThrow("2001")).toMatchObject({ isTrendr: false, owner_id: undefined });
  });

  it("reads the latest code when the node no longer serves the event's block", async (t) => {
    const indexer = newIndexer();
    const calls = rpc.getCodeCalls;
    rpc.historicalStateMissing = true;
    try {
      await indexer.process({ chains: { [CHAIN]: { simulate: [initialized(OLD_STATE, 6)] } } });
    } finally {
      rpc.historicalStateMissing = false;
    }
    // One refused read at the block, one at the latest.
    t.expect(rpc.getCodeCalls - calls).toBe(2);
    t.expect(await indexer.Account.getOrThrow(OLD_STATE)).toMatchObject({ kind: "PASSKEY", isPasskey: true });
  });
});

describe("view call RPCs", () => {
  it("tries the configured RPC first, then the public endpoints, and none in tests", () => {
    expect(rpcUrls(10143, { ENVIO_RPC_URL_10143: "https://example.invalid" })).toEqual([
      "https://example.invalid",
      "https://testnet-rpc.monad.xyz",
      "https://rpc-testnet.monadinfra.com",
      "https://rpc.ankr.com/monad_testnet",
    ]);
    expect(rpcUrls(10143, { ENVIO_RPC_URL_10143: "https://testnet-rpc.monad.xyz" })[0]).toBe(
      "https://testnet-rpc.monad.xyz",
    );
    expect(rpcUrls(10143, { ENVIO_RPC_URL_10143: "http://127.0.0.1:1", ENVIO_PUBLIC_RPC_FALLBACK: "off" })).toEqual([
      "http://127.0.0.1:1",
    ]);
  });
});

/** A JSON-RPC endpoint on a free local port that answers every request with `reply`. */
async function endpoint(
  reply: (body: { id: number }) => { status: number; json?: unknown },
): Promise<{ url: string; hits: () => number; server: Server }> {
  let hits = 0;
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      hits++;
      const parsed = JSON.parse(raw) as { id: number } | { id: number }[];
      const answer = (b: { id: number }) => reply(b);
      const out = Array.isArray(parsed) ? parsed.map(answer) : answer(parsed);
      const status = Array.isArray(out) ? (out[0]?.status ?? 200) : out.status;
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(Array.isArray(out) ? out.map((o) => o.json) : (out.json ?? { error: "down" })));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as { port: number };
  return { url: `http://127.0.0.1:${port}`, hits: () => hits, server };
}

describe("view call failover", () => {
  it("moves a read to the next endpoint when one fails or rate limits", async () => {
    const down = await endpoint(() => ({ status: 503 }));
    const limited = await endpoint(() => ({ status: 429 }));
    const good = await endpoint((b) => ({ status: 200, json: { jsonrpc: "2.0", id: b.id, result: "0x2a" } }));
    try {
      const block = await viewClient([down.url, limited.url, good.url]).getBlockNumber({ cacheTime: 0 });
      expect(block).toBe(42n);
      expect(down.hits()).toBeGreaterThan(0);
      expect(limited.hits()).toBeGreaterThan(0);
    } finally {
      for (const e of [down, limited, good]) e.server.close();
    }
  });
});
