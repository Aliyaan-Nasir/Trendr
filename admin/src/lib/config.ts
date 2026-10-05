/**
 * The backend origin the browser calls directly. The backend's FRONTEND_URL (its CORS allowlist)
 * must list this panel's origin. Inlined at build time, like every NEXT_PUBLIC_ variable.
 */
export const BACKEND_URL = (process.env.NEXT_PUBLIC_BACKEND_URL || "http://localhost:4000").replace(/\/+$/, "");

/**
 * Wallets expected to be admins. Only a hint for the sign-in screen: the backend checks its own
 * ADMIN_ADDRESSES on every request, so this list grants nothing.
 */
export const ADMIN_WALLET_HINT: readonly string[] = (process.env.NEXT_PUBLIC_ADMIN_WALLETS ?? "")
  .split(",")
  .map((w) => w.trim().toLowerCase())
  .filter(Boolean);

/** 10143 (Testnet) or 143 (Mainnet), for explorer links. Inlined at build time. */
export const CHAIN_ID = Number(process.env.NEXT_PUBLIC_CHAIN_ID || 10143);

/** Monadscan, where every Trendr contract is verified. */
export const EXPLORER_URL = CHAIN_ID === 143 ? "https://monadscan.com" : "https://testnet.monadscan.com";
export const explorerTx = (hash: string) => `${EXPLORER_URL}/tx/${hash}`;
export const explorerAddress = (address: string) => `${EXPLORER_URL}/address/${address}`;
