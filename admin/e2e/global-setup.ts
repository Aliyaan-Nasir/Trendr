import { adminMessage, randomNonce } from "../src/lib/auth/message";
import { BACKEND_URL } from "./support/backend";
import { adminAccount } from "./support/wallet";

/** Fails fast, with a useful message, when the backend or the admin key is not ready. */
export default async function globalSetup() {
  try {
    const res = await fetch(`${BACKEND_URL}/health`);
    if (res.status !== 200 && res.status !== 503) throw new Error(`HTTP ${res.status}`);
  } catch (err) {
    throw new Error(`The backend at ${BACKEND_URL} is not answering (${err instanceof Error ? err.message : err}). Start it with: cd backend && bun run dev`);
  }

  // One signed read, as the panel signs.
  const account = adminAccount();
  const path = "/v1/admin/candidates?status=live";
  const ts = Math.floor(Date.now() / 1000);
  const nonce = randomNonce();
  const signature = await account.signMessage({ message: await adminMessage("GET", path, ts, nonce, "") });
  const res = await fetch(`${BACKEND_URL}${path}`, {
    headers: { "x-trendr-address": account.address, "x-trendr-timestamp": String(ts), "x-trendr-nonce": nonce, "x-trendr-signature": signature },
  });
  if (!res.ok) {
    throw new Error(`The admin test wallet ${account.address} cannot use the admin API (${res.status} ${await res.text()}). Is it in the backend's ADMIN_ADDRESSES?`);
  }
}
