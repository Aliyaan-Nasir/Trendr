import { expect, LIVE, passkeyUses, test } from "./live";
import { BOT_ADDRESS } from "../src/lib/bot";

/**
 * Copy-trading on the live Testnet stack: following the Trendr bot with caps, a slippage limit and a
 * loss cap (granting Autopilot access in the same flow, its key made and sealed in the browser, then
 * approving the follow: two passkey prompts), pausing, resuming and changing caps (each approved by
 * the passkey, a cancelled prompt changing nothing), and unfollowing.
 */

test.skip(!LIVE, "live Testnet spec: run with playwright.live.config.ts");


test("follow the Trendr bot with caps, pause, resume and unfollow", async ({ live, account }) => {
  const { page } = live;
  expect(account).toMatch(/^0x[0-9a-fA-F]{40}$/);
  await page.goto("/copy");
  await expect(page.getByText("Not following anyone yet")).toBeVisible();
  const bot = page.getByTestId("bot-card");
  await expect(bot).toBeVisible();
  await bot.getByTestId("follow-bot").click();

  const sheet = page.getByTestId("follow-sheet");
  await expect(sheet).toBeVisible();
  await expect(sheet.getByRole("heading", { name: "Follow the Trendr bot" })).toBeVisible();

  // Caps are validated like the server validates them.
  await page.getByTestId("follow-max-leverage").fill("15");
  await expect(sheet.getByText("Between 1 and 10")).toBeVisible();
  await page.getByTestId("follow-max-leverage").fill("2");
  await page.getByTestId("follow-ratio").fill("0.5");
  await page.getByTestId("follow-max-margin").fill("30");
  await page.getByTestId("follow-daily-loss").fill("10");
  await page.getByTestId("follow-slippage").fill("5");
  await expect(sheet.getByText("Between 0.05 and 1")).toBeVisible();
  await page.getByTestId("follow-slippage").fill("0.4");
  await page.getByTestId("follow-loss-cap").fill("8");
  const explainer = page.getByTestId("caps-explainer");
  await expect(explainer).toContainText("0.5x their size");
  await expect(explainer).toContainText("never more than 30 AUSD margin");
  await expect(explainer).toContainText("never above 2x");
  await expect(explainer).toContainText("lose 10 AUSD in a UTC day");
  await expect(explainer).toContainText("never fills more than 0.4% worse than their own fill");
  await expect(explainer).toContainText("down 8 AUSD together, Autopilot closes them all");

  // No access yet: following grants it first (one passkey prompt), then the passkey approves the follow.
  await expect(page.getByTestId("follow-submit")).toHaveText("Grant access and start copying");
  await expect(sheet.getByText("Your passkey approves who you copy.")).toBeVisible();
  const before = await passkeyUses(live);
  await page.getByTestId("follow-submit").click();
  const grant = page.getByTestId("grant-sheet");
  await expect(grant).toBeVisible();
  const grantRequest = page.waitForRequest((r) => r.method() === "POST" && r.url().endsWith("/v1/autopilot/grant"));
  await page.getByTestId("grant-approve").click();
  // The key is made and sealed in the browser: the server gets its address and a v2 box, nothing else.
  const asked = JSON.parse((await grantRequest).postData() ?? "{}") as Record<string, unknown>;
  expect(Object.keys(asked).sort()).toEqual(["dailyLimit", "sealedKey", "sessionKey", "validDays"]);
  expect(asked.sessionKey).toMatch(/^0x[0-9a-fA-F]{40}$/);
  expect(asked.sealedKey).toMatch(/^v2\.[A-Za-z0-9_-]+$/);
  // Once granted and approved, the follow goes through and both panels close.
  await expect(grant).toBeHidden({ timeout: 90_000 });
  await expect(sheet).toBeHidden({ timeout: 30_000 });
  expect(await passkeyUses(live)).toBe(before + 2);

  const row = page.locator(`[data-testid="follow-row"][data-leader="${BOT_ADDRESS}"]`);
  await expect(row).toHaveAttribute("data-status", "active");
  await expect(row).toContainText("0.5x their size");
  await expect(row).toContainText("max 30.00 AUSD margin");
  await expect(row).toContainText("up to 2x");
  await expect(row).toContainText("max 0.4% slippage");
  await expect(row).toContainText("loss cap 8.00 AUSD");
  await expect(page.getByTestId("bot-card").getByTestId("follow-bot")).toHaveText("Following: edit caps");

  // Pausing needs no prompt.
  const paused = await passkeyUses(live);
  await row.getByTestId("follow-pause").click();
  await expect(row).toHaveAttribute("data-status", "paused");
  expect(await passkeyUses(live)).toBe(paused);

  // Resuming asks the passkey. A cancelled prompt (the browser rejects with NotAllowedError, as
  // when the user dismisses it) changes nothing and says so; the next approved one resumes.
  await page.evaluate(() => {
    const get = navigator.credentials.get.bind(navigator.credentials);
    navigator.credentials.get = async () => {
      navigator.credentials.get = get;
      throw new DOMException("The operation either timed out or was not allowed.", "NotAllowedError");
    };
  });
  await row.getByTestId("follow-resume").click();
  await expect(page.getByText("The passkey request was cancelled or timed out.")).toBeVisible();
  await expect(row).toHaveAttribute("data-status", "paused");
  const resumed = await passkeyUses(live);
  await row.getByTestId("follow-resume").click();
  await expect(row).toHaveAttribute("data-status", "active");
  expect(await passkeyUses(live)).toBe(resumed + 1);

  // Edit caps in place: the passkey approves the new caps.
  await row.getByRole("button", { name: "Edit caps" }).click();
  await expect(sheet).toBeVisible();
  await expect(sheet.getByText("Your passkey approves new caps.")).toBeVisible();
  await page.getByTestId("follow-max-margin").fill("40");
  const edited = await passkeyUses(live);
  await page.getByTestId("follow-submit").click();
  await expect(sheet).toBeHidden();
  await expect(row).toContainText("max 40.00 AUSD margin");
  expect(await passkeyUses(live)).toBe(edited + 1);

  // Unfollow asks twice (no passkey), then the row leaves.
  const unfollowing = await passkeyUses(live);
  await row.getByTestId("follow-stop").click();
  await expect(row.getByTestId("follow-stop")).toHaveText("Confirm unfollow");
  await row.getByTestId("follow-stop").click();
  await expect(row).toHaveCount(0);
  await expect(page.getByText("Not following anyone yet")).toBeVisible();
  expect(await passkeyUses(live)).toBe(unfollowing);
});
