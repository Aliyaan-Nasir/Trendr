import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import type { Address, Hex } from "viem";
import type { Sql } from "../src/db";
import { delegationCode, Faucet, FaucetError } from "../src/faucet/faucet";
import { testDb } from "./helpers";

/**
 * The faucet pays only activated Trendr accounts (a delegation to this deployment's PasskeyAccount,
 * initialized) and at most a daily cap across all accounts. Every refusal happens before the
 * faucet reads its balance, so a fake client whose balance read throws marks the point where a
 * transfer would start.
 */

/** PasskeyAccount version 1, which accounts keep running until they upgrade, and version 2. */
const DELEGATE = "0xdF6C6019C70fC321211A0483E74E2DDe839fa955" as Address;
const V2 = "0xa3023591e43085c782444937F96f2B82E98B2524" as Address;
const ACCOUNT = "0x00000000000000000000000000000000000000a1" as Address;
const REACHED = "reached the transfer";

let sql: Sql;
let code: Hex | undefined;
let initialized: boolean;
let down: boolean;

const client = {
  getCode: async () => {
    if (down) throw new Error("fetch failed");
    return code;
  },
  readContract: async ({ functionName }: { functionName: string }) => {
    if (functionName === "isInitialized") return initialized;
    throw new Error(REACHED);
  },
  waitForTransactionReceipt: async () => {
    throw new Error("no transactions in tests");
  },
};
const faucet = (cap = 3) =>
  new Faucet(sql, client as never, `0x${"11".repeat(32)}`, ["http://127.0.0.1:9"], "0xa9012a055bd4e0eDfF8Ce09f960291C09D5322dC", 100_000_000n, [DELEGATE, V2], cap);
const refusal = async (p: Promise<unknown>): Promise<unknown> => p.then(() => null, (e: Error) => (e instanceof FaucetError ? [e.status, e.message] : e.message));

beforeAll(async () => {
  sql = await testDb();
});
afterAll(async () => {
  await sql.end();
});
beforeEach(async () => {
  await sql`TRUNCATE faucet_drips RESTART IDENTITY`;
  code = delegationCode(DELEGATE);
  initialized = true;
  down = false;
});

describe("faucet", () => {
  test("pays only accounts delegated to a Trendr PasskeyAccount (version 1 or 2) and initialized", async () => {
    expect(delegationCode(DELEGATE)).toBe("0xef0100df6c6019c70fc321211a0483e74e2dde839fa955");
    const notTrendr = [403, "The faucet pays activated Trendr accounts only."];
    code = undefined; // a fresh key
    expect(await refusal(faucet().drip(ACCOUNT))).toEqual(notTrendr);
    code = delegationCode("0x00000000000000000000000000000000000000ff"); // another delegate
    expect(await refusal(faucet().drip(ACCOUNT))).toEqual(notTrendr);
    code = `${delegationCode(DELEGATE)}00`; // not a delegation designator
    expect(await refusal(faucet().drip(ACCOUNT))).toEqual(notTrendr);
    code = delegationCode(DELEGATE);
    initialized = false;
    expect(await refusal(faucet().drip(ACCOUNT))).toEqual(notTrendr);
    initialized = true;
    code = delegationCode(DELEGATE).toUpperCase().replace("0X", "0x") as Hex;
    expect(await refusal(faucet().drip(ACCOUNT))).toBe(REACHED);
    code = delegationCode(V2);
    expect(await faucet().isTrendrAccount(ACCOUNT)).toBe(true);
  });

  test("an unreadable chain is a retry, not a refusal", async () => {
    down = true;
    expect(await refusal(faucet().drip(ACCOUNT))).toEqual([503, "Could not check the account on chain; try again."]);
  });

  test("pays each account once a day, and all accounts together at most the daily cap", async () => {
    await sql`INSERT INTO faucet_drips (account, amount, tx_hash) VALUES (${ACCOUNT.toLowerCase()}, 1, '0x1')`;
    expect(await refusal(faucet().drip(ACCOUNT))).toEqual([429, "This account already received test AUSD today."]);
    await sql`TRUNCATE faucet_drips`;
    for (const a of ["0xb1", "0xb2", "0xb3"]) await sql`INSERT INTO faucet_drips (account, amount, tx_hash) VALUES (${a}, 1, '0x1')`;
    expect(await refusal(faucet(3).drip(ACCOUNT))).toEqual([429, "The faucet has paid out today's test AUSD. Try again tomorrow."]);
    expect(await refusal(faucet(4).drip(ACCOUNT))).toBe(REACHED);
    // Drips older than a day no longer count.
    await sql`UPDATE faucet_drips SET created_at = now() - interval '25 hours'`;
    expect(await refusal(faucet(3).drip(ACCOUNT))).toBe(REACHED);
  });
});
