export interface AlertLog {
  error(fields: Record<string, unknown>, message: string): void;
  warn(fields: Record<string, unknown>, message: string): void;
  info(fields: Record<string, unknown>, message: string): void;
}

/** A firing alert, persisted so a restart neither repeats it early nor forgets to resolve it. */
export interface AlertRecord {
  detail: string;
  since: number;
  lastSentAt: number;
  /** When the next reminder is due; null for alerts that fire once. */
  repeatAt: number | null;
  delayMs: number;
  sent: number;
}

export interface RepeatOptions {
  /** First reminder after this long; each later one waits twice as long, up to maxMs. */
  firstMs: number;
  maxMs: number;
}

export type Post = (url: string, body: string) => Promise<unknown>;

const defaultPost: Post = (url, body) => fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body });

const age = (ms: number) => (ms >= 3_600_000 ? `${(ms / 3_600_000).toFixed(1)}h` : `${Math.max(1, Math.round(ms / 60_000))}m`);

/**
 * Alerts that never spam: a condition alerts once when it starts, reminds with exponential backoff
 * while it holds (or never, for one-shot alerts), and sends one recovery note when it ends. Alerts
 * always go to the log; with a webhook they also go to Slack or Discord.
 */
export class AlertBook {
  constructor(
    private readonly source: string,
    private readonly log: AlertLog,
    private records: Record<string, AlertRecord>,
    private readonly repeat: RepeatOptions,
    private readonly webhookUrl?: string,
    private readonly post: Post = defaultPost,
    private readonly now: () => number = Date.now,
  ) {}

  /** Replaces the records, as loaded from the store. */
  restore(records: Record<string, AlertRecord>): void {
    this.records = records;
  }

  /** The records to persist. */
  get state(): Record<string, AlertRecord> {
    return this.records;
  }

  /**
   * Records whether `key` holds. `detail` describes it while it does; `repeats` false alerts once
   * per occurrence with no reminders.
   */
  set(key: string, holds: boolean, detail: string, repeats = true): void {
    const now = this.now();
    const r = this.records[key];
    if (holds && !r) {
      this.records[key] = { detail, since: now, lastSentAt: now, repeatAt: repeats ? now + this.repeat.firstMs : null, delayMs: this.repeat.firstMs, sent: 1 };
      this.log.error({ alert: key, detail }, "alert");
      this.notify(`${this.source} alert: ${detail}`);
    } else if (holds && r) {
      r.detail = detail;
      if (r.repeatAt !== null && now >= r.repeatAt) {
        const delay = Math.min(r.delayMs * 2, this.repeat.maxMs);
        r.lastSentAt = now;
        r.sent += 1;
        r.delayMs = delay;
        r.repeatAt = now + delay;
        this.log.error({ alert: key, detail, since: r.since, reminder: r.sent - 1 }, "alert still firing");
        this.notify(`${this.source} still firing (${age(now - r.since)}): ${detail}`);
      }
    } else if (!holds && r) {
      delete this.records[key];
      this.log.info({ alert: key, firedFor: now - r.since }, "alert resolved");
      this.notify(`${this.source} resolved after ${age(now - r.since)}: ${key}`);
    }
  }

  has(key: string): boolean {
    return key in this.records;
  }

  keys(): string[] {
    return Object.keys(this.records);
  }

  active(): Record<string, string> {
    return Object.fromEntries(Object.entries(this.records).map(([k, r]) => [k, r.detail]));
  }

  private notify(text: string) {
    if (!this.webhookUrl) return;
    // Slack reads `text`, Discord reads `content`.
    this.post(this.webhookUrl, JSON.stringify({ text, content: text })).catch((e) =>
      this.log.warn({ error: e instanceof Error ? e.message : String(e) }, "alert webhook failed"),
    );
  }
}
