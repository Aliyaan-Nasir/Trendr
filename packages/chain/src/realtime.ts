import type { Address, Hex } from "viem";

/**
 * Monad's speculative realtime feeds (`monadNewHeads`, `monadLogs`) over one WebSocket.
 *
 * Monad announces a block when it is Proposed and again as it moves to Voted, Finalized and
 * Verified. Several proposals can exist for one height; the ones that lose are never announced
 * again. Consumers here act at the Voted stage: an item is delivered once, the first time its
 * block reaches Voted or any later state, so data from abandoned proposals is never delivered.
 *
 * Streams are triggers, not the source of truth: a reconnect can miss items, so consumers re-read
 * chain state on every head rather than trusting that they saw every log.
 */

export type CommitState = "Proposed" | "Voted" | "Finalized" | "Verified";

const RANK: Record<CommitState, number> = { Proposed: 0, Voted: 1, Finalized: 2, Verified: 3 };

export interface Head {
  number: bigint;
  hash: Hex;
  blockId: Hex;
  timestamp: bigint;
  commitState: CommitState;
}

export interface StreamLog {
  address: Address;
  topics: [Hex, ...Hex[]] | [];
  data: Hex;
  blockNumber: bigint;
  blockHash: Hex;
  blockId: Hex;
  transactionHash: Hex;
  logIndex: number;
  commitState: CommitState;
}

export interface LogFilter {
  address?: Address | Address[];
  topics?: (Hex | Hex[] | null)[];
}

export interface RealtimeOptions {
  /** Delivery stage; Voted by default. */
  stage?: Exclude<CommitState, "Proposed">;
  /** Reconnects when nothing arrives for this long. Monad makes a block every 400 ms. */
  silenceMs?: number;
  minBackoffMs?: number;
  maxBackoffMs?: number;
  log?: (level: "info" | "warn", message: string, fields?: Record<string, unknown>) => void;
  /** Injectable for tests. */
  WebSocketImpl?: typeof WebSocket;
}

interface Subscription {
  params: unknown[];
  onResult(result: Record<string, unknown>): void;
  id?: string;
}

export interface RealtimeStatus {
  connected: boolean;
  lastMessageAt: number;
  reconnects: number;
  lastHead: bigint;
}

/** Remembers the last `size` keys, so repeated announcements are delivered once. */
class Seen {
  private readonly keys = new Set<string>();
  private readonly order: string[] = [];
  constructor(private readonly size: number) {}
  add(key: string): boolean {
    if (this.keys.has(key)) return false;
    this.keys.add(key);
    this.order.push(key);
    if (this.order.length > this.size) this.keys.delete(this.order.shift()!);
    return true;
  }
}

const hexToBigInt = (v: unknown) => BigInt(v as string);

export class MonadRealtime {
  private ws: WebSocket | null = null;
  private readonly subs: Subscription[] = [];
  private readonly pending = new Map<number, Subscription>();
  private nextId = 1;
  private backoff: number;
  private watchdog: ReturnType<typeof setInterval> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private stopped = true;
  private readonly stage: number;
  private readonly silenceMs: number;
  private readonly minBackoff: number;
  private readonly maxBackoff: number;
  private readonly WS: typeof WebSocket;
  readonly status: RealtimeStatus = { connected: false, lastMessageAt: 0, reconnects: 0, lastHead: 0n };

  private readonly urls: string[];
  private urlIndex = 0;

  /**
   * @param url One WebSocket endpoint, or several: each reconnect moves to the next, so a failing
   *            endpoint is left behind.
   */
  constructor(
    url: string | readonly string[],
    private readonly opts: RealtimeOptions = {},
  ) {
    this.urls = typeof url === "string" ? [url] : [...url];
    if (this.urls.length === 0) throw new Error("at least one WebSocket endpoint is required");
    this.stage = RANK[opts.stage ?? "Voted"];
    this.silenceMs = opts.silenceMs ?? 10_000;
    this.minBackoff = opts.minBackoffMs ?? 500;
    this.maxBackoff = opts.maxBackoffMs ?? 10_000;
    this.backoff = this.minBackoff;
    this.WS = opts.WebSocketImpl ?? WebSocket;
  }

  /** Calls `onHead` once per block height, in order, when the block reaches the stage. */
  onHeads(onHead: (head: Head) => void): this {
    const seen = new Seen(1024);
    this.subs.push({
      params: ["monadNewHeads"],
      onResult: (r) => {
        const state = r.commitState as CommitState;
        if (RANK[state] === undefined || RANK[state] < this.stage) return;
        const number = hexToBigInt(r.number);
        // Heights only move forward; a late announcement of an older height is ignored.
        if (number <= this.status.lastHead || !seen.add(String(number))) return;
        this.status.lastHead = number;
        onHead({ number, hash: r.hash as Hex, blockId: r.blockId as Hex, timestamp: hexToBigInt(r.timestamp), commitState: state });
      },
    });
    return this;
  }

  /** Calls `onLog` once per log, when its block reaches the stage. */
  onLogs(filter: LogFilter, onLog: (log: StreamLog) => void): this {
    const seen = new Seen(8192);
    this.subs.push({
      params: ["monadLogs", filter],
      onResult: (r) => {
        const state = r.commitState as CommitState;
        if (RANK[state] === undefined || RANK[state] < this.stage) return;
        const key = `${r.blockNumber}:${r.transactionHash}:${r.logIndex}`;
        if (!seen.add(key)) return;
        onLog({
          address: r.address as Address,
          topics: r.topics as StreamLog["topics"],
          data: r.data as Hex,
          blockNumber: hexToBigInt(r.blockNumber),
          blockHash: r.blockHash as Hex,
          blockId: r.blockId as Hex,
          transactionHash: r.transactionHash as Hex,
          logIndex: Number(hexToBigInt(r.logIndex)),
          commitState: state,
        });
      },
    });
    return this;
  }

  start(): this {
    if (!this.stopped) return this;
    this.stopped = false;
    this.connect();
    this.watchdog = setInterval(() => {
      if (!this.ws || this.ws.readyState !== this.WS.OPEN) return;
      if (Date.now() - this.status.lastMessageAt > this.silenceMs) {
        this.opts.log?.("warn", "realtime feed went silent; reconnecting", { silenceMs: this.silenceMs });
        this.ws.close();
      }
    }, Math.min(this.silenceMs, 2_000));
    return this;
  }

  stop(): void {
    this.stopped = true;
    if (this.watchdog) clearInterval(this.watchdog);
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.watchdog = null;
    this.reconnectTimer = null;
    this.ws?.close();
    this.ws = null;
  }

  /** The endpoint the current connection uses. */
  get url(): string {
    return this.urls[this.urlIndex % this.urls.length]!;
  }

  private connect(): void {
    const ws = new this.WS(this.url);
    this.ws = ws;
    this.pending.clear();
    ws.onopen = () => {
      this.status.connected = true;
      this.status.lastMessageAt = Date.now();
      this.backoff = this.minBackoff;
      this.opts.log?.("info", "realtime feed connected", { endpoint: this.urlIndex % this.urls.length });
      for (const sub of this.subs) {
        const id = this.nextId++;
        this.pending.set(id, sub);
        ws.send(JSON.stringify({ jsonrpc: "2.0", id, method: "eth_subscribe", params: sub.params }));
      }
    };
    ws.onmessage = (event) => {
      this.status.lastMessageAt = Date.now();
      let msg: { id?: number; result?: unknown; error?: { message?: string }; params?: { subscription: string; result: Record<string, unknown> } };
      try {
        msg = JSON.parse(String(event.data));
      } catch {
        return;
      }
      if (msg.id !== undefined) {
        const sub = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (!sub) return;
        if (msg.error) {
          this.opts.log?.("warn", "subscription refused", { params: sub.params, error: msg.error.message });
          return;
        }
        sub.id = String(msg.result);
        return;
      }
      const params = msg.params;
      if (!params) return;
      const sub = this.subs.find((s) => s.id === params.subscription);
      sub?.onResult(params.result);
    };
    ws.onclose = () => {
      this.status.connected = false;
      for (const sub of this.subs) sub.id = undefined;
      if (this.ws !== ws || this.stopped) return;
      this.status.reconnects++;
      this.urlIndex++;
      const delay = this.urls.length > 1 && this.urlIndex % this.urls.length !== 0 ? this.minBackoff : this.backoff;
      // Backoff grows only once every endpoint has been tried.
      if (this.urlIndex % this.urls.length === 0) this.backoff = Math.min(this.backoff * 2, this.maxBackoff);
      this.opts.log?.("warn", "realtime feed closed; reconnecting", { delayMs: delay });
      this.reconnectTimer = setTimeout(() => this.connect(), delay);
    };
    ws.onerror = () => {
      // onclose follows and reconnects.
    };
  }
}
