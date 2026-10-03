import { afterEach, describe, expect, test } from "bun:test";
import { boxKeyId, followSettingsSchema, generateSealKeyPair, open, sealKeyId } from "@trendr/autopilot";
import { privateKeyToAccount } from "viem/accounts";
import { sealGrantKey } from "../src/features/autopilot/grant/grant-key";
import { FOLLOW_DEFAULTS, formOf, validateFollow } from "../src/features/copy/follow-form";
import { autopilot, setUserToken } from "../src/lib/api";

const owner = "0x00000000000000000000000000000000000000A1";

describe("grant keys made on the device", () => {
  test("only the address and a box bound to the account and key leave the device, and only the executor opens it", async () => {
    const executor = await generateSealKeyPair();
    const made = await sealGrantKey(owner, executor.publicKey);
    expect(Object.keys(made).sort()).toEqual(["sealedKey", "sessionKey"]);
    expect(made.sealedKey.startsWith("v2.")).toBe(true);
    expect(boxKeyId(made.sealedKey)).toBe(await sealKeyId(executor.publicKey));
    const key = await open(made.sealedKey, executor.privateKey, { owner: owner.toLowerCase(), sessionKey: made.sessionKey.toLowerCase() });
    expect(privateKeyToAccount(key as `0x${string}`).address).toBe(made.sessionKey);
    // Bound to this account: the executor will not open it for another.
    await expect(open(made.sealedKey, executor.privateKey, { owner: "0x00000000000000000000000000000000000000b2", sessionKey: made.sessionKey.toLowerCase() })).rejects.toThrow();
    // A fresh key each time.
    expect((await sealGrantKey(owner, executor.publicKey)).sessionKey).not.toBe(made.sessionKey);
  });

  test("the grant request carries the address and the box, never the key", async () => {
    const realFetch = globalThis.fetch;
    const sent: Array<Record<string, unknown>> = [];
    globalThis.fetch = (async (_url: string, init?: RequestInit) => {
      sent.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return new Response(JSON.stringify({ session: {} }), { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof fetch;
    try {
      setUserToken("token");
      const executor = await generateSealKeyPair();
      const made = await sealGrantKey(owner, executor.publicKey);
      await autopilot.requestGrant(250_000_000n, 30, made);
      expect(sent).toEqual([{ dailyLimit: "250000000", validDays: 30, sessionKey: made.sessionKey, sealedKey: made.sealedKey }]);
    } finally {
      globalThis.fetch = realFetch;
      setUserToken(null);
    }
  });
});

describe("follow form", () => {
  afterEach(() => setUserToken(null));

  test("defaults send every setting, slippage limit and loss cap included, as the server would store them", () => {
    const { settings, errors } = validateFollow(FOLLOW_DEFAULTS);
    expect(errors).toEqual({});
    expect(settings).toEqual({ mode: "ratio", ratio: 1, fixedMarginAusd: 0, maxMarginAusd: 50, maxLeverage: 3, maxDailyLossAusd: 25, maxSlippagePct: 0.3, maxOpenLossAusd: 20 });
    expect(followSettingsSchema.parse(settings)).toEqual(settings!);
    // Editing starts from what is stored (a ratio follow keeps no fixed margin).
    expect(formOf(settings!)).toEqual({ ...FOLLOW_DEFAULTS, fixed: "0" });
  });

  test("refuses what the server refuses, with the field to fix", () => {
    const cases: Array<[Partial<typeof FOLLOW_DEFAULTS>, keyof typeof FOLLOW_DEFAULTS | null]> = [
      [{ maxSlippage: "1" }, null],
      [{ maxSlippage: "0.05" }, null],
      // Session Perpl orders must stay within 2% of the mark, so a copy takes at most 1%.
      [{ maxSlippage: "1.5" }, "maxSlippage"],
      [{ maxSlippage: "3" }, "maxSlippage"],
      [{ maxSlippage: "0.01" }, "maxSlippage"],
      [{ maxSlippage: "" }, "maxSlippage"],
      [{ maxOpenLoss: "0" }, "maxOpenLoss"],
      [{ maxOpenLoss: "1000001" }, "maxOpenLoss"],
      // Copies trade through the session, whose order guard opens at up to 10x.
      [{ maxLeverage: "10" }, null],
      [{ maxLeverage: "10.5" }, "maxLeverage"],
      [{ maxLeverage: "30" }, "maxLeverage"],
      [{ mode: "fixed", fixed: "60" }, "fixed"],
    ];
    for (const [change, field] of cases) {
      const form = { ...FOLLOW_DEFAULTS, ...change };
      const { settings, errors } = validateFollow(form);
      if (field === null) {
        expect(errors).toEqual({});
        expect(followSettingsSchema.safeParse(settings).success).toBe(true);
      } else {
        expect(Object.keys(errors)).toEqual([field]);
      }
    }
    expect(validateFollow({ ...FOLLOW_DEFAULTS, maxSlippage: "5" }).errors.maxSlippage).toBe("Between 0.05 and 1");
    expect(validateFollow({ ...FOLLOW_DEFAULTS, maxLeverage: "15" }).errors.maxLeverage).toBe("Between 1 and 10");
  });
});
