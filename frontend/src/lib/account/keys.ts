import { entropyToMnemonic, mnemonicToSeedSync } from "@scure/bip39";
import { wordlist } from "@scure/bip39/wordlists/english";
import { HDKey } from "viem/accounts";

/**
 * Every key comes from the passkey's PRF outputs, so the same passkey rebuilds them on any device
 * and nothing secret needs to be stored. Two PRF salts keep the namespaces separate:
 *
 * - Account (Mera's default salt): the EOA follows Mera's documented path (BIP-39 mnemonic from
 *   the 32 PRF bytes, BIP-44 `m/44'/60'/0'/0/0`), so the mnemonic exports to any EVM wallet.
 *   Session keys come from the same output through HKDF with an epoch, so rotating a session
 *   never changes the account.
 * - Private data (`sha256("trendr.private-data.v1")`): the vault key that encrypts Autopilot
 *   strategies and notes, and the caller identity key that signs public calls. Neither can be
 *   linked to the trading account.
 */

export const ACCOUNT_PATH = "m/44'/60'/0'/0/0";
const SECP256K1_N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;

export async function privateDataSalt(): Promise<Uint8Array<ArrayBuffer>> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode("trendr.private-data.v1")));
}

/** The account EOA's private key from the account-namespace PRF output. */
export function accountPrivateKey(prf: Uint8Array): Uint8Array {
  const mnemonic = entropyToMnemonic(prf, wordlist);
  const key = HDKey.fromMasterSeed(mnemonicToSeedSync(mnemonic)).derive(ACCOUNT_PATH).privateKey;
  if (!key) throw new Error("account key derivation failed");
  return key;
}

/** The 24-word recovery phrase for the account, for export only. */
export function accountMnemonic(prf: Uint8Array): string {
  return entropyToMnemonic(prf, wordlist);
}

async function hkdf(ikm: Uint8Array, info: string): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey("raw", Uint8Array.from(ikm), "HKDF", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "HKDF", hash: "SHA-256", salt: new Uint8Array(32), info: new TextEncoder().encode(info) },
    key,
    256,
  );
  return new Uint8Array(bits);
}

async function secp256k1Key(ikm: Uint8Array, label: string): Promise<Uint8Array> {
  // A 32-byte output is a valid scalar except with negligible probability; retry if not.
  for (let i = 0; i < 8; i++) {
    const candidate = await hkdf(ikm, i === 0 ? label : `${label}#${i}`);
    const n = BigInt(`0x${Array.from(candidate, (b) => b.toString(16).padStart(2, "0")).join("")}`);
    if (n > 0n && n < SECP256K1_N) return candidate;
  }
  throw new Error("key derivation failed");
}

/** The trading session key for `epoch` (rotations bump the epoch). */
export function sessionPrivateKey(accountPrf: Uint8Array, epoch: number): Promise<Uint8Array> {
  return secp256k1Key(accountPrf, `trendr/session/v1/${epoch}`);
}

/** The caller identity key, from the private-data namespace. */
export function identityPrivateKey(privateDataPrf: Uint8Array): Promise<Uint8Array> {
  return secp256k1Key(privateDataPrf, "trendr/caller-identity/v1");
}

/**
 * The Ed25519 seed for this account's Perpl API key, from the private-data namespace: the same
 * passkey rebuilds the same API key on any device, so it never needs to be stored or backed up.
 */
export function perplApiSeed(privateDataPrf: Uint8Array): Promise<Uint8Array> {
  return hkdf(privateDataPrf, "trendr/perpl-api/v1");
}

/** AES-GCM key for private data, non-extractable. */
export async function vaultKey(privateDataPrf: Uint8Array): Promise<CryptoKey> {
  const raw = await hkdf(privateDataPrf, "trendr/vault/v1");
  return crypto.subtle.importKey("raw", Uint8Array.from(raw), { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
}
