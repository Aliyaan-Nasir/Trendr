import { attentionPerpAbi, trendrLensAbi } from "@trendr/contracts";
import { createPublicClient, decodeEventLog, type Hex, http, type Transport } from "viem";
import type { Call, Trend } from "@/lib/api";
import { BACKEND_URL, DEPLOYMENT, RPC_URL } from "@/lib/config";
import { attentionStory, baseIdentifier, trendName } from "@/lib/trends";
import type { PnlShare } from "./share";

/**
 * Server-side reads for the share pages and link cards. Each is cached briefly (cards are fetched
 * by crawlers in bursts) and fails soft: a card without data still renders.
 */

const REVALIDATE = 120;

async function getJson<T>(path: string): Promise<T | null> {
  try {
    const res = await fetch(`${BACKEND_URL}${path}`, { next: { revalidate: REVALIDATE }, signal: AbortSignal.timeout(4000) });
    return res.ok ? ((await res.json()) as T) : null;
  } catch {
    return null;
  }
}

/** A trend as the home cards show it (with its 24h change and hourly sparkline), any status. */
export async function trendCard(identifier: string): Promise<Trend | null> {
  const id = identifier.toLowerCase();
  const list = await getJson<{ trends: Trend[] }>("/v1/trends?all=1");
  return list?.trends.find((t) => t.identifier === id) ?? null;
}

export { attentionStory, baseIdentifier, trendName };

export interface SharedCall {
  call: Call;
  trend: Trend | null;
  /** The caller's record across resolved calls. */
  record: { hits: number; misses: number; hitRate: number } | null;
}

/** One call from a trend's thread, with the trend and the caller's record. */
export async function sharedCall(identifier: string, callId: number): Promise<SharedCall | null> {
  const id = identifier.toLowerCase();
  const [thread, trend] = await Promise.all([getJson<{ calls: Call[] }>(`/v1/trends/${encodeURIComponent(id)}/thread`), trendCard(id)]);
  const call = thread?.calls.find((c) => Number(c.id) === callId);
  if (!call) return null;
  const caller = await getJson<{ stats: { hits: number; misses: number; hitRate: number } }>(`/v1/callers/${call.caller}`);
  return { call: { ...call, identifier: id }, trend, record: caller ? caller.stats : null };
}

export const callerName = (c: Pick<Call, "handle" | "caller">) => (c.handle ? `@${c.handle}` : `${c.caller.slice(0, 6)}...${c.caller.slice(-4)}`);

/** "24-hour", "7-day": a call's horizon as an adjective. */
export const horizonLabel = (sec: number) => (sec === 86_400 ? "24-hour" : sec >= 86_400 ? `${Math.round(sec / 86_400)}-day` : sec >= 3600 ? `${Math.round(sec / 3600)}-hour` : `${Math.round(sec / 60)}-minute`);
/** "24 hours", "7 days". */
export const horizonWords = (sec: number) => (sec === 86_400 ? "24 hours" : sec >= 86_400 ? `${Math.round(sec / 86_400)} days` : sec >= 3600 ? `${Math.round(sec / 3600)} hours` : `${Math.round(sec / 60)} minutes`);

// ---------------------------------------------------------------------------------------------
// Verifying a PnL share against the chain
// ---------------------------------------------------------------------------------------------

/**
 * The public RPC answers its per-address rate limit with a plain JSON-RPC error that viem does
 * not retry; a share page should wait a moment rather than call a real result unverified.
 */
function patient(inner: Transport): Transport {
  return (opts) => {
    const t = inner(opts);
    const request = (async (args: Parameters<typeof t.request>[0]) => {
      for (let attempt = 0; ; attempt++) {
        try {
          return await t.request(args);
        } catch (e) {
          const text = e instanceof Error ? `${e.message} ${(e as { details?: string }).details ?? ""}` : String(e);
          if (attempt >= 4 || !/limited to|rate limit|too many requests/i.test(text)) throw e;
          await new Promise((r) => setTimeout(r, 300 + attempt * 300));
        }
      }
    }) as typeof t.request;
    return { ...t, request };
  };
}

const client = createPublicClient({ transport: patient(http(RPC_URL, { timeout: 5000 })) });
const verified = new Map<string, Promise<PerpClose | null>>();

export interface PerpClose {
  id: bigint;
  /** The block the close landed in; the position is still readable one block earlier. */
  blockNumber: bigint;
  owner: `0x${string}`;
  /** Points. */
  exitIndex: number;
  /** Net of funding and the closing fee, AUSD (the opening fee is not in the close event). */
  pnl: number;
  /** The closing fee, AUSD: 0.1% of the notional at exit. */
  fee: number;
  payout: number;
}

/** The attention perp close in `tx`, read from its PositionClosed event, or null. */
export function perpClose(tx: Hex): Promise<PerpClose | null> {
  let p = verified.get(tx);
  if (!p) {
    p = (async () => {
      try {
        const receipt = await client.getTransactionReceipt({ hash: tx });
        if (receipt.status !== "success") return null;
        for (const log of receipt.logs) {
          if (log.address.toLowerCase() !== DEPLOYMENT.attentionPerp.toLowerCase()) continue;
          try {
            const e = decodeEventLog({ abi: attentionPerpAbi, data: log.data, topics: log.topics });
            if (e.eventName !== "PositionClosed") continue;
            const a = e.args as { id: bigint; owner: `0x${string}`; exitIndex: bigint; pnl: bigint; funding: bigint; fee: bigint; payout: bigint };
            return { id: a.id, blockNumber: receipt.blockNumber, owner: a.owner, exitIndex: Number(a.exitIndex) / 1e6, pnl: Number(a.pnl - a.funding - a.fee) / 1e6, fee: Number(a.fee) / 1e6, payout: Number(a.payout) / 1e6 };
          } catch {
            // Another event of the perp.
          }
        }
        return null;
      } catch {
        // Unknown transaction or the node is unreachable: unverified, and worth asking again later.
        verified.delete(tx);
        return null;
      }
    })();
    verified.set(tx, p);
    if (verified.size > 500) verified.delete(verified.keys().next().value!);
  }
  return p;
}

/**
 * True when the shared result matches the closing transaction's PositionClosed event: its exit
 * index, and its PnL either as the event nets it (funding and the closing fee) or also net of the
 * opening fee. Both fees are 0.1% of the notional, so the opening fee is the closing fee scaled by
 * entry over exit; a made-up entry can only make a result worse, never better. Trendr's indexer
 * record of the trade is accepted too. The owner comes from the event, so nobody can borrow
 * someone else's close.
 */
async function verifyPerpShare(share: { kind: string; pnl: number; entry: number | null; exit: number | null; tx: Hex | null }): Promise<boolean> {
  if (share.kind !== "attention" || !share.tx) return false;
  const close = await perpClose(share.tx);
  if (!close) return false;
  if (share.exit !== null && Math.abs(close.exitIndex - share.exit) >= 0.006) return false;
  const near = (v: number) => Math.abs(v - share.pnl) < 0.006;
  if (near(close.pnl)) return true;
  if (share.entry !== null && share.entry > 0 && share.entry <= 1000 && close.exitIndex > 0 && near(close.pnl - (close.fee * share.entry) / close.exitIndex)) return true;
  const tx = share.tx.toLowerCase();
  const activity = await getJson<{ items: Array<{ kind: string; tx: string | null; pnlAusd: number | null }> }>(`/v1/accounts/${close.owner}/activity?limit=200`);
  const item = activity?.items.find((i) => i.kind === "perp" && i.tx?.toLowerCase() === tx);
  return item?.pnlAusd !== null && item?.pnlAusd !== undefined && near(item.pnlAusd);
}

const WAD = 10n ** 18n;

/**
 * The shared result as the chain records it, when the shared numbers check out; otherwise null.
 * Every field under the "Verified on Monad" badge comes from here, never from the link: the PnL and
 * exit from the closing transaction, and the trend, side, entry, margin and leverage from the
 * position as it stood one block before the close, with the owner who closed it.
 */
export async function verifiedPerpShare(share: PnlShare): Promise<{ share: PnlShare; owner: `0x${string}` } | null> {
  if (!share.tx || !(await verifyPerpShare(share))) return null;
  const close = await perpClose(share.tx);
  if (!close) return null;
  try {
    const before = close.blockNumber - 1n;
    const [p, unit] = await Promise.all([
      client.readContract({ address: DEPLOYMENT.attentionPerp, abi: attentionPerpAbi, functionName: "positionOf", args: [close.id], blockNumber: before }),
      client.readContract({ address: DEPLOYMENT.attentionPerp, abi: attentionPerpAbi, functionName: "unit" }),
    ]);
    const pos = p as { owner: `0x${string}`; trendId: Hex; isLong: boolean; entryIndex: bigint; qty: bigint; margin: bigint };
    if (pos.owner.toLowerCase() !== close.owner.toLowerCase()) return null;
    const [identifier] = (await client.readContract({ address: DEPLOYMENT.trendrLens, abi: trendrLensAbi, functionName: "identifiers", args: [[pos.trendId]] })) as readonly string[];
    const trend = identifier ? await trendCard(identifier) : null;
    const margin = Number(pos.margin) / 1e6;
    const notional = Number((pos.qty * BigInt(pos.entryIndex) * (unit as bigint)) / (WAD * 1_000_000n)) / 1e6;
    return {
      owner: close.owner,
      share: {
        kind: "attention",
        market: trend ? trendName(trend) : (identifier ?? "Attention"),
        side: pos.isLong ? "long" : "short",
        pnl: share.pnl,
        roi: margin > 0 ? (share.pnl / margin) * 100 : null,
        entry: Number(pos.entryIndex) / 1e6,
        exit: close.exitIndex,
        leverage: margin > 0 ? Math.round((notional / margin) * 10) / 10 : null,
        tx: share.tx,
        identifier: identifier || null,
      },
    };
  } catch {
    // The node no longer serves that block's state: the badge is withheld rather than guessed.
    return null;
  }
}
