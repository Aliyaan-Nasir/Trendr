import { expect, test } from "@playwright/test";
import { BACKEND, shots } from "./portfolio.helpers";

/**
 * The public status page against the live services: it shows what GET /v1/status reports (a 503
 * still carries the full status), the live trend count and a chain head that moves with Monad,
 * and it checks again on its own.
 */

interface Status {
  ok: boolean;
  services: Array<{ name: string; ok: boolean; latencyMs: number | null }>;
  oracle: { ok: boolean; lastRunAgeSec: number | null; staleTrends: number };
  chain: { ok: boolean; ageSec: number | null; number: string | null };
}

const fetchStatus = async () => (await (await fetch(`${BACKEND}/v1/status`)).json()) as Status;

test("status: services, oracle and chain, live", async ({ page }) => {
  const expected = await fetchStatus();
  const { trends } = (await (await fetch(`${BACKEND}/v1/trends`)).json()) as { trends: unknown[] };

  await page.goto("/status");
  await expect(page.getByRole("heading", { name: "System status" })).toBeVisible();
  const overall = page.getByTestId("status-overall");
  await expect(overall).toBeVisible();
  await expect(overall).toContainText(/All systems live|Some systems need attention/);

  // Every service the backend probes, with its state.
  const rows = page.getByTestId("status-service");
  await expect(rows).toHaveCount(expected.services.length);
  for (const s of expected.services) {
    const row = page.locator(`[data-testid="status-service"][data-name="${s.name}"]`);
    await expect(row).toBeVisible();
    // A service can flip between the two reads; the page must show a definite state either way.
    await expect(row).toHaveAttribute("data-ok", /true|false/);
  }
  await expect(page.getByTestId("status-services")).toContainText("Keeper");

  // The oracle: how long ago it measured, the live trends and how many lag.
  await expect(page.getByTestId("oracle-age")).toHaveText(/ago$|Never/);
  await expect(page.getByTestId("live-trends")).toHaveText(String(trends.length));
  await expect(page.getByTestId("stale-trends")).toHaveText(/^\d+$/);

  // The chain head moves with Monad's blocks (the page's own head stream).
  const head = page.getByTestId("chain-head");
  await expect(head).toHaveText(/^\d{1,3}(,\d{3})+$/);
  const first = Number((await head.innerText()).replace(/,/g, ""));
  await expect.poll(async () => Number((await head.innerText()).replace(/,/g, "")), { timeout: 20_000 }).toBeGreaterThan(first);

  // It checks again by itself every ten seconds, and on demand.
  await page.waitForRequest((r) => r.url().endsWith("/v1/status"), { timeout: 25_000 });
  const manual = page.waitForRequest((r) => r.url().endsWith("/v1/status"), { timeout: 10_000 });
  await page.getByTestId("status-refresh").click();
  await manual;
  await shots(page, "status");

  // Phones: nothing spills sideways.
  await page.setViewportSize({ width: 375, height: 812 });
  await expect(page.getByTestId("status-chain")).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});
