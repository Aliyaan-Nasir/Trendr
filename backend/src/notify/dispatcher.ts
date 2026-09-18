import type { Sql } from "../db";
import type { Push, PushPayload, Topic } from "./push";

/**
 * Turns what happened into notifications: Autopilot and copy-trading events from the audit log,
 * and resolved calls. Each stream keeps a cursor, so every event notifies once even across
 * restarts.
 */

interface AuditRow {
  id: string;
  owner: string;
  rule_id: string | null;
  follow_id: string | null;
  event: string;
  detail: Record<string, unknown>;
}

const money = (v: unknown) => (typeof v === "number" ? `${v >= 0 ? "+" : "-"}${Math.abs(v).toFixed(2)} AUSD` : "");

/** The notification for an audit event, or null for events not worth a buzz. */
export function auditNotification(e: AuditRow): { topic: Topic; payload: PushPayload } | null {
  const d = e.detail;
  const copy = e.follow_id !== null;
  const topic: Topic = copy ? "copy" : "autopilot";
  const url = copy ? "/copy" : e.rule_id ? `/autopilot/${e.rule_id}` : "/autopilot";
  const what = copy ? "Copy trade" : "Autopilot";
  switch (e.event) {
    case "order_filled": {
      const opened = d.action === "open";
      const side = String(d.side ?? "");
      return {
        topic,
        payload: {
          title: `${what}: ${opened ? "opened" : "closed"} ${side}`,
          body: opened ? `Filled at ${d.price}` : `Closed at ${d.price}${typeof d.pnlAusd === "number" ? `, ${money(d.pnlAusd)} before fees` : ""}`,
          url,
          tag: `order-${d.orderId}`,
        },
      };
    }
    case "order_failed":
      return { topic, payload: { title: `${what}: order failed`, body: String(d.error ?? "The order did not go through."), url, tag: `order-${d.orderId}` } };
    case "rule_paused":
      return d.by === "autopilot" ? { topic: "autopilot", payload: { title: "Autopilot paused a rule", body: String(d.reason ?? ""), url } } : null;
    case "position_closed_externally":
      return { topic, payload: { title: `${what}: position closed outside Autopilot`, body: `Liquidated or closed by hand${typeof d.estimatedPnlAusd === "number" ? ` (about ${money(d.estimatedPnlAusd)})` : ""}.`, url } };
    case "copy_loss_cap":
      return {
        topic: "copy",
        payload: {
          title: "Copy trade: loss cap reached",
          body: `Your open copies were down ${Math.abs(Number(d.openPnlAusd)).toFixed(2)} AUSD against a ${Number(d.capAusd).toFixed(2)} AUSD cap. Autopilot is closing them and paused this follow.`,
          url,
          tag: `loss-cap-${e.follow_id}`,
        },
      };
    case "grant_expired":
      return { topic: "autopilot", payload: { title: "Autopilot access expired", body: "Renew it with your passkey to keep your rules and copies trading.", url: "/autopilot" } };
    default:
      return null;
  }
}

export class Dispatcher {
  constructor(
    private readonly sql: Sql,
    private readonly push: Push,
  ) {}

  private async cursor(name: string): Promise<number> {
    const rows = await this.sql<{ position: string }[]>`SELECT position FROM cursors WHERE name = ${name}`;
    if (rows[0]) return Number(rows[0].position);
    // A new stream starts at the present, not by replaying history.
    const start = name === "audit" ? await this.sql<{ m: string | null }[]>`SELECT max(id) AS m FROM autopilot_audit` : await this.sql<{ m: string | null }[]>`SELECT max(id) AS m FROM calls WHERE outcome <> 'open'`;
    const position = Number(start[0]?.m ?? 0);
    await this.sql`INSERT INTO cursors (name, position) VALUES (${name}, ${position}) ON CONFLICT DO NOTHING`;
    return position;
  }

  private setCursor(name: string, position: number) {
    return this.sql`UPDATE cursors SET position = ${position} WHERE name = ${name}`;
  }

  async tick(): Promise<{ notified: number }> {
    if (!this.push.enabled) return { notified: 0 };
    let notified = 0;
    const auditFrom = await this.cursor("audit");
    const events = await this.sql<AuditRow[]>`SELECT id, owner, rule_id, follow_id, event, detail FROM autopilot_audit WHERE id > ${auditFrom} ORDER BY id LIMIT 500`;
    for (const e of events) {
      const n = auditNotification(e);
      if (n) notified += await this.push.notify(e.owner, n.topic, n.payload);
    }
    if (events.length > 0) await this.setCursor("audit", Number(events.at(-1)!.id));

    // Resolved calls notify the caller's linked account (an unlinked identity has no devices here).
    const callsFrom = await this.cursor("calls");
    const calls = await this.sql<{ id: string; identifier: string; direction: string; outcome: string; linked_account: string | null }[]>`
      SELECT c.id, c.identifier, c.direction, c.outcome, cl.linked_account FROM calls c JOIN callers cl ON cl.address = c.caller
       WHERE c.outcome <> 'open' AND c.id > ${callsFrom} ORDER BY c.id LIMIT 500`;
    for (const c of calls) {
      if (!c.linked_account || c.outcome === "void") continue;
      notified += await this.push.notify(c.linked_account, "calls", {
        title: c.outcome === "hit" ? "Your call hit" : "Your call missed",
        body: `${c.identifier}: attention ${c.direction}`,
        url: `/t/${c.identifier}`,
        tag: `call-${c.id}`,
      });
    }
    if (calls.length > 0) await this.setCursor("calls", Number(calls.at(-1)!.id));
    return { notified };
  }
}
