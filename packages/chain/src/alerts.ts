export interface AlertLog {
  error(fields: Record<string, unknown>, message: string): void;
  info(fields: Record<string, unknown>, message: string): void;
}

/**
 * Raises an alert when a condition starts and a recovery note when it ends, never repeating
 * while it holds. Alerts always go to the log; with a webhook they also go to Slack or Discord.
 */
export class Alerts {
  private readonly firing = new Map<string, string>();

  /**
   * @param source Names the service in webhook messages, such as "Trendr keeper".
   */
  constructor(
    private readonly source: string,
    private readonly log: AlertLog,
    private readonly webhookUrl?: string,
    private readonly post: (url: string, body: string) => Promise<unknown> = (url, body) =>
      fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body }),
  ) {}

  /** Records the state of `key`; `detail` describes it while it holds. */
  set(key: string, holds: boolean, detail: string): void {
    const was = this.firing.has(key);
    if (holds && !was) {
      this.firing.set(key, detail);
      this.log.error({ alert: key, detail }, "alert");
      this.notify(`${this.source} alert: ${detail}`);
    } else if (!holds && was) {
      this.firing.delete(key);
      this.log.info({ alert: key }, "alert resolved");
      this.notify(`${this.source} resolved: ${key}`);
    } else if (holds) {
      this.firing.set(key, detail);
    }
  }

  active(): Record<string, string> {
    return Object.fromEntries(this.firing);
  }

  private notify(text: string) {
    if (!this.webhookUrl) return;
    // Slack reads `text`, Discord reads `content`.
    this.post(this.webhookUrl, JSON.stringify({ text, content: text })).catch((e) =>
      this.log.error({ error: e instanceof Error ? e.message : String(e) }, "alert webhook failed"),
    );
  }
}
