/**
 * Keeps the trading session key on this device between visits without a passkey prompt. The key
 * is encrypted with AES-GCM under a non-extractable WebCrypto key, both in IndexedDB, so script
 * code can use it on this origin but cannot export it. Losing this store (cleared storage, a new
 * device) costs one passkey prompt, since the session key is re-derived from the passkey.
 */

export interface StoredSession {
  account: `0x${string}`;
  credentialId: string;
  sessionAddress: `0x${string}`;
  epoch: number;
  validUntil: number;
}

const DB = "trendr-account";
const STORE = "session";

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function tx<T>(db: IDBDatabase, mode: IDBTransactionMode, run: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    const request = run(db.transaction(STORE, mode).objectStore(STORE));
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

interface Record {
  meta: StoredSession;
  wrappingKey: CryptoKey;
  iv: Uint8Array<ArrayBuffer>;
  ciphertext: ArrayBuffer;
}

export async function saveSession(meta: StoredSession, sessionKey: Uint8Array): Promise<void> {
  const wrappingKey = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, wrappingKey, Uint8Array.from(sessionKey));
  const db = await open();
  try {
    await tx(db, "readwrite", (s) => s.put({ meta, wrappingKey, iv, ciphertext } satisfies Record, "current"));
  } finally {
    db.close();
  }
}

export async function loadSession(): Promise<{ meta: StoredSession; sessionKey: Uint8Array } | null> {
  let db: IDBDatabase | undefined;
  try {
    db = await open();
    const record = (await tx(db, "readonly", (s) => s.get("current"))) as Record | undefined;
    if (!record) return null;
    const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: record.iv }, record.wrappingKey, record.ciphertext);
    return { meta: record.meta, sessionKey: new Uint8Array(plain) };
  } catch {
    return null;
  } finally {
    db?.close();
  }
}

export async function clearSession(): Promise<void> {
  try {
    const db = await open();
    try {
      await tx(db, "readwrite", (s) => s.delete("current"));
    } finally {
      db.close();
    }
  } catch {
    // Nothing stored.
  }
}
