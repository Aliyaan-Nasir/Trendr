import { expect, test } from "@playwright/test";
import { SESSION_KEY, signInAsAdmin, signInWithConnectedWallet, storedSession } from "./support/session";
import { revokeToken, tokenStatus } from "./support/backend";
import { adminAccount, installWallet, strangerAccount } from "./support/wallet";

const short = (address: string) => `${address.slice(0, 6)}…${address.slice(-4)}`;

test("an admin signs one message, keeps the session across a reload and signs out", async ({ page }) => {
  const admin = adminAccount();
  const probe = await installWallet(page, admin);

  await page.goto("/");
  await expect(page).toHaveURL(/\/system$/);
  await expect(page.getByRole("heading", { name: "Sign in to Trendr admin" })).toBeVisible();

  await page.getByRole("button", { name: "Connect wallet" }).click();
  await expect(page.getByTestId("connected-address")).toHaveText(short(admin.address));
  const sessionRequest = page.waitForRequest((r) => r.url().endsWith("/v1/admin/session") && r.method() === "POST");
  await page.getByRole("button", { name: "Sign in with this wallet" }).click();
  const headers = (await sessionRequest).headers();
  expect(headers["x-trendr-address"]).toBe(admin.address);
  expect(headers["x-trendr-signature"]).toMatch(/^0x[0-9a-f]{130}$/i);
  expect(headers["x-trendr-nonce"]).toMatch(/^[A-Za-z0-9_-]{16,64}$/);

  await expect(page.getByTestId("session-address")).toHaveText(short(admin.address.toLowerCase()));
  // The system view is the landing page.
  await expect(page.getByRole("heading", { name: "System", exact: true })).toBeVisible();
  await expect(page.getByRole("link", { name: "System" })).toHaveAttribute("aria-current", "page");
  expect(probe.signatures).toBe(1);

  // Later requests carry the bearer token, not a new signature.
  const listRequest = page.waitForRequest((r) => r.url().includes("/v1/admin/system"));
  await page.reload();
  expect((await listRequest).headers().authorization).toMatch(/^Bearer \S+/);
  await expect(page.getByTestId("session-address")).toBeVisible();
  expect(probe.signatures).toBe(1);

  // Signing out revokes the token on the backend, not only in this tab.
  const token = (JSON.parse((await storedSession(page))!) as { token: string }).token;
  expect(await tokenStatus(token)).toEqual({ status: 200, error: undefined });
  const revoke = page.waitForResponse((r) => r.url().endsWith("/v1/admin/session/revoke"));
  await page.getByRole("button", { name: "Sign out" }).click();
  expect((await revoke).status()).toBe(200);
  await expect(page.getByRole("heading", { name: "Sign in to Trendr admin" })).toBeVisible();
  expect(await storedSession(page)).toBeNull();
  expect(await tokenStatus(token)).toEqual({ status: 401, error: "session expired; sign in again" });
});

test("signing out still signs out here when the backend cannot be reached", async ({ page }) => {
  await signInAsAdmin(page);
  const token = (JSON.parse((await storedSession(page))!) as { token: string }).token;
  await page.route("**/v1/admin/session/revoke", (route) => route.abort("connectionrefused"));
  await page.getByRole("button", { name: "Sign out" }).click();
  await expect(page.getByRole("heading", { name: "Sign in to Trendr admin" })).toBeVisible();
  expect(await storedSession(page)).toBeNull();
  await revokeToken(token); // The backend never heard about this sign-out; do not leave the token valid.
});

test("a wallet the backend does not list sees its refusal", async ({ page }) => {
  const stranger = strangerAccount();
  await installWallet(page, stranger);
  await page.goto("/candidates");
  await page.getByRole("button", { name: "Connect wallet" }).click();
  await page.getByRole("button", { name: "Sign in with this wallet" }).click();

  const refusal = page.getByRole("alert").filter({ hasText: "This wallet is not an admin" });
  await expect(refusal).toBeVisible();
  await expect(refusal).toContainText("not an admin wallet");
  await expect(refusal).toContainText(stranger.address);
  await expect(page.getByTestId("session-address")).toHaveCount(0);
  expect(await storedSession(page)).toBeNull();
});

test("declining the signature in the wallet leaves the panel signed out", async ({ page }) => {
  await installWallet(page, adminAccount(), { declineSignatures: true });
  await page.goto("/candidates");
  await page.getByRole("button", { name: "Connect wallet" }).click();
  await page.getByRole("button", { name: "Sign in with this wallet" }).click();
  await expect(page.getByRole("alert").filter({ hasText: "Signature declined" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Sign in with this wallet" })).toBeEnabled();
});

test("a session the backend no longer accepts ends with a prompt to sign in again", async ({ page }) => {
  const admin = adminAccount();
  await installWallet(page, admin);
  // A well-formed but forged token, as if the backend's session secret had changed.
  await page.addInitScript(
    ({ key, address }) => {
      if (!sessionStorage.getItem("__e2e-seeded")) {
        sessionStorage.setItem("__e2e-seeded", "1");
        sessionStorage.setItem(key, JSON.stringify({ token: "Zm9yZ2Vk.Zm9yZ2Vk", address, expiresAt: Math.floor(Date.now() / 1000) + 3600 }));
      }
    },
    { key: SESSION_KEY, address: admin.address.toLowerCase() },
  );
  await page.goto("/candidates");
  await expect(page.getByRole("heading", { name: "Sign in to Trendr admin" })).toBeVisible();
  await expect(page.getByText("Your session expired. Sign in again to continue.")).toBeVisible();
  expect(await storedSession(page)).toBeNull();

  // Signing in again recovers.
  await page.getByRole("button", { name: "Connect wallet" }).click();
  await signInWithConnectedWallet(page);
  await expect(page.getByTestId("session-address")).toBeVisible();
});

test("the navigation reaches every screen", async ({ page }) => {
  await signInAsAdmin(page);
  await page.getByRole("link", { name: "Operations" }).click();
  await expect(page).toHaveURL(/\/operations$/);
  await expect(page.getByRole("heading", { name: "Operations" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Operations" })).toHaveAttribute("aria-current", "page");
  await page.getByRole("link", { name: /Candidates/ }).click();
  await expect(page).toHaveURL(/\/candidates$/);
  await page.getByRole("link", { name: "System" }).click();
  await expect(page).toHaveURL(/\/system$/);
  await expect(page.getByRole("heading", { name: "System", exact: true })).toBeVisible();
});
