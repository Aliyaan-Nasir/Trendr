import { afterAll, describe, expect, test } from "bun:test";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect, emptyState, FileStore, PgStore, type State } from "../src/store";

const sample = (): State => ({
  version: 1,
  transfers: [{ id: "t1", target: "oracle", amount: "16000000000000000000", at: 1, status: "confirmed", partial: false, hash: "0xabc", gasLimit: "21000" }],
  targets: { oracle: { failures: 0, retryAt: 0, lastError: null, halted: null, releasedAt: 0 } },
  alerts: { "treasury-low": { detail: "low", since: 1, lastSentAt: 1, repeatAt: 900_001, delayMs: 900_000, sent: 1 } },
});

describe("FileStore", () => {
  test("starts empty, round trips, and leaves no temporary file", async () => {
    const dir = await mkdtemp(join(tmpdir(), "topup-"));
    try {
      const store = new FileStore(join(dir, "nested", "state.json"));
      expect(await store.load()).toEqual(emptyState());
      await store.save(sample());
      expect(await store.load()).toEqual(sample());
      expect(await readdir(join(dir, "nested"))).toEqual(["state.json"]);
      expect(await store.lead()).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("refuses a corrupt file rather than resetting the caps", async () => {
    const dir = await mkdtemp(join(tmpdir(), "topup-"));
    try {
      const path = join(dir, "state.json");
      await writeFile(path, JSON.stringify({ version: 1, transfers: [{ amount: "x" }], targets: {}, alerts: {} }));
      await expect(new FileStore(path).load()).rejects.toThrow();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

const url = process.env.TEST_DATABASE_URL;

describe.skipIf(!url)("PgStore", () => {
  const id = `test:${crypto.randomUUID()}`;
  const opened: PgStore[] = [];
  const open = () => {
    const store = new PgStore(connect(url!), id);
    opened.push(store);
    return store;
  };

  afterAll(async () => {
    const sql = connect(url!);
    await sql`DELETE FROM topup_state WHERE id = ${id}`;
    await sql.end();
    for (const s of opened) await s.close().catch(() => undefined);
  });

  test("creates its table idempotently and round trips", async () => {
    const a = open();
    const b = open();
    expect(await a.load()).toEqual(emptyState());
    expect(await b.load()).toEqual(emptyState());
    await a.save(sample());
    expect(await b.load()).toEqual(sample());
    const changed = { ...sample(), transfers: [] };
    await b.save(changed);
    expect(await a.load()).toEqual(changed);
  });

  test("only one instance leads, and the lock passes on when the leader goes", async () => {
    const leader = open();
    const standby = open();
    expect(await leader.lead()).toBe(true);
    expect(await leader.lead()).toBe(true);
    expect(await standby.lead()).toBe(false);
    await leader.close();
    expect(await standby.lead()).toBe(true);
  });
});
