import { describe, expect, test } from "bun:test";
import { Alerts } from "../src/alerts";

describe("Alerts", () => {
  test("notifies once when a condition starts and once when it ends", async () => {
    const posts: string[] = [];
    const errors: string[] = [];
    const alerts = new Alerts(
      "Trendr keeper",
      { error: (f) => errors.push(String(f.alert ?? f.error)), info() {} },
      "https://hooks.example/x",
      async (_url, body) => posts.push(JSON.parse(body).text),
    );
    alerts.set("oracle-stale", true, "2 of 3 stale");
    alerts.set("oracle-stale", true, "3 of 3 stale");
    alerts.set("head-lag", false, "fine");
    expect(alerts.active()).toEqual({ "oracle-stale": "3 of 3 stale" });
    alerts.set("oracle-stale", false, "");
    await Bun.sleep(0);
    expect(posts).toEqual(["Trendr keeper alert: 2 of 3 stale", "Trendr keeper resolved: oracle-stale"]);
    expect(errors).toEqual(["oracle-stale"]);
    expect(alerts.active()).toEqual({});
  });
});
