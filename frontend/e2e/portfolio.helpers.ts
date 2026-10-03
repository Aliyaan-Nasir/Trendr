import { bondingCurveAbi, type Call, decodeL2, iKuruOrderBookAbi, minimumOut, passkeyAccountAbi, quoteBuy, sessionExecuteTypedData, trendRegistryAbi, trendrLensAbi } from "@trendr/contracts";
import { type BrowserContext, expect, type Locator, type Page } from "@playwright/test";
import { type Address, createPublicClient, erc20Abi, type Hex, http, type Transport, zeroAddress } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { DEPLOYMENT, RELAYER_URL, RPC_URL } from "../src/lib/config";

/**
 * Helpers for the portfolio and status specs against the live Monad Testnet services: a passkey
 * account created with Chrome's virtual authenticator (PRF on), funded from the app's faucet, and
 * trading through the relayer with the very session key the app keeps on the device.
 */

export const BACKEND = (process.env.E2E_BACKEND_URL ?? "http://localhost:4000").replace(/\/$/, "");
/**
 * The public RPC allows about 15 requests a second per address, shared with the app under test
 * (and anything else on this machine), and answers the excess with a plain JSON-RPC error that
 * viem does not retry. Reads here wait and try again instead of failing the run.
 */
function patient(inner: Transport): Transport {
  return (opts) => {
    const t = inner(opts);
    const request = (async (args: Parameters<typeof t.request>[0]) => {
      for (let attempt = 0; ; attempt++) {
        try {
          return await t.request(args);
        } catch (e) {
          const limited = /limited to|rate limit|too many requests|429/i.test(e instanceof Error ? `${e.message} ${(e as { details?: string }).details ?? ""}` : String(e));
          if (!limited || attempt >= 12) throw e;
          await new Promise((r) => setTimeout(r, 400 + attempt * 300));
        }
      }
    }) as typeof t.request;
    return { ...t, request };
  };
}

export const pub = createPublicClient({ transport: patient(http(RPC_URL, { retryCount: 3 })) });
const d = DEPLOYMENT;

export async function addAuthenticator(context: BrowserContext, page: Page) {
  const cdp = await context.newCDPSession(page);
  await cdp.send("WebAuthn.enable", { enableUI: false });
  const { authenticatorId } = await cdp.send("WebAuthn.addVirtualAuthenticator", {
    options: {
      protocol: "ctap2",
      ctap2Version: "ctap2_1",
      transport: "internal",
      hasResidentKey: true,
      hasUserVerification: true,
      isUserVerified: true,
      automaticPresenceSimulation: true,
      hasPrf: true,
    },
  });
  return { cdp, authenticatorId };
}

/** Creates a brand-new passkey account through the account sheet, signed in to the backend. */
export async function signUp(page: Page): Promise<Address> {
  await page.getByRole("button", { name: "Sign in" }).first().click();
  const sheet = page.getByTestId("account-sheet");
  await expect(sheet).toBeVisible();
  await page.getByTestId("create-account").click();
  const address = page.getByTestId("account-address");
  await expect(address).toBeVisible({ timeout: 90_000 });
  await expect(sheet.getByText("Synced")).toBeVisible({ timeout: 30_000 });
  const value = (await address.getAttribute("data-address")) as Address;
  await page.keyboard.press("Escape");
  await expect(sheet).toBeHidden();
  return value;
}

export const ausdOf = (owner: Address) => pub.readContract({ address: d.ausd, abi: erc20Abi, functionName: "balanceOf", args: [owner] });
export const balanceOf = (token: Address, owner: Address) => pub.readContract({ address: token, abi: erc20Abi, functionName: "balanceOf", args: [owner] });

/** Takes the day's test AUSD from the Add funds sheet and waits for it to land. */
export async function fundFromFaucet(page: Page, owner: Address) {
  const before = await ausdOf(owner);
  await page.getByRole("button", { name: /AUSD balance .* Add funds/ }).click();
  const sheet = page.getByTestId("deposit-sheet");
  await expect(sheet).toBeVisible();
  await sheet.getByRole("button", { name: "Get test AUSD" }).click();
  await expect.poll(() => ausdOf(owner), { timeout: 60_000, intervals: [1_000] }).toBeGreaterThan(before);
  // The sheet stays open while the faucet request is still finishing, which can outlast the transfer.
  await expect(async () => {
    await page.keyboard.press("Escape");
    await expect(sheet).toBeHidden({ timeout: 1_000 });
  }).toPass({ timeout: 30_000 });
}

export interface Session {
  account: Address;
  sessionAddress: Address;
  key: Hex;
}

/** The trading session the app stored on this device, decrypted in the page that holds its key. */
export async function sessionOf(page: Page): Promise<Session> {
  return (await page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const req = indexedDB.open("trendr-account", 1);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    const record = await new Promise<{ meta: { account: string; sessionAddress: string }; wrappingKey: CryptoKey; iv: Uint8Array<ArrayBuffer>; ciphertext: ArrayBuffer }>((resolve, reject) => {
      const req = db.transaction("session", "readonly").objectStore("session").get("current");
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    db.close();
    const plain = new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: record.iv }, record.wrappingKey, record.ciphertext));
    return { account: record.meta.account, sessionAddress: record.meta.sessionAddress, key: `0x${[...plain].map((b) => b.toString(16).padStart(2, "0")).join("")}` };
  })) as Session;
}

const toJson = (v: unknown) => JSON.stringify(v, (_k, x) => (typeof x === "bigint" ? x.toString() : x));

/** Sends a batch exactly as the app's trade() does: signed by the session key, relayed gas-free. */
export async function trade(session: Session, calls: Call[]): Promise<Hex> {
  const onchain = (await pub.readContract({ address: session.account, abi: passkeyAccountAbi, functionName: "sessionOf", args: [session.sessionAddress] })) as { nonce: bigint };
  const deadline = BigInt(Math.floor(Date.now() / 1000) + 300);
  const signature = await privateKeyToAccount(session.key).signTypedData(sessionExecuteTypedData(d.chainId, session.account, calls, session.sessionAddress, BigInt(onchain.nonce), deadline));
  const res = await fetch(`${RELAYER_URL}/v1/session/execute`, { method: "POST", headers: { "content-type": "application/json" }, body: toJson({ account: session.account, calls, sessionKey: session.sessionAddress, deadline, signature }) });
  const body = (await res.json()) as { hash: Hex; status: string; message?: string };
  if (!res.ok || body.status !== "success") throw new Error(`relayer ${res.status}: ${body.message ?? JSON.stringify(body)}`);
  return body.hash;
}

export interface LiveSeries {
  trendId: Hex;
  identifier: string;
  seriesId: Hex;
  expiry: number;
  up: Address;
  down: Address;
  upMarket: Address;
}

export const book = async (market: Address) => decodeL2((await pub.readContract({ address: market, abi: iKuruOrderBookAbi, functionName: "getL2Book", args: [10, 10] })) as Hex);

/**
 * An active trend's listed 24-hour series with hours to run, a fresh index and UP on offer, so a
 * run never trades into a series that is about to roll over.
 */
export async function pickSeries(minHoursLeft = 2): Promise<LiveSeries | null> {
  const { trends } = (await (await fetch(`${BACKEND}/v1/trends`)).json()) as { trends: Array<{ id: Hex; identifier: string; status: string }> };
  const active = trends.filter((t) => t.status === "active");
  if (active.length === 0) return null;
  const rows = (await pub.readContract({ address: d.trendrLens, abi: trendrLensAbi, functionName: "series", args: [active.map((t) => t.id)] })) as ReadonlyArray<{ trendId: Hex; window: number; seriesId: Hex; expiry: bigint; outcome: number; up: Address; down: Address; upMarket: Address; listed: boolean }>;
  const now = Math.floor(Date.now() / 1000);
  // Prefer a two-sided UP book (the run sells into its bids later); one with asks only will do.
  let fallback: LiveSeries | null = null;
  for (const r of rows) {
    if (Number(r.window) !== 86_400 || !r.listed || Number(r.outcome) !== 0 || Number(r.expiry) - now < minHoursLeft * 3600 || r.upMarket === zeroAddress) continue;
    const b = await book(r.upMarket).catch(() => null);
    if (!b || b.asks.length === 0) continue;
    const fresh = await pub.readContract({ address: d.trendRegistry, abi: trendRegistryAbi, functionName: "isFresh", args: [r.trendId] });
    if (!fresh) continue;
    const t = active.find((x) => x.id.toLowerCase() === r.trendId.toLowerCase())!;
    const s = { trendId: r.trendId, identifier: t.identifier, seriesId: r.seriesId, expiry: Number(r.expiry), up: r.up, down: r.down, upMarket: r.upMarket };
    if (b.bids.length > 0) return s;
    fallback ??= s;
  }
  return fallback;
}

/** Waits for a series to trade in while the market maker (re)fills its books. */
export async function waitForSeries(timeoutMs: number): Promise<LiveSeries> {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const s = await pickSeries();
    if (s) return s;
    if (Date.now() > until) throw new Error("No listed 24-hour series with a fresh index and UP on offer: the market maker is not quoting.");
    await new Promise((r) => setTimeout(r, 15_000));
  }
}

/** Waits until a Kuru book has bids deep enough to take `tokens` (raw, 6 decimals). */
export async function waitForBids(market: Address, tokens: bigint, timeoutMs: number) {
  const units = tokens / 10_000n;
  const until = Date.now() + timeoutMs;
  for (;;) {
    const b = await book(market).catch(() => null);
    const depth = (b?.bids ?? []).reduce((a, l) => a + l.size, 0n);
    if (depth >= units) return;
    if (Date.now() > until) throw new Error(`The UP book ${market} has no bids for ${Number(tokens) / 1e6} tokens: the market maker is not quoting bids.`);
    await new Promise((r) => setTimeout(r, 15_000));
  }
}

/** The least UP that `ausdIn` buys on the live book, 1% under the quote. */
export async function minUpOut(market: Address, ausdIn: bigint) {
  return minimumOut(quoteBuy(await book(market), ausdIn), 100);
}

/** An active trend whose coin still trades on its bonding curve, with the coin, or null. */
export async function openCurve(): Promise<{ trendId: Hex; identifier: string; coin: Address } | null> {
  const { trends } = (await (await fetch(`${BACKEND}/v1/trends`)).json()) as { trends: Array<{ id: Hex; identifier: string; status: string }> };
  for (const t of trends.filter((x) => x.status === "active")) {
    const c = (await pub.readContract({ address: d.bondingCurve, abi: bondingCurveAbi, functionName: "curveOf", args: [t.id] })) as { coin: Address; state: number };
    if (c.coin !== zeroAddress && Number(c.state) === 1) return { trendId: t.id, identifier: t.identifier, coin: c.coin };
  }
  return null;
}

/** The registry's index for a trend, in raw 1e6 points. */
export async function indexOf(trendId: Hex): Promise<bigint> {
  const [index] = (await pub.readContract({ address: d.trendRegistry, abi: trendRegistryAbi, functionName: "indexOf", args: [trendId] })) as readonly [bigint, bigint];
  return index;
}

/** Waits for a transaction row to fill and then finalize, failing with the app's own message. */
export async function settled(scope: Locator | Page, testId: string, label: string) {
  const status = scope.getByTestId(testId);
  await expect(status).toHaveAttribute("data-stage", /filled|final|failed/, { timeout: 120_000 });
  if ((await status.getAttribute("data-stage")) === "failed") throw new Error(`${label} failed: ${await status.innerText()}`);
  await expect(status).toHaveAttribute("data-stage", /final|failed/, { timeout: 60_000 });
  if ((await status.getAttribute("data-stage")) === "failed") throw new Error(`${label} failed: ${await status.innerText()}`);
}

/**
 * Clicks an action and waits for its transaction to settle. When the public RPC turned the app's
 * own read away (its per-address limit is shared by every browser and test on this machine), the
 * action is tried again, as a user would; any other failure fails the run.
 */
export async function act(button: Locator, scope: Locator | Page, testId: string, label: string, attempts = 4) {
  for (let i = 1; ; i++) {
    await button.click();
    try {
      await settled(scope, testId, label);
      return;
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      if (i >= attempts || !/limited to|rate limit|too many requests/i.test(message)) throw e;
      console.log(`${label}: the RPC was busy, trying again (${i})`);
      await new Promise((r) => setTimeout(r, 3_000 * i));
    }
  }
}

/**
 * Screenshots of the page at phone (375 x 812) and desktop (1440 x 900), light and dark, into
 * PORTFOLIO_SHOTS when it is set (for visual review; a no-op otherwise).
 */
export async function shots(page: Page, name: string, fullPage = true) {
  const dir = process.env.PORTFOLIO_SHOTS;
  if (!dir) return;
  const original = page.viewportSize();
  for (const [width, height, tag] of [[375, 812, "m"], [1440, 900, "d"]] as const) {
    await page.setViewportSize({ width, height });
    for (const scheme of ["light", "dark"] as const) {
      await page.emulateMedia({ colorScheme: scheme });
      await page.waitForTimeout(400);
      await page.screenshot({ path: `${dir}/${name}-${tag}-${scheme}.png`, fullPage });
    }
  }
  await page.emulateMedia({ colorScheme: null });
  if (original) await page.setViewportSize(original);
}
