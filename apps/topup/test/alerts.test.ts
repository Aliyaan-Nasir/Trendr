import { describe, expect, test } from "bun:test";
import { AlertBook, type AlertRecord } from "../src/alerts";

const MIN = 60_000;
const HOUR = 60 * MIN;
const quiet = { error() {}, warn() {}, info() {} };

function book(records: Record<string, AlertRecord> = {}) {
  let now = 1_800_000_000_000;
  const posts: string[] = [];
  const alerts = new AlertBook(
    "Trendr top-up",
    quiet,
    records,
    { firstMs: 15 * MIN, maxMs: 12 * HOUR },
    "https://hooks.example/x",
    async (_url, body) => posts.push(JSON.parse(body).text),
    () => now,
  );
  return { alerts, posts, records: () => alerts.state, advance: (ms: number) => (now += ms) };
}

describe("AlertBook", () => {
  test("alerts once, then reminds at 15 minutes doubling to 12 hours, then recovers once", async () => {
    const b = book();
    const reminders: number[] = [];
    let elapsed = 0;
    b.alerts.set("treasury-low", true, "low");
    // Check every 2 minutes for three days.
    for (let i = 0; i < (3 * 24 * 60) / 2; i++) {
      b.advance(2 * MIN);
      elapsed += 2 * MIN;
      const before = b.posts.length;
      b.alerts.set("treasury-low", true, `low at ${i}`);
      if (b.posts.length > before) reminders.push(Math.round(elapsed / MIN));
    }
    await Bun.sleep(0);
    // Reminders land on the first check at or after each due time.
    expect(reminders).toEqual([16, 46, 106, 226, 466, 946, 1666, 2386, 3106, 3826]);
    expect(b.posts[0]).toBe("Trendr top-up alert: low");
    expect(b.posts[1]).toMatch(/^Trendr top-up still firing \(16m\): low at 7$/);
    b.alerts.set("treasury-low", false, "");
    b.alerts.set("treasury-low", false, "");
    await Bun.sleep(0);
    expect(b.posts.at(-1)).toMatch(/^Trendr top-up resolved after 72\.0h: treasury-low$/);
    expect(b.posts.length).toBe(1 + reminders.length + 1);
    expect(b.alerts.active()).toEqual({});
  });

  test("a one-shot alert never repeats while it holds", async () => {
    const b = book();
    for (let i = 0; i < 100; i++) {
      b.alerts.set("halted:oracle", true, "oracle halted", false);
      b.advance(HOUR);
    }
    await Bun.sleep(0);
    expect(b.posts).toEqual(["Trendr top-up alert: oracle halted"]);
  });

  test("dedupes across a restart from persisted records", async () => {
    const first = book();
    first.alerts.set("treasury-low", true, "low");
    first.alerts.set("capped:keeper", true, "keeper capped", false);
    const saved = JSON.parse(JSON.stringify(first.records())) as Record<string, AlertRecord>;

    const second = book(saved);
    second.alerts.set("treasury-low", true, "still low");
    second.alerts.set("capped:keeper", true, "keeper capped", false);
    await Bun.sleep(0);
    expect(second.posts).toEqual([]);
    // The reminder schedule carries over too.
    second.advance(15 * MIN);
    second.alerts.set("treasury-low", true, "still low");
    // A condition that ended while the service was down resolves once.
    second.alerts.set("capped:keeper", false, "");
    await Bun.sleep(0);
    expect(second.posts).toEqual(["Trendr top-up still firing (15m): still low", "Trendr top-up resolved after 15m: capped:keeper"]);
  });

  test("restore swaps in loaded records", () => {
    const b = book();
    b.alerts.set("a", true, "a");
    b.alerts.restore({});
    expect(b.alerts.has("a")).toBe(false);
    expect(b.alerts.keys()).toEqual([]);
  });

  test("logs without a webhook and survives a failing one", async () => {
    const errors: string[] = [];
    const log = { error: (f: Record<string, unknown>) => errors.push(String(f.alert)), warn: (f: Record<string, unknown>) => errors.push(String(f.error)), info() {} };
    const plain = new AlertBook("x", log, {}, { firstMs: MIN, maxMs: HOUR });
    plain.set("k", true, "d");
    const failing = new AlertBook("x", log, {}, { firstMs: MIN, maxMs: HOUR }, "https://hooks.example/x", async () => {
      throw new Error("webhook down");
    });
    failing.set("k", true, "d");
    await Bun.sleep(0);
    expect(errors).toEqual(["k", "k", "webhook down"]);
  });
});
