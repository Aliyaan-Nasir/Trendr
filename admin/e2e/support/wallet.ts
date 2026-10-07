import { readFileSync } from "node:fs";
import path from "node:path";
import type { Page } from "@playwright/test";
import type { Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";

/**
 * Test wallets. The admin key comes from ADMIN_E2E_PRIVATE_KEY, else DEPLOYER_PRIVATE_KEY in
 * contracts/.env (the Testnet deployer, which the local backend lists in ADMIN_ADDRESSES). It is
 * read at run time, stays in the test process and is never printed.
 */

const CONTRACTS_ENV = path.resolve(__dirname, "../../../contracts/.env");

function readDeployerKey(): string {
  let text: string;
  try {
    text = readFileSync(CONTRACTS_ENV, "utf8");
  } catch {
    throw new Error(`Set ADMIN_E2E_PRIVATE_KEY, or create ${CONTRACTS_ENV} with DEPLOYER_PRIVATE_KEY.`);
  }
  for (const line of text.split(/\r?\n/)) {
    const match = line.match(/^\s*(?:export\s+)?DEPLOYER_PRIVATE_KEY\s*=\s*["']?([^"'\s#]+)/);
    if (match) return match[1]!;
  }
  throw new Error(`DEPLOYER_PRIVATE_KEY is missing from ${CONTRACTS_ENV}.`);
}

export function adminAccount(): PrivateKeyAccount {
  const raw = process.env.ADMIN_E2E_PRIVATE_KEY || readDeployerKey();
  const key = (raw.startsWith("0x") ? raw : `0x${raw}`) as Hex;
  if (!/^0x[0-9a-fA-F]{64}$/.test(key)) throw new Error("The admin test key is not a 32-byte hex private key.");
  return privateKeyToAccount(key);
}

/** A fresh wallet no backend lists as an admin. */
export const strangerAccount = (): PrivateKeyAccount => privateKeyToAccount(generatePrivateKey());

export interface WalletProbe {
  /** personal_sign requests the page made. */
  signatures: number;
}

/**
 * Injects an EIP-1193 provider as window.ethereum. The page sees an ordinary wallet; signing runs
 * in the test process through an exposed function, so the key never enters the page. Like a real
 * wallet it remembers that the site was connected across reloads in the same tab.
 */
export async function installWallet(page: Page, account: PrivateKeyAccount, opts: { declineSignatures?: boolean } = {}): Promise<WalletProbe> {
  const probe: WalletProbe = { signatures: 0 };
  await page.exposeFunction("__e2eWalletSign", async (data: string, address: string) => {
    if (address.toLowerCase() !== account.address.toLowerCase()) throw new Error(`asked to sign for ${address}`);
    probe.signatures += 1;
    return account.signMessage({ message: { raw: data as Hex } });
  });
  await page.addInitScript(
    ({ address, decline }) => {
      const KEY = "__e2e-wallet-connected";
      const connected = () => sessionStorage.getItem(KEY) === "1";
      const sign = (data: unknown, signer: unknown) =>
        (window as unknown as { __e2eWalletSign: (data: unknown, address: unknown) => Promise<string> }).__e2eWalletSign(data, signer);
      const provider = {
        async request({ method, params = [] }: { method: string; params?: unknown[] }) {
          switch (method) {
            case "eth_accounts":
              return connected() ? [address] : [];
            case "eth_requestAccounts":
              sessionStorage.setItem(KEY, "1");
              return [address];
            case "eth_chainId":
              return "0x279f";
            case "personal_sign":
              if (decline) throw Object.assign(new Error("User rejected the request."), { code: 4001 });
              return sign(params[0], params[1]);
            case "wallet_revokePermissions":
              sessionStorage.removeItem(KEY);
              return null;
            default:
              throw Object.assign(new Error(`Unsupported method ${method}`), { code: 4200 });
          }
        },
        on() {},
        removeListener() {},
      };
      Object.defineProperty(window, "ethereum", { value: provider, configurable: true });
    },
    { address: account.address, decline: Boolean(opts.declineSignatures) },
  );
  return probe;
}
