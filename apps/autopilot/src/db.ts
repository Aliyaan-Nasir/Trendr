import { type FollowSettings, type Holding, type Rule, withFollowDefaults } from "@trendr/autopilot";
import postgres from "postgres";

/** The executor's reads and writes; the schema belongs to the backend (backend/src/db/migrations). */

export type Sql = postgres.Sql;

export function connect(url: string): Sql {
  const local = /@(localhost|127\.0\.0\.1)(:\d+)?\//.test(url);
  return postgres(url, { max: 5, idle_timeout: 20, connect_timeout: 10, ssl: local ? false : "require", prepare: false, onnotice: () => {} });
}

export interface RuleRow {
  id: number;
  owner: string;
  rule: Rule;
  status: "draft" | "enabled" | "paused" | "stopped";
  venue: "api" | "session";
}

export interface PositionRow {
  id: number;
  owner: string;
  ruleId: number | null;
  followId: number | null;
  market: string;
  side: "long" | "short";
  status: "opening" | "open" | "closing" | "closed" | "failed";
  size: number;
  entryPrice: number | null;
  marginAusd: number;
  leverage: number;
  openedAt: Date | null;
  feesAusd: number;
}

export interface OrderRow {
  id: number;
  intent: string;
  owner: string;
  positionId: number | null;
  market: string;
  action: "open" | "close" | "reduce";
  side: "long" | "short";
  size: number;
  worstPrice: number;
  leverage: number;
  requestId: bigint;
  status: "pending" | "sent" | "filled" | "unfilled" | "failed";
  attempts: number;
  txHash: string | null;
  fromBlock: bigint | null;
  reason: string | null;
  createdAt: Date;
}

export interface GrantRow {
  owner: string;
  sessionKey: string;
  sealedKey: string;
  validUntil: number;
  dailyLimit: bigint;
  /** A replacement key the account asked for; it takes over once the account adds it on chain. */
  nextSessionKey: string | null;
  nextSealedKey: string | null;
}

export interface FollowRow {
  id: number;
  follower: string;
  leader: string;
  settings: FollowSettings;
  status: "active" | "paused" | "stopped";
  /** Its loss cap was reached: every open copy is being closed, whatever the status. */
  closingOut: boolean;
}

type Row = Record<string, unknown>;
const toPosition = (r: Row): PositionRow => ({
  id: Number(r.id),
  owner: r.owner as string,
  ruleId: r.rule_id === null ? null : Number(r.rule_id),
  followId: r.follow_id === null ? null : Number(r.follow_id),
  market: r.market as string,
  side: r.side as "long" | "short",
  status: r.status as PositionRow["status"],
  size: r.size as number,
  entryPrice: r.entry_price as number | null,
  marginAusd: r.margin_ausd as number,
  leverage: r.leverage as number,
  openedAt: r.opened_at as Date | null,
  feesAusd: r.fees_ausd as number,
});
const toOrder = (r: Row): OrderRow => ({
  id: Number(r.id),
  intent: r.intent as string,
  owner: r.owner as string,
  positionId: r.position_id === null ? null : Number(r.position_id),
  market: r.market as string,
  action: r.action as OrderRow["action"],
  side: r.side as "long" | "short",
  size: r.size as number,
  worstPrice: r.worst_price as number,
  leverage: r.leverage as number,
  requestId: BigInt(r.request_id as string),
  status: r.status as OrderRow["status"],
  attempts: r.attempts as number,
  txHash: r.tx_hash as string | null,
  fromBlock: r.from_block === null || r.from_block === undefined ? null : BigInt(r.from_block as string),
  reason: (r.reason as string | null) ?? null,
  createdAt: r.created_at as Date,
});

export class ExecutorDb {
  constructor(readonly sql: Sql) {}

  async killSwitch(): Promise<{ engaged: boolean; reason: string | null }> {
    const rows = await this.sql<{ value: { engaged: boolean; reason?: string } }[]>`SELECT value FROM autopilot_control WHERE key = 'kill'`;
    return { engaged: rows[0]?.value.engaged ?? false, reason: rows[0]?.value.reason ?? null };
  }

  /** Enabled rules, and paused or stopped ones that still hold a position to manage. */
  async rulesToRun(): Promise<RuleRow[]> {
    const rows = await this.sql<Row[]>`
      SELECT r.id, r.owner, r.rule, r.status, r.venue FROM autopilot_rules r
       WHERE r.status = 'enabled'
          OR EXISTS (SELECT 1 FROM autopilot_positions p WHERE p.rule_id = r.id AND p.status IN ('opening', 'open', 'closing'))
       ORDER BY r.id`;
    return rows.map((r) => ({ id: Number(r.id), owner: r.owner as string, rule: r.rule as Rule, status: r.status as RuleRow["status"], venue: r.venue as RuleRow["venue"] }));
  }

  async setRuleStatus(id: number, status: RuleRow["status"], reason: string): Promise<void> {
    await this.sql`UPDATE autopilot_rules SET status = ${status}, status_reason = ${reason}, updated_at = now() WHERE id = ${id}`;
  }

  async grants(): Promise<GrantRow[]> {
    const rows = await this.sql<Row[]>`
      SELECT owner, session_key, sealed_key, valid_until, daily_limit, next_session_key, next_sealed_key FROM autopilot_grants WHERE status = 'active'`;
    return rows.map(grantRow);
  }

  /** One owner's active grant, or null. */
  async grant(owner: string): Promise<GrantRow | null> {
    const rows = await this.sql<Row[]>`
      SELECT owner, session_key, sealed_key, valid_until, daily_limit, next_session_key, next_sealed_key FROM autopilot_grants
       WHERE status = 'active' AND owner = ${owner.toLowerCase()}`;
    return rows[0] ? grantRow(rows[0]) : null;
  }

  /** Ends a grant, but only while `sessionKey` is still its key: a grant switched since it was read stays. */
  async setGrantStatus(owner: string, sessionKey: string, status: "revoked" | "expired"): Promise<void> {
    await this.sql`UPDATE autopilot_grants SET status = ${status}, updated_at = now() WHERE owner = ${owner} AND session_key = ${sessionKey.toLowerCase()}`;
  }

  /** Moves a grant's waiting key into place with its on-chain terms; null when it is no longer the waiting key. */
  async switchGrant(owner: string, nextSessionKey: string, validUntil: number, dailyLimit: bigint): Promise<GrantRow | null> {
    const rows = await this.sql<Row[]>`
      UPDATE autopilot_grants SET session_key = next_session_key, sealed_key = next_sealed_key, next_session_key = NULL, next_sealed_key = NULL,
             status = 'active', valid_until = ${validUntil}, daily_limit = ${dailyLimit.toString()}, updated_at = now()
       WHERE owner = ${owner} AND next_session_key = ${nextSessionKey.toLowerCase()}
      RETURNING owner, session_key, sealed_key, valid_until, daily_limit, next_session_key, next_sealed_key`;
    return rows[0] ? grantRow(rows[0]) : null;
  }

  /** The live (not closed or failed) position of a rule, or of a follow in a market. */
  async livePosition(where: { ruleId?: number; followId?: number; market?: string }): Promise<PositionRow | null> {
    const rows = await this.sql<Row[]>`
      SELECT * FROM autopilot_positions
       WHERE status IN ('opening', 'open', 'closing')
         AND (${where.ruleId ?? null}::bigint IS NULL OR rule_id = ${where.ruleId ?? null})
         AND (${where.followId ?? null}::bigint IS NULL OR follow_id = ${where.followId ?? null})
         AND (${where.market ?? null}::text IS NULL OR market = ${where.market ?? null})
       ORDER BY id DESC LIMIT 1`;
    return rows[0] ? toPosition(rows[0]) : null;
  }

  /** Every live position, for reconciliation against the chain. */
  async livePositions(): Promise<PositionRow[]> {
    return (await this.sql<Row[]>`SELECT * FROM autopilot_positions WHERE status IN ('open') ORDER BY id`).map(toPosition);
  }

  async positionCount(ruleId: number): Promise<number> {
    const rows = await this.sql<{ n: number }[]>`SELECT count(*)::int AS n FROM autopilot_positions WHERE rule_id = ${ruleId}`;
    return rows[0]?.n ?? 0;
  }

  /** Realized PnL today (UTC) of a rule, a follow, or an owner's copies. */
  async realizedToday(where: { ruleId?: number; followId?: number }): Promise<number> {
    const rows = await this.sql<{ pnl: number | null }[]>`
      SELECT sum(pnl_ausd)::float8 AS pnl FROM autopilot_positions
       WHERE status = 'closed' AND closed_at >= date_trunc('day', now() AT TIME ZONE 'utc') AT TIME ZONE 'utc'
         AND (${where.ruleId ?? null}::bigint IS NULL OR rule_id = ${where.ruleId ?? null})
         AND (${where.followId ?? null}::bigint IS NULL OR follow_id = ${where.followId ?? null})`;
    return rows[0]?.pnl ?? 0;
  }

  async lastExitAt(ruleId: number): Promise<number | null> {
    const rows = await this.sql<{ at: Date | null }[]>`SELECT max(closed_at) AS at FROM autopilot_positions WHERE rule_id = ${ruleId} AND status = 'closed'`;
    const at = rows[0]?.at;
    return at ? Math.floor(at.getTime() / 1000) : null;
  }

  /**
   * Starts an order idempotently: the intent is unique, so a retry finds the order it already
   * started instead of creating another. Opening orders create their position in the same transaction.
   */
  async startOrder(o: {
    intent: string;
    owner: string;
    market: string;
    action: OrderRow["action"];
    side: "long" | "short";
    size: number;
    worstPrice: number;
    leverage: number;
    requestId: bigint;
    reason: string;
    position: { existingId: number } | { ruleId: number | null; followId: number | null; signal: Record<string, unknown> };
  }): Promise<{ order: OrderRow; created: boolean }> {
    const existing = await this.sql<Row[]>`SELECT * FROM autopilot_orders WHERE intent = ${o.intent}`;
    if (existing[0]) return { order: toOrder(existing[0]), created: false };
    return this.sql.begin(async (tx) => {
      let positionId: number;
      if ("existingId" in o.position) {
        positionId = o.position.existingId;
        await tx`UPDATE autopilot_positions SET status = ${o.action === "open" ? "opening" : "closing"}, updated_at = now() WHERE id = ${positionId}`;
      } else {
        const rows = await tx<{ id: string }[]>`
          INSERT INTO autopilot_positions (owner, rule_id, follow_id, market, side, status, leverage, signal)
          VALUES (${o.owner}, ${o.position.ruleId}, ${o.position.followId}, ${o.market}, ${o.side}, 'opening', ${o.leverage}, ${tx.json(o.position.signal as never)})
          RETURNING id`;
        positionId = Number(rows[0]!.id);
      }
      const rows = await tx<Row[]>`
        INSERT INTO autopilot_orders (intent, owner, position_id, market, action, side, size, worst_price, leverage, request_id, reason)
        VALUES (${o.intent}, ${o.owner}, ${positionId}, ${o.market}, ${o.action}, ${o.side}, ${o.size}, ${o.worstPrice}, ${o.leverage}, ${o.requestId.toString()}, ${o.reason})
        RETURNING *`;
      return { order: toOrder(rows[0]!), created: true };
    });
  }

  async orderSent(id: number, txHash: string | null, fromBlock: bigint): Promise<void> {
    await this.sql`
      UPDATE autopilot_orders SET status = 'sent', tx_hash = ${txHash}, from_block = COALESCE(from_block, ${fromBlock.toString()}), attempts = attempts + 1, error = NULL, updated_at = now()
       WHERE id = ${id}`;
  }

  /** Orders already placed for a position, so each new attempt gets its own intent. */
  async orderCount(positionId: number): Promise<number> {
    const rows = await this.sql<{ n: number }[]>`SELECT count(*)::int AS n FROM autopilot_orders WHERE position_id = ${positionId}`;
    return rows[0]?.n ?? 0;
  }

  /** Live positions of an owner in a market: Perpl keeps one position per account and market. */
  async liveInMarket(owner: string, market: string): Promise<PositionRow[]> {
    return (await this.sql<Row[]>`
      SELECT * FROM autopilot_positions WHERE owner = ${owner} AND market = ${market} AND status IN ('opening', 'open', 'closing')`).map(toPosition);
  }

  async adjustSize(id: number, size: number, marginAusd: number): Promise<void> {
    await this.sql`UPDATE autopilot_positions SET size = ${size}, margin_ausd = ${marginAusd}, updated_at = now() WHERE id = ${id}`;
  }

  async orderRetry(id: number, error: string): Promise<number> {
    const rows = await this.sql<{ attempts: number }[]>`UPDATE autopilot_orders SET attempts = attempts + 1, error = ${error.slice(0, 500)}, updated_at = now() WHERE id = ${id} RETURNING attempts`;
    return rows[0]?.attempts ?? 0;
  }

  /** Records an order's final result and moves its position on. */
  async orderDone(
    o: OrderRow,
    r: { status: "filled" | "unfilled" | "failed"; txHash?: string | null; fillPrice?: number | null; fillSize?: number; feeAusd?: number; pnlAusd?: number; marginAusd?: number; error?: string | null; closeReason?: string },
  ): Promise<void> {
    await this.sql.begin(async (tx) => {
      await tx`
        UPDATE autopilot_orders SET status = ${r.status}, tx_hash = COALESCE(${r.txHash ?? null}, tx_hash), fill_price = ${r.fillPrice ?? null}, fill_size = ${r.fillSize ?? null},
               fee_ausd = ${r.feeAusd ?? null}, pnl_ausd = ${r.pnlAusd ?? null}, error = ${r.error ?? null}, updated_at = now()
         WHERE id = ${o.id}`;
      if (o.positionId === null) return;
      const p = (await tx<Row[]>`SELECT * FROM autopilot_positions WHERE id = ${o.positionId} FOR UPDATE`)[0];
      if (!p) return;
      const pos = toPosition(p);
      const fee = r.feeAusd ?? 0;
      if (o.action === "open") {
        if (r.status !== "filled" || !r.fillSize) {
          // Nothing was added: a new position failed; an increase leaves the position as it was.
          if (pos.size > 0) await tx`UPDATE autopilot_positions SET status = 'open', updated_at = now() WHERE id = ${pos.id}`;
          else await tx`UPDATE autopilot_positions SET status = 'failed', close_reason = ${r.error ?? r.status}, updated_at = now() WHERE id = ${pos.id}`;
          return;
        }
        const size = pos.size + r.fillSize;
        const entry = pos.size > 0 && pos.entryPrice ? (pos.entryPrice * pos.size + (r.fillPrice ?? 0) * r.fillSize) / size : (r.fillPrice ?? null);
        await tx`
          UPDATE autopilot_positions SET status = 'open', size = ${size}, entry_price = ${entry}, margin_ausd = margin_ausd + ${r.marginAusd ?? 0},
                 fees_ausd = fees_ausd + ${fee}, opened_at = COALESCE(opened_at, now()), updated_at = now()
           WHERE id = ${pos.id}`;
        return;
      }
      // close or reduce
      if (r.status !== "filled" || !r.fillSize) {
        await tx`UPDATE autopilot_positions SET status = 'open', updated_at = now() WHERE id = ${pos.id}`;
        return;
      }
      const remaining = Math.max(0, pos.size - r.fillSize);
      const realized = (r.pnlAusd ?? 0) - fee;
      if (remaining <= pos.size * 1e-6) {
        // Net PnL: every reduce's PnL net of its fee, less the fees paid to open.
        const opened = await tx<{ fees: number }[]>`
          SELECT COALESCE(sum(fee_ausd), 0)::float8 AS fees FROM autopilot_orders WHERE position_id = ${pos.id} AND action = 'open' AND status = 'filled'`;
        await tx`
          UPDATE autopilot_positions SET status = 'closed', exit_price = ${r.fillPrice ?? null}, closed_at = now(),
                 pnl_ausd = COALESCE(pnl_ausd, 0) + ${realized - (opened[0]?.fees ?? 0)}, fees_ausd = fees_ausd + ${fee}, close_reason = ${r.closeReason ?? "close"}, updated_at = now()
           WHERE id = ${pos.id}`;
      } else {
        // A partial reduce books its PnL now; opening fees are charged when the position closes.
        await tx`
          UPDATE autopilot_positions SET status = 'open', size = ${remaining}, margin_ausd = margin_ausd * ${remaining / pos.size},
                 pnl_ausd = COALESCE(pnl_ausd, 0) + ${realized}, fees_ausd = fees_ausd + ${fee}, updated_at = now()
           WHERE id = ${pos.id}`;
      }
    });
  }

  /** A position the exchange closed without us (liquidation, or a manual close by the owner). */
  async closedExternally(id: number, exitPrice: number | null, pnlAusd: number | null, reason: string): Promise<void> {
    await this.sql`
      UPDATE autopilot_positions SET status = 'closed', exit_price = ${exitPrice}, pnl_ausd = ${pnlAusd}, close_reason = ${reason}, closed_at = now(), updated_at = now()
       WHERE id = ${id} AND status = 'open'`;
  }

  async openOrders(): Promise<OrderRow[]> {
    return (await this.sql<Row[]>`SELECT * FROM autopilot_orders WHERE status IN ('pending', 'sent') ORDER BY id`).map(toOrder);
  }

  async consecutiveFailures(ruleId: number): Promise<number> {
    const rows = await this.sql<{ status: string }[]>`
      SELECT o.status FROM autopilot_orders o JOIN autopilot_positions p ON p.id = o.position_id
       WHERE p.rule_id = ${ruleId} ORDER BY o.id DESC LIMIT 10`;
    let n = 0;
    for (const r of rows) {
      if (r.status !== "failed") break;
      n++;
    }
    return n;
  }

  /** The next Perpl request id for an account: above both what we used and `seed` (the API's lfr). */
  async nextRequestId(owner: string, seed: bigint): Promise<bigint> {
    const rows = await this.sql<{ last_id: string }[]>`
      INSERT INTO perpl_request_ids (owner, last_id) VALUES (${owner}, ${(seed + 1n).toString()})
      ON CONFLICT (owner) DO UPDATE SET last_id = GREATEST(perpl_request_ids.last_id, ${seed.toString()}::bigint) + 1, updated_at = now()
      RETURNING last_id`;
    return BigInt(rows[0]!.last_id);
  }

  async audit(owner: string, event: string, detail: Record<string, unknown>, ruleId: number | null = null, followId: number | null = null): Promise<void> {
    await this.sql`INSERT INTO autopilot_audit (owner, rule_id, follow_id, event, detail) VALUES (${owner}, ${ruleId}, ${followId}, ${event}, ${this.sql.json(detail as never)})`;
  }

  /**
   * The newest listing of a trend (by base identifier) mirrored by the backend's history job: a
   * topic that retired and came back is listed again as `<base>.2` up to `<base>.9`, so the highest
   * version is the newest.
   */
  async trendIdOf(identifier: string): Promise<string | null> {
    const base = identifier.replace(/\.[2-9]$/, "");
    const listings = [base, ...Array.from({ length: 8 }, (_, i) => `${base}.${i + 2}`)];
    const rows = await this.sql<{ trend_id: string; identifier: string }[]>`
      SELECT trend_id, identifier FROM index_sync WHERE identifier = ANY(${this.sql.array(listings)})`;
    rows.sort((a, b) => listings.indexOf(b.identifier) - listings.indexOf(a.identifier));
    return rows[0]?.trend_id ?? null;
  }

  async attention(trendId: string, sinceSec: number): Promise<Array<{ t: number; v: number }>> {
    const rows = await this.sql<{ observed_at: string; points: number }[]>`
      SELECT observed_at, points FROM index_points WHERE trend_id = ${trendId} AND observed_at >= ${sinceSec} ORDER BY observed_at`;
    return rows.map((r) => ({ t: Number(r.observed_at), v: r.points }));
  }

  async latestNetflow(identifier: string, maxAgeSec: number): Promise<number | null> {
    const base = identifier.replace(/\.[2-9]$/, "");
    const rows = await this.sql<{ value: number }[]>`
      SELECT value FROM measurements WHERE identifier = ${base} AND source = 'nansen' AND observed_at > now() - make_interval(secs => ${maxAgeSec})
       ORDER BY observed_at DESC LIMIT 1`;
    return rows[0]?.value ?? null;
  }

  /** Follows that copy now: active, with an active grant, and not being closed out. */
  async activeFollows(): Promise<FollowRow[]> {
    const rows = await this.sql<Row[]>`
      SELECT f.id, f.follower, f.leader, f.settings, f.status, f.closing_out FROM follows f
        JOIN autopilot_grants g ON g.owner = f.follower AND g.status = 'active'
       WHERE f.status = 'active' AND NOT f.closing_out ORDER BY f.id`;
    return rows.map(followRow);
  }

  /** Follows whose loss cap needs watching (active ones holding copies) or acting on (being closed out). */
  async followsToGuard(): Promise<FollowRow[]> {
    const rows = await this.sql<Row[]>`
      SELECT f.id, f.follower, f.leader, f.settings, f.status, f.closing_out FROM follows f
       WHERE f.closing_out
          OR (f.status = 'active' AND EXISTS (SELECT 1 FROM autopilot_positions p WHERE p.follow_id = f.id AND p.status IN ('opening', 'open', 'closing')))
       ORDER BY f.id`;
    return rows.map(followRow);
  }

  /** The live (not closed or failed) positions a follow copied. */
  async followPositions(followId: number): Promise<PositionRow[]> {
    return (await this.sql<Row[]>`SELECT * FROM autopilot_positions WHERE follow_id = ${followId} AND status IN ('opening', 'open', 'closing') ORDER BY id`).map(toPosition);
  }

  /** Pauses a follow at its loss cap and marks it for closing out; false when it was already. */
  async startCloseOut(id: number, reason: string): Promise<boolean> {
    const rows = await this.sql`
      UPDATE follows SET status = 'paused', status_reason = ${reason}, closing_out = true, updated_at = now() WHERE id = ${id} AND NOT closing_out RETURNING id`;
    return rows.length > 0;
  }

  /** A closed-out follow holds no copies any more. */
  async endCloseOut(id: number): Promise<void> {
    await this.sql`UPDATE follows SET closing_out = false, updated_at = now() WHERE id = ${id}`;
  }

  async leaderHoldings(leader: string): Promise<Map<string, Holding> | null> {
    const rows = await this.sql<{ market: string; side: "long" | "short" | null; size: number; margin_ausd: number; entry_price: number | null }[]>`
      SELECT market, side, size, margin_ausd, entry_price FROM leader_holdings WHERE leader = ${leader}`;
    if (rows.length === 0) return null;
    return new Map(rows.filter((r) => r.side && r.size > 0).map((r) => [r.market, { side: r.side!, size: r.size, marginAusd: r.margin_ausd, entryPrice: r.entry_price }]));
  }

  /** Stores a leader's full snapshot; markets the leader is flat in keep a row so the first snapshot is known. */
  async saveLeaderHoldings(leader: string, markets: readonly string[], holdings: Map<string, Holding>): Promise<void> {
    await this.sql.begin(async (tx) => {
      for (const m of markets) {
        const h = holdings.get(m);
        await tx`
          INSERT INTO leader_holdings (leader, market, side, size, margin_ausd, entry_price) VALUES (${leader}, ${m}, ${h?.side ?? null}, ${h?.size ?? 0}, ${h?.marginAusd ?? 0}, ${h?.entryPrice ?? null})
          ON CONFLICT (leader, market) DO UPDATE SET side = EXCLUDED.side, size = EXCLUDED.size, margin_ausd = EXCLUDED.margin_ausd, entry_price = EXCLUDED.entry_price, seen_at = now()`;
      }
    });
  }
}

const followRow = (r: Row): FollowRow => ({
  id: Number(r.id),
  follower: r.follower as string,
  leader: r.leader as string,
  settings: withFollowDefaults(r.settings as FollowSettings),
  status: r.status as FollowRow["status"],
  closingOut: Boolean(r.closing_out),
});

const grantRow = (r: Row): GrantRow => ({
  owner: r.owner as string,
  sessionKey: r.session_key as string,
  sealedKey: r.sealed_key as string,
  validUntil: Number(r.valid_until),
  dailyLimit: BigInt(r.daily_limit as string),
  nextSessionKey: (r.next_session_key as string | null) ?? null,
  nextSealedKey: (r.next_sealed_key as string | null) ?? null,
});
