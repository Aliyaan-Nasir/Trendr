import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { createTestIndexer } from "envio";

export const CHAIN = 10143;
export const START_BLOCK = 69_452_198;
/** Block time of the first simulated block; each later block is one second on. */
export const T0 = 1_791_500_000;

/** Configured Testnet addresses (config.yaml), lowercase. */
export const CONTRACTS = {
  registry: "0xa24f779b6ae73bd7d6d1a2fe47b9ef9ea7bd805c",
  outcomeMarkets: "0x8eaa2dd6b3890ead77ba9f555378ed11310c3ebf",
  listing: "0x774affcb8f4b095100b3c46bf562214bf30e9e7e",
  perp: "0xeec85f72e63ee5daf66d285182241244110e0c84",
  curve: "0x597e4ad49b2430ed8d4543eb46f94189231534df",
  venue: "0x7d9e0b3145882e513ee24d912db1f4479ddbc7d3",
  curation: "0x529d9b1e685bd943053dc356d40a368639646168",
  spot: "0x8daba0d411d3530819b5fd1520a79050c0feb374",
  /** TrendrSpot before session trades kept to the attention-implied band; still indexed. */
  previousSpot: "0x0824e10847a4bbfffcb255a1770995a1cfb0a780",
  kuruRouter: "0x7efbe105ca7415de98f96622173458ac1c054630",
  perpl: "0x1964c32f0be608e7d29302aff5e61268e72080cc",
  ausd: "0xa9012a055bd4e0edff8ce09f960291c09d5322dc",
  kuruMargin: "0xd029c2d98ff85d8f64799017fe00a59b1159ce02",
  bot: "0x6cfacb4c9a1b63cbc87750ec471ce194bfea0211",
} as const;

export type Hex = `0x${string}`;

/** A distinct test address. */
export const addr = (n: number): Hex => `0x${n.toString(16).padStart(40, "0")}`;
/** A distinct bytes32 id. */
export const id32 = (n: number): string => `0x${n.toString(16).padStart(64, "0")}`;
/** A distinct transaction hash. */
export const tx = (n: number): string => `0x${n.toString(16).padStart(64, "f")}`;

/** AUSD (6 decimals) and outcome token amounts from a decimal number. */
export const units = (value: number, decimals = 6): bigint => BigInt(Math.round(value * 10 ** decimals));

/**
 * Block, time, log index and transaction hash of a simulated event `n` blocks after the start
 * block. Handlers select the hash with their own `fields` option, which the simulate types (built
 * from config-level field_selection) cannot see, hence the cast.
 */
export const at = (n: number, logIndex?: number, hash?: string) => ({
  block: { number: START_BLOCK + n, timestamp: T0 + n },
  ...(logIndex === undefined ? {} : { logIndex }),
  ...(hash === undefined ? {} : { transaction: { hash } as {} }),
});

export const newIndexer = () => createTestIndexer();

/** The PasskeyAccount implementation Testnet accounts delegate to (contracts/deployments/10143.json). */
export const PASSKEY_IMPL = "0xdf6c6019c70fc321211a0483e74e2dde839fa955" as Hex;
/** PasskeyAccount version 2, which new accounts delegate to. */
export const PASSKEY_IMPL_V2 = "0xa3023591e43085c782444937f96f2b82e98b2524" as Hex;

/**
 * A local JSON-RPC node for the reads handlers make, so tests never reach the network: account code
 * by address and from which block it holds. Unknown addresses have no code.
 */
const codes = new Map<string, Array<{ fromBlock: number; code: string }>>();
export const rpc = { historicalStateMissing: false, getCodeCalls: 0 };

export function setCode(address: string, code: string, fromBlock = 0) {
  const list = codes.get(address.toLowerCase()) ?? [];
  list.push({ fromBlock, code });
  list.sort((a, b) => a.fromBlock - b.fromBlock);
  codes.set(address.toLowerCase(), list);
}

/** An EOA running `implementation` under EIP-7702 from `fromBlock` (relative to the start block). */
export const delegate = (address: string, implementation: string = PASSKEY_IMPL, fromBlock = 0) =>
  setCode(address, `0xef0100${implementation.slice(2)}`, START_BLOCK + fromBlock);

function codeAt(address: string, block: number): string {
  const list = codes.get(address.toLowerCase()) ?? [];
  return list.filter((c) => c.fromBlock <= block).at(-1)?.code ?? "0x";
}

type RpcRequest = { id: number; method: string; params: unknown[] };
function answer(req: RpcRequest) {
  if (req.method === "eth_getCode") {
    rpc.getCodeCalls++;
    const [address, tag] = req.params as [string, string];
    if (tag !== "latest" && rpc.historicalStateMissing) {
      return { jsonrpc: "2.0", id: req.id, error: { code: -32000, message: "state not available" } };
    }
    return {
      jsonrpc: "2.0",
      id: req.id,
      result: codeAt(address, tag === "latest" ? Number.MAX_SAFE_INTEGER : Number(tag)),
    };
  }
  return { jsonrpc: "2.0", id: req.id, error: { code: -32601, message: `${req.method} is not served in tests` } };
}

const server = createServer((req, res) => {
  let body = "";
  req.on("data", (chunk) => (body += chunk));
  req.on("end", () => {
    const parsed = JSON.parse(body) as RpcRequest | RpcRequest[];
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify(Array.isArray(parsed) ? parsed.map(answer) : answer(parsed)));
  });
});
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
server.unref();
process.env[`ENVIO_RPC_URL_${CHAIN}`] = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
process.env.ENVIO_PUBLIC_RPC_FALLBACK = "off";

export const ZERO = "0x0000000000000000000000000000000000000000" as Hex;
