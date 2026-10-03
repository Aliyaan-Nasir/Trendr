import { expect, LIVE, passkeyUses, test } from "./live";

/**
 * Autopilot on the live Testnet stack, as a new user: the rule builder's validation, a real
 * backtest, saving a draft, granting Autopilot access and approving the rule with the passkey while
 * enabling, then pausing (no prompt), resuming (one prompt), stopping and revoking.
 */

test.skip(!LIVE, "live Testnet spec: run with playwright.live.config.ts");

test("build, backtest, save, grant, enable, pause, stop and revoke a rule", async ({ live, account }) => {
  const { page } = live;
  expect(account).toMatch(/^0x[0-9a-fA-F]{40}$/);

  // The builder starts from a valid rule on the hottest live trend whose own coin Perpl lists
  // (trading that coin), or on the hottest live trend when Perpl lists none. The validation below
  // is written against ETH, so the market moves there.
  await page.goto("/autopilot/new");
  const form = page.getByTestId("rule-form");
  const trend = page.getByTestId("rule-trend");
  await expect(trend).toBeVisible();
  // The options list Perpl's coins first, each group hottest first.
  const options = await trend.locator("option").evaluateAll((os) => os.map((o) => (o as HTMLOptionElement).value));
  expect(options.length).toBeGreaterThan(0);
  await expect(trend).toHaveValue(options[0]!);
  await expect(page.getByTestId("rule-market")).not.toHaveValue("");
  await page.getByTestId("rule-market").selectOption("ETH");

  // Validation uses the server's schema: leverage above Perpl's cap or the session's, a stop past
  // liquidation, and a position above the maximum are all refused before anything is sent.
  await page.getByTestId("rule-leverage").fill("30");
  await expect(form.getByText("Perpl allows at most 12x on ETH").or(form.getByText("Must be at most 20"))).toBeVisible();
  // Rules trade through Autopilot's session, whose order guard opens at up to 10x.
  await page.getByTestId("rule-leverage").fill("11");
  await expect(form.getByText("Autopilot opens at up to 10x from your account")).toBeVisible();
  await page.getByTestId("rule-leverage").fill("4");
  await page.getByTestId("rule-stop").fill("30");
  await expect(form.getByText(/beyond.*liquidation/i)).toBeVisible();
  await page.getByTestId("rule-stop").fill("5");
  await page.getByTestId("rule-max-position").fill("50");
  await expect(form.getByText("Margin times leverage is above the maximum position")).toBeVisible();
  await expect(page.getByTestId("run-backtest")).toBeDisabled();
  await page.getByTestId("rule-max-position").fill("100");
  await page.getByTestId("rule-leverage").fill("2");
  await expect(page.getByTestId("run-backtest")).toBeEnabled();

  // A rule that will not fire during the test (the new account holds no AUSD to post margin):
  // attention up 400% within 15 minutes.
  await page.getByTestId("rule-change").fill("400");
  await page.getByLabel("Window").selectOption("15");
  await page.getByTestId("rule-name").fill(`Attention breakout ${Date.now().toString(36)}`);
  await expect(page.getByTestId("rule-enable")).toBeDisabled();

  // A real backtest over three days of Perpl candles and the trend's attention.
  await page.getByRole("radio", { name: "3d" }).click();
  await page.getByTestId("run-backtest").click();
  const result = page.getByTestId("backtest-result");
  await expect(result).toBeVisible({ timeout: 120_000 });
  await expect(page.getByTestId("backtest-stats").getByText("PnL after fees")).toBeVisible();
  await expect(page.getByTestId("backtest-stats").getByText("Win rate")).toBeVisible();
  await expect(page.getByTestId("backtest-stats").getByText("Max drawdown")).toBeVisible();
  await expect(page.getByTestId("backtest-stats").getByText("Profit factor")).toBeVisible();
  // It never fires, so the line says so instead of calling it ready; it can still be enabled.
  await expect(page.getByTestId("ready-line")).toHaveText(/never fired/);

  // Any change makes the backtest out of date until it runs again.
  await page.getByTestId("rule-target").fill("12");
  await expect(page.getByTestId("ready-line")).toHaveText(/changed since the backtest/);
  await expect(page.getByTestId("rule-enable")).toBeDisabled();
  await page.getByTestId("rule-target").fill("10");
  await expect(page.getByTestId("ready-line")).toHaveText(/never fired/);

  // Save as a draft: it shows on /autopilot as a draft.
  await page.getByTestId("rule-save").click();
  await expect(page).toHaveURL(/\/autopilot\/new\?edit=\d+/);
  const id = Number(new URL(page.url()).searchParams.get("edit"));
  await expect(page.getByTestId("rule-save")).toHaveText("Saved");
  await page.goto("/autopilot");
  const row = page.locator(`[data-testid="rule-row"][data-rule-id="${id}"]`);
  await expect(row).toHaveAttribute("data-status", "draft");
  await expect(page.getByTestId("grant-card")).toHaveAttribute("data-state", "none");

  // Back to the draft: backtest it and enable. Autopilot has no access yet, so enabling asks for
  // it first (one passkey prompt), then the passkey approves this rule (a second), and it runs.
  await row.getByRole("link", { name: "Backtest and enable" }).click();
  await expect(page).toHaveURL(new RegExp(`edit=${id}`));
  await page.getByTestId("run-backtest").click();
  await expect(page.getByTestId("ready-line")).toHaveText(/never fired/, { timeout: 120_000 });
  const before = await passkeyUses(live);
  await page.getByTestId("rule-enable").click();
  const grant = page.getByTestId("grant-sheet");
  await expect(grant).toBeVisible();
  await expect(grant.getByText("Withdraw from Perpl or send AUSD anywhere else")).toBeVisible();
  await grant.getByRole("radio", { name: "250" }).click();
  await page.getByTestId("grant-approve").click();
  await expect(page).toHaveURL(new RegExp(`/autopilot/${id}$`), { timeout: 90_000 });
  expect(await passkeyUses(live)).toBe(before + 2);

  // Rule detail: running, with its audit log. The Autopilot executor caches grants at the start
  // of each 15 s tick, so a rule enabled in the same tick as its grant can be paused with "no
  // active Autopilot grant" (reported; fix belongs in apps/autopilot Venues.forOwner). Record
  // it and resume, as a user would, rather than let the race decide the run.
  const status = page.getByTestId("rule-status");
  await expect(status).toHaveAttribute("data-status", /enabled|paused/);
  if ((await status.getAttribute("data-status")) === "paused") {
    await expect(status).toContainText("Autopilot has no access to your account");
    test.info().annotations.push({ type: "executor race", description: "rule auto-paused right after its grant; resumed" });
    await page.getByTestId("rule-resume").click();
  }
  await expect(status).toHaveAttribute("data-status", "enabled");
  const log = page.getByTestId("audit-log");
  await expect(log.locator('[data-event="rule_enabled"]')).toBeVisible();
  await expect(log.locator('[data-event="rule_created"]')).toBeVisible();

  // The grant shows on /autopilot with its cap.
  await page.goto("/autopilot");
  await expect(page.getByTestId("grant-card")).toHaveAttribute("data-state", "active");
  await expect(page.getByTestId("grant-card")).toContainText("250.00 AUSD a day");
  await expect(row).toHaveAttribute("data-status", "enabled");

  // Pause from the list (no prompt); resume from the detail page (the passkey approves it), pause
  // again, then stop (stop asks twice, no prompt).
  const pausing = await passkeyUses(live);
  await row.getByTestId("rule-pause").click();
  await expect(row).toHaveAttribute("data-status", "paused");
  expect(await passkeyUses(live)).toBe(pausing);
  await row.getByRole("link", { name: "Details" }).click();
  await expect(page.getByTestId("rule-status")).toHaveAttribute("data-status", "paused");
  await expect(page.getByTestId("audit-log").locator('[data-event="rule_paused"]')).toBeVisible();
  await page.getByTestId("rule-resume").click();
  await expect(page.getByTestId("rule-status")).toHaveAttribute("data-status", "enabled");
  expect(await passkeyUses(live)).toBe(pausing + 1);
  await page.getByTestId("rule-pause").click();
  await expect(page.getByTestId("rule-status")).toHaveAttribute("data-status", "paused");
  await page.getByTestId("rule-stop").click();
  await expect(page.getByTestId("rule-stop")).toHaveText(/Stop for good|Stop and close position/);
  await page.getByTestId("rule-stop").click();
  await expect(page.getByTestId("rule-status")).toHaveAttribute("data-status", "stopped");
  await expect(page.getByTestId("audit-log").locator('[data-event="rule_stopped"]')).toBeVisible();

  // Stopped rules leave the list; revoking the grant removes the key on chain (one prompt).
  await page.goto("/autopilot");
  await expect(row).toHaveCount(0);
  const card = page.getByTestId("grant-card");
  await card.getByTestId("grant-revoke").click();
  await expect(card.getByTestId("grant-revoke")).toHaveText("Confirm with passkey");
  const beforeRevoke = await passkeyUses(live);
  await card.getByTestId("grant-revoke").click();
  await expect(card).toHaveAttribute("data-state", "revoked", { timeout: 90_000 });
  expect(await passkeyUses(live)).toBe(beforeRevoke + 1);
});
