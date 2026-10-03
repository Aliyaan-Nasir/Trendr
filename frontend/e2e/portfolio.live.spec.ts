import { expect, test } from "@playwright/test";
import { tokenAmount } from "../src/lib/format";
import { outcome, perp, spot } from "../src/lib/trade/calls";
import { act, addAuthenticator, ausdOf, balanceOf, fundFromFaucet, indexOf, minUpOut, openCurve, pub, sessionOf, shots, signUp, trade, waitForBids, waitForSeries } from "./portfolio.helpers";

/**
 * The portfolio on live Monad Testnet, as a new user meets it: signed out, then a new passkey
 * account funded from the faucet, then real positions (pairs minted on a 24-hour series, UP
 * bought on Kuru, a 2x attention perp) that the portfolio values live and acts on: add margin,
 * redeem the pairs, close the perp and sell the UP, all gas-free through the relayer.
 */

// Holdings and cash read as the app writes them: cut, never rounded up, to two decimals.
const tokens = (raw: bigint) => tokenAmount(raw, 6);
const decimal = (raw: bigint) => (Number(raw) / 1e6).toFixed(6);
const PAIRS = 2_000_000n;
const UP_SPEND = 3_000_000n;
const PERP_MARGIN = 5_000_000n;
const COIN_SPEND = 2_000_000n;

test("portfolio: live positions, valued and acted on", async ({ browser }) => {
  // A series with hours to run and UP on offer, before spending anything.
  const series = await waitForSeries(10 * 60_000);
  console.log(`trading ${series.identifier}, series ${series.seriesId.slice(0, 10)}`);

  const context = await browser.newContext();
  const page = await context.newPage();
  page.on("pageerror", (e) => console.log(`page error: ${e.message}`));
  await page.goto("/portfolio");

  // Signed out: one clear way in.
  await expect(page.getByRole("heading", { name: "Portfolio" })).toBeVisible();
  await expect(page.getByText("Sign in to see your portfolio")).toBeVisible();
  await shots(page, "portfolio-signed-out");

  await addAuthenticator(context, page);
  const address = await signUp(page);
  console.log(`account ${address}`);
  await fundFromFaucet(page, address);
  const cash = await ausdOf(address);

  // Funded, no positions: the empty state and the cash in the totals.
  await expect(page.getByTestId("portfolio-empty")).toBeVisible();
  await expect(page.getByTestId("total-cash")).toHaveText(tokens(cash));
  await expect(page.getByTestId("live-block")).toContainText("block");
  await shots(page, "portfolio-empty");

  // Real positions, through the trade library and the device's own session key.
  const session = await sessionOf(page);
  expect(session.account.toLowerCase()).toBe(address.toLowerCase());
  await trade(session, outcome.mint(series.seriesId, PAIRS, address));
  await trade(session, spot.buy(series.up, UP_SPEND, await minUpOut(series.upMarket, UP_SPEND), address));
  const index = await indexOf(series.trendId);
  await trade(session, perp.open(series.trendId, true, PERP_MARGIN, 2, (index * 101n) / 100n));
  // A trend coin on its bonding curve, when one is live. Coin trades are passkey actions (a session
  // key cannot trade the curve), so the coin is bought on its trend page as a user would.
  const coinCurve = await openCurve();
  if (coinCurve) {
    await page.goto(`/t/${coinCurve.identifier}`);
    const panel = page.getByTestId("trade-panel");
    await panel.getByRole("radio", { name: "Coin", exact: true }).click();
    await panel.getByTestId("coin-amount").fill(String(Number(COIN_SPEND) / 1e6));
    await act(panel.getByTestId("coin-submit"), panel, "coin-tx", "Buy coin");
    await page.goto("/portfolio");
  } else console.log("no trend coin is on a curve right now: the coin steps are skipped");
  const up = await balanceOf(series.up, address);
  const bought = up - PAIRS;
  expect(bought).toBeGreaterThan(0n);

  // The portfolio picks them up as blocks arrive, valued live.
  const row = page.locator(`[data-testid="outcome-row"][data-series="${series.seriesId}"]`);
  await expect(row).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId("portfolio-empty")).toBeHidden();
  await expect(row.getByTestId("balance-up")).toHaveText(tokens(up));
  await expect(row.getByTestId("balance-down")).toHaveText(tokens(PAIRS));
  await expect(row.getByTestId("redeem-sets")).toHaveText(`Redeem ${tokens(PAIRS)} sets`);
  const perpRow = page.getByTestId("perp-row");
  await expect(perpRow).toHaveCount(1);
  await expect(perpRow).toContainText("Long");
  await expect(page.getByTestId("total-outcomes")).not.toHaveText("0.00");
  await expect(page.getByTestId("total-perps")).not.toHaveText("0.00");
  await expect(page.getByTestId("portfolio-unrealized")).toBeVisible();
  const coinRow = page.getByTestId("coin-row");
  if (coinCurve) await expect(coinRow).toHaveCount(1);
  await shots(page, "portfolio-positions");

  // How hard the live portfolio leans on the public RPC (about 15 requests a second per address).
  let rpcCalls = 0;
  const count = (r: import("@playwright/test").Request) => {
    if (r.method() !== "POST" || !r.url().includes("rpc")) return;
    const body = r.postDataJSON() as unknown;
    rpcCalls += Array.isArray(body) ? body.length : 1;
  };
  page.on("request", count);
  await page.waitForTimeout(20_000);
  page.off("request", count);
  console.log(`portfolio RPC load: ${(rpcCalls / 20).toFixed(1)} requests a second`);

  // Add margin to the perp: the liquidation index moves away.
  const perpBefore = await perpRow.innerText();
  await perpRow.getByTestId("add-margin").click();
  const margin = page.getByTestId("add-margin-sheet");
  await expect(margin).toBeVisible();
  await margin.getByTestId("margin-amount").fill("1");
  await shots(page, "portfolio-add-margin-sheet", false);
  await act(margin.getByTestId("confirm-add-margin"), margin, "add-margin-tx", "Add margin");
  await margin.getByRole("button", { name: "Done" }).click();
  await expect(margin).toBeHidden();
  await expect.poll(() => perpRow.innerText(), { timeout: 30_000 }).not.toBe(perpBefore);

  // Redeem both pairs for exactly 2 AUSD: the bought UP stays.
  const ausdBeforeRedeem = await ausdOf(address);
  await act(row.getByTestId("redeem-sets"), row, "redeem-tx", "Redeem pairs");
  expect(await balanceOf(series.down, address)).toBe(0n);
  expect(await balanceOf(series.up, address)).toBe(bought);
  expect((await ausdOf(address)) - ausdBeforeRedeem).toBe(PAIRS);
  await expect(row.getByTestId("balance-down")).toBeHidden({ timeout: 30_000 });
  await expect(row.getByTestId("balance-up")).toHaveText(tokens(bought));
  await expect(row.getByTestId("redeem-sets")).toBeHidden();

  // Close the perp, then share the verified result.
  await perpRow.getByTestId("close-perp").click();
  const close = page.getByTestId("close-perp-sheet");
  await expect(close).toBeVisible();
  await shots(page, "portfolio-close-sheet", false);
  await act(close.getByTestId("confirm-close-perp"), close, "close-perp-tx", "Close perp");
  await expect(close.getByTestId("perp-closed")).toBeVisible({ timeout: 30_000 });
  await expect(close.getByRole("button", { name: "Share to X" })).toBeVisible();
  await shots(page, "portfolio-perp-closed", false);
  const sharePath = await close.locator("[data-share-path]").getAttribute("data-share-path");
  await close.getByRole("button", { name: "Done" }).click();
  await expect(close).toBeHidden();
  await expect(perpRow).toHaveCount(0, { timeout: 30_000 });

  // The result's share page checks itself against the closing transaction.
  const share = await context.newPage();
  await share.goto(sharePath!);
  await expect(share.getByText("Verified on Monad")).toBeVisible();
  await expect(share.getByRole("button", { name: "Share to X" })).toBeVisible();
  const card = await share.request.get(`/share/pnl/image?${sharePath!.split("?")[1]}`);
  expect(card.status()).toBe(200);
  expect(card.headers()["content-type"]).toBe("image/png");
  await shots(share, "share-pnl-verified");
  await share.close();

  // Sell the trend coin back to its curve with the passkey (the curve burns it; no approval is involved).
  if (coinCurve) {
    await coinRow.getByTestId("sell-coin").click();
    const sellCoin = page.getByTestId("sell-coin-sheet");
    await expect(sellCoin).toBeVisible();
    await expect(sellCoin.getByTestId("confirm-sell-coin")).toBeEnabled({ timeout: 15_000 });
    await shots(page, "portfolio-sell-coin-sheet", false);
    await act(sellCoin.getByTestId("confirm-sell-coin"), sellCoin, "sell-coin-tx", "Sell coin");
    expect(await balanceOf(coinCurve.coin, address)).toBe(0n);
    await sellCoin.getByRole("button", { name: "Done" }).click();
    await expect(sellCoin).toBeHidden();
    await expect(coinRow).toHaveCount(0, { timeout: 30_000 });
  }

  // History from the indexer: a definite state (the record, empty, or unavailable), then this
  // run's trades once the indexer has caught up (it may be resyncing, so that part only logs).
  const historySection = page.getByTestId("history-section");
  await expect(historySection).toBeVisible();
  await expect(historySection.getByTestId(/^history-(activity|empty|unavailable)$/).first()).toBeVisible({ timeout: 30_000 });
  const indexed = await expect
    .poll(() => historySection.locator('[data-testid="history-item"][data-kind="perp"]').count(), { timeout: 90_000 })
    .toBeGreaterThan(0)
    .then(() => true)
    .catch(() => false);
  console.log(indexed ? "history: the indexer lists this run's perp" : "history: the indexer has not caught up with this run yet");
  if (indexed) await shots(page, "portfolio-history");

  // Sell the UP bought on Kuru (once the market maker bids for it): nothing is left in the series.
  await waitForBids(series.upMarket, bought, 15 * 60_000);
  await row.getByTestId("sell-up").click();
  const sell = page.getByTestId("sell-outcome-sheet");
  await expect(sell).toBeVisible();
  await expect(sell.getByTestId("sell-amount")).toHaveValue(decimal(bought).replace(/0+$/, "").replace(/\.$/, ""));
  await expect(sell.getByTestId("confirm-sell")).toBeEnabled({ timeout: 15_000 });
  await shots(page, "portfolio-sell-sheet", false);
  const ausdBeforeSell = await ausdOf(address);
  await act(sell.getByTestId("confirm-sell"), sell, "sell-tx", "Sell UP");
  expect(await balanceOf(series.up, address)).toBe(0n);
  expect(await ausdOf(address)).toBeGreaterThan(ausdBeforeSell);
  await sell.getByRole("button", { name: "Done" }).click();
  await expect(sell).toBeHidden();
  await expect(row).toBeHidden({ timeout: 30_000 });

  // Everything closed: the empty state again, with the proceeds back in cash.
  await expect(page.getByTestId("portfolio-empty")).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId("total-cash")).toHaveText(tokens(await ausdOf(address)), { timeout: 15_000 });
  console.log(`done at block ${await pub.getBlockNumber()}`);
  await context.close();
});
