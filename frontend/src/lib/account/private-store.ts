/**
 * The private-data keys on this device: the caller identity key (encrypted under a
 * non-extractable wrapping key) and the vault key (itself a non-extractable AES key). Both are
 * re-derived from the passkey on any device, so losing this store costs one passkey prompt and
 * nothing else. Kept apart from the trading session so either can be cleared alone.
 */

const DB = "trendr-private";
const STORE = "keys";

export interface PrivateKeys {
  identityKey: Uint8Array;
  vaultKey: CryptoKey;
  perplSeed: Uint8Array;
}

interface Record {
  wrappingKey: CryptoKey;
  iv: Uint8Array<ArrayBuffer>;
  ciphertext: ArrayBuffer;
  vaultKey: CryptoKey;
}

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function run<T>(db: IDBDatabase, mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    const r = fn(db.transaction(STORE, mode).objectStore(STORE));
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

export async function savePrivateKeys(account: string, keys: PrivateKeys): Promise<void> {
  const wrappingKey = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const plain = new Uint8Array(64);
  plain.set(keys.identityKey, 0);
  plain.set(keys.perplSeed, 32);
  const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, wrappingKey, plain);
  plain.fill(0);
  const db = await open();
  try {
    await run(db, "readwrite", (s) => s.put({ wrappingKey, iv, ciphertext, vaultKey: keys.vaultKey } satisfies Record, account.toLowerCase()));
  } finally {
    db.close();
  }
}

export async function loadPrivateKeys(account: string): Promise<PrivateKeys | null> {
  let db: IDBDatabase | undefined;
  try {
    db = await open();
    const r = (await run(db, "readonly", (s) => s.get(account.toLowerCase()))) as Record | undefined;
    if (!r) return null;
    const plain = new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: r.iv }, r.wrappingKey, r.ciphertext));
    const keys = { identityKey: plain.slice(0, 32), perplSeed: plain.slice(32, 64), vaultKey: r.vaultKey };
    plain.fill(0);
    return keys;
  } catch {
    return null;
  } finally {
    db?.close();
  }
}

export async function clearPrivateKeys(): Promise<void> {
  try {
    const db = await open();
    try {
      await run(db, "readwrite", (s) => s.clear());
    } finally {
      db.close();
    }
  } catch {
    // Nothing stored.
  }
}
