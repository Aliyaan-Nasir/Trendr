import { type BrowserContext, expect, type Locator, type Page, test } from "@playwright/test";
import { deployments } from "@trendr/contracts";
import { createPublicClient, createWalletClient, erc20Abi, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { monadTestnet } from "viem/chains";
import { callNote, threadPost } from "./content";
import { waitForSeries } from "./portfolio.helpers";

/**
 * The trend page on live Monad Testnet, as a new user would use it: a passkey account (Chrome's
 * virtual authenticator with PRF), test AUSD from the faucet, then every ticket with real
 * transactions: buy and sell Up, mint and redeem pairs, open and close an attention perp, launch,
 * buy and sell the trend coin (each coin trade confirmed with the passkey), open and close a Perpl
 * position, and a signed call and post.
 *
 * Opening a Perpl account takes 100 AUSD, more than the faucet's daily 100 leaves after the other
 * trades, so E2E_FUNDER_PRIVATE_KEY (a Testnet wallet holding AUSD) tops the account up. Without
 * it the Perpl step is skipped.
 */

const BACKEND = process.env.E2E_BACKEND_URL ?? "http://localhost:4000";
const RPC = process.env.E2E_RPC_URL ?? "https://testnet-rpc.monad.xyz";
const d = deployments[10143]!;

async function addAuthenticator(context: BrowserContext, page: Page) {
  const cdp = await context.newCDPSession(page);
  await cdp.send("WebAuthn.enable", { enableUI: false });
  await cdp.send("WebAuthn.addVirtualAuthenticator", {
    options: { protocol: "ctap2", ctap2Version: "ctap2_1", transport: "internal", hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true, hasPrf: true },
  });
}

/** Waits for a ticket's transaction to finalize, failing with the app's own error if it failed. */
async function settled(scope: Locator | Page, id: string, label: string) {
  const status = scope.getByTestId(id);
  await expect(status).toHaveAttribute("data-stage", /filled|final|failed/, { timeout: 120_000 });
  await expect(status).toHaveAttribute("data-stage", /final|failed/, { timeout: 60_000 });
  const text = await status.innerText();
  if ((await status.getAttribute("data-stage")) === "failed") throw new Error(`${label} failed: ${text}`);
  // The app measures send to fill itself ("Bought in 0.8s").
  console.log(`${label}: ${text.replace(/\s+/g, " ").trim()}`);
}

async function topUp(to: `0x${string}`, amount: bigint) {
  const key = process.env.E2E_FUNDER_PRIVATE_KEY;
  if (!key) return false;
  const account = privateKeyToAccount((key.startsWith("0x") ? key : `0x${key}`) as `0x${string}`);
  const wallet = createWalletClient({ chain: monadTestnet, transport: http(RPC), account });
  const client = createPublicClient({ chain: monadTestnet, transport: http(RPC) });
  const hash = await wallet.writeContract({ address: d.ausd, abi: erc20Abi, functionName: "transfer", args: [to, amount], gas: 80_000n });
  return (await client.waitForTransactionReceipt({ hash })).status === "success";
}

test("every ticket on the trend page, with real Testnet transactions", async ({ browser }) => {
  // E2E_TREND, or a live trend whose listed 24-hour series the market maker is quoting: trends
  // come and go (and re-list as `.2`), so a fixed default goes stale.
  const TREND = process.env.E2E_TREND ?? (await waitForSeries(10 * 60_000)).identifier;
  console.log(`trend ${TREND}`);
  // The trend must be live with a listed 24-hour series, or there is nothing to trade.
  const detail = (await (await fetch(`${BACKEND}/v1/trends/${TREND}`)).json()) as { trend: { status: string; ticker: string | null } };
  expect(detail.trend.status, `${TREND} must be active`).toBe("active");

  const context = await browser.newContext();
  const page = await context.newPage();
  page.on("pageerror", (e) => console.log(`page error: ${e.message}`));
  await page.goto("/");
  await addAuthenticator(context, page);

  await test.step("sign up with a passkey", async () => {
    await page.getByRole("button", { name: "Sign in" }).first().click();
    await page.getByTestId("create-account").click();
    await expect(page.getByTestId("account-address")).toBeVisible({ timeout: 90_000 });
  });
  const address = (await page.getByTestId("account-address").getAttribute("data-address")) as `0x${string}`;
  console.log(`account ${address}`);
  await page.keyboard.press("Escape");

  await test.step("take test AUSD from the faucet", async () => {
    await page.getByRole("button", { name: /Add funds/ }).first().click();
    const sheet = page.getByTestId("deposit-sheet");
    await sheet.getByRole("button", { name: "Get test AUSD" }).click();
    await expect(sheet).toContainText("100.00", { timeout: 60_000 });
    // A busy sheet ignores Escape until the faucet request finishes.
    await expect(async () => {
      await page.keyboard.press("Escape");
      await expect(sheet).toBeHidden({ timeout: 1_000 });
    }).toPass({ timeout: 30_000 });
  });
  const funded = await topUp(address, 150_000_000n);

  await page.goto(`/t/${TREND}`);
  const panel = page.getByTestId("trade-panel");
  await expect(panel).toBeVisible();

  await test.step("buy Up, then sell it back", async () => {
    await panel.getByTestId("outcome-side-up").click();
    await panel.getByTestId("outcome-amount").fill("3");
    await panel.getByTestId("outcome-submit").click();
    await settled(panel, "outcome-tx", "buy Up");
    await expect(panel.getByTestId("holding-up")).not.toHaveText("0.00");
    await panel.getByRole("radio", { name: "Sell", exact: true }).click();
    await panel.getByTestId("outcome-side-up").click();
    await panel.getByRole("button", { name: /Max/ }).click();
    await panel.getByTestId("outcome-submit").click();
    await settled(panel, "outcome-tx", "sell Up");
    await expect(panel.getByTestId("holding-up")).toHaveText("0.00");
  });

  await test.step("mint two pairs and redeem them", async () => {
    await panel.getByRole("button", { name: "Pairs" }).click();
    await panel.getByTestId("mint-amount").fill("2");
    await panel.getByTestId("mint-pairs").click();
    await expect(panel.getByTestId("holding-down")).toHaveText("2.00");
    await expect(panel.getByTestId("holding-up")).toHaveText("2.00");
    await panel.getByTestId("redeem-pairs").click();
    await expect(panel.getByTestId("holding-down")).toHaveText("0.00");
    await expect(panel.getByTestId("pairs-tx")).toHaveAttribute("data-stage", "final");
  });

  await test.step("open and close an attention perp", async () => {
    await panel.getByRole("radio", { name: "Perp", exact: true }).click();
    await panel.getByTestId("perp-margin").fill("10");
    await expect(panel.getByTestId("perp-preview")).toContainText("Liquidation index");
    await panel.getByTestId("perp-submit").click();
    await settled(panel, "perp-tx", "open perp");
    const position = panel.getByTestId("perp-position");
    await expect(position).toHaveCount(1);
    await position.getByTestId("perp-close").click();
    await expect(position).toHaveCount(0, { timeout: 90_000 });
  });

  await test.step("launch, buy and sell the trend coin", async () => {
    await panel.getByRole("radio", { name: "Coin", exact: true }).click();
    const launch = panel.getByTestId("coin-launch");
    const amount = panel.getByTestId("coin-amount");
    await expect(launch.or(amount)).toBeVisible();
    if (await launch.isVisible()) {
      await launch.click();
      await expect(amount).toBeVisible({ timeout: 120_000 });
    }
    await amount.fill("5");
    await panel.getByTestId("coin-submit").click();
    await settled(panel, "coin-tx", "buy coin");
    await panel.getByRole("radio", { name: "Sell", exact: true }).click();
    await panel.getByRole("button", { name: /Max/ }).click();
    await panel.getByTestId("coin-submit").click();
    await settled(panel, "coin-tx", "sell coin");
  });

  await test.step("open and close a Perpl position", async () => {
    // test.skip here would skip every later step too, so this step alone is left out.
    if (!funded || !detail.trend.ticker) {
      test.info().annotations.push({ type: "skipped step", description: "Perpl needs E2E_FUNDER_PRIVATE_KEY and a Perpl-listed ticker" });
      console.log("Perpl step skipped: needs E2E_FUNDER_PRIVATE_KEY and a Perpl-listed ticker");
      return;
    }
    await panel.getByRole("radio", { name: detail.trend.ticker!, exact: true }).click();
    await panel.getByTestId("perpl-margin").fill("20");
    await panel.getByTestId("perpl-submit").click();
    await settled(panel, "perpl-tx", "Perpl open");
    await expect(panel.getByText(/^Filled /)).toBeVisible();
    const position = panel.getByTestId("perpl-position");
    await expect(position).toHaveCount(1);
    await position.getByTestId("perpl-close").click();
    await expect(position).toHaveCount(0, { timeout: 90_000 });
  });

  await test.step("make a signed call and a post", async () => {
    // Sign-up derives the caller identity on this device, so the thread needs no second prompt.
    await expect(page.getByTestId("thread-text")).toBeVisible();
    await expect(page.getByTestId("unlock-identity")).toHaveCount(0);
    const note = callNote();
    await page.getByTestId("thread-text").fill(note);
    await page.getByTestId("thread-submit").click();
    await expect(page.getByTestId("call-row").first()).toContainText(note);
    await page.getByRole("radio", { name: /^Talk/ }).click();
    const post = threadPost();
    await page.getByTestId("thread-text").fill(post);
    await page.getByTestId("thread-submit").click();
    await expect(page.getByTestId("post-row").first()).toContainText(post);
  });

  await context.close();
});
