import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import postgres from "postgres";
import { z } from "zod";
import type { AlertRecord } from "./alerts";
import type { TargetMemory, TransferRecord } from "./plan";

/** Everything that must survive a restart: the transfer ledger behind the caps, per-target memory and alerts. */
export interface State {
  version: 1;
  transfers: TransferRecord[];
  targets: Record<string, TargetMemory>;
  alerts: Record<string, AlertRecord>;
}

export const emptyState = (): State => ({ version: 1, transfers: [], targets: {}, alerts: {} });

const stateSchema = z.object({
  version: z.literal(1),
  transfers: z.array(
    z.object({
      id: z.string(),
      target: z.string(),
      amount: z.string().regex(/^\d+$/),
      at: z.number(),
      status: z.enum(["pending", "confirmed", "unknown", "failed"]),
      partial: z.boolean(),
      hash: z.string().optional(),
      gasLimit: z.string().optional(),
    }),
  ),
  targets: z.record(
    z.string(),
    z.object({
      failures: z.number(),
      retryAt: z.number(),
      lastError: z.string().nullable(),
      halted: z.object({ at: z.number(), reason: z.string() }).nullable(),
      releasedAt: z.number(),
    }),
  ),
  alerts: z.record(
    z.string(),
    z.object({
      detail: z.string(),
      since: z.number(),
      lastSentAt: z.number(),
      repeatAt: z.number().nullable(),
      delayMs: z.number(),
      sent: z.number(),
    }),
  ),
});

/** Refuses a state it cannot read rather than starting over, which would reset the daily caps. */
export function parseState(value: unknown): State {
  return stateSchema.parse(value) as State;
}

export interface Store {
  readonly kind: "file" | "postgres";
  load(): Promise<State>;
  save(state: State): Promise<void>;
  /**
   * True while this process may send. With Postgres only the holder of an advisory lock sends,
   * so two instances (a rolling deploy) never fund the same wallet twice.
   */
  lead(): Promise<boolean>;
  close(): Promise<void>;
}

/** A JSON file, written atomically. One instance only: nothing stops a second process using another copy. */
export class FileStore implements Store {
  readonly kind = "file";

  constructor(private readonly path: string) {}

  async load(): Promise<State> {
    let text: string;
    try {
      text = await readFile(this.path, "utf8");
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return emptyState();
      throw e;
    }
    return parseState(JSON.parse(text));
  }

  async save(state: State): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    const tmp = `${this.path}.tmp`;
    await writeFile(tmp, JSON.stringify(state));
    await rename(tmp, this.path);
  }

  async lead(): Promise<boolean> {
    return true;
  }

  async close(): Promise<void> {}
}

export function connect(url: string): postgres.Sql {
  const local = /@(localhost|127\.0\.0\.1)(:\d+)?\//.test(url);
  // No idle timeout: the reserved connection holding the leader lock must stay open between checks.
  return postgres(url, { max: 3, connect_timeout: 10, ssl: local ? false : "require", prepare: false, onnotice: () => {} });
}

/** A 31-bit FNV-1a hash, the advisory lock key for a state id. */
function lockKey(id: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < id.length; i++) h = Math.imul(h ^ id.charCodeAt(i), 0x01000193);
  return h & 0x7fffffff;
}

/** Namespaces the lock among other advisory locks in the database. */
const LOCK_CLASS = 0x746f7075; // "topu"

/**
 * One row per treasury and chain in its own table, created idempotently. Needs a session
 * connection (not a transaction pooler) for the advisory lock.
 */
export class PgStore implements Store {
  readonly kind = "postgres";
  private ready: Promise<void> | null = null;
  private session: postgres.ReservedSql | null = null;

  constructor(
    private readonly sql: postgres.Sql,
    private readonly id: string,
  ) {}

  private init(): Promise<void> {
    this.ready ??= this.sql`
      CREATE TABLE IF NOT EXISTS topup_state (
        id text PRIMARY KEY,
        state jsonb NOT NULL,
        updated_at timestamptz NOT NULL DEFAULT now()
      )`.then(
      () => undefined,
      (e) => {
        this.ready = null;
        throw e;
      },
    );
    return this.ready;
  }

  async load(): Promise<State> {
    await this.init();
    const rows = await this.sql<{ state: unknown }[]>`SELECT state FROM topup_state WHERE id = ${this.id}`;
    return rows[0] ? parseState(rows[0].state) : emptyState();
  }

  async save(state: State): Promise<void> {
    await this.init();
    await this.sql`
      INSERT INTO topup_state (id, state, updated_at) VALUES (${this.id}, ${this.sql.json(state as never)}, now())
      ON CONFLICT (id) DO UPDATE SET state = EXCLUDED.state, updated_at = now()`;
  }

  /**
   * Takes (or confirms) the lock on a reserved connection. Asking again while holding it succeeds,
   * and a reconnected session has to win the lock afresh, so a lost session never leaves two leaders.
   */
  async lead(): Promise<boolean> {
    try {
      this.session ??= await this.sql.reserve();
      const [row] = await this.session<{ locked: boolean }[]>`SELECT pg_try_advisory_lock(${LOCK_CLASS}::int, ${lockKey(this.id)}::int) AS locked`;
      return row?.locked === true;
    } catch {
      this.session?.release();
      this.session = null;
      return false;
    }
  }

  async close(): Promise<void> {
    this.session?.release();
    this.session = null;
    await this.sql.end({ timeout: 5 });
  }
}
