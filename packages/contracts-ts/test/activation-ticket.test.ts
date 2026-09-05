import { describe, expect, test } from "bun:test";
import { hashTypedData, recoverTypedDataAddress } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { activationTicketTypedData } from "../src";

const account = "0x00000000000000000000000000000000000000a1";

describe("activation tickets", () => {
  test("are EIP-712 over the account and the expiry, on the chain", async () => {
    const signer = privateKeyToAccount(generatePrivateKey());
    const typed = activationTicketTypedData(10143, account, 1_800_000_600);
    const signature = await signer.signTypedData(typed);
    expect(await recoverTypedDataAddress({ ...typed, signature })).toBe(signer.address);
    expect(typed.message.account).toBe("0x00000000000000000000000000000000000000A1");
  });

  test("differ by account, expiry and chain", () => {
    const digest = (chainId: number, a: `0x${string}`, expiresAt: number) => hashTypedData(activationTicketTypedData(chainId, a, expiresAt));
    const base = digest(10143, account, 1_800_000_600);
    expect(digest(10143, "0x00000000000000000000000000000000000000a2", 1_800_000_600)).not.toBe(base);
    expect(digest(10143, account, 1_800_000_601)).not.toBe(base);
    expect(digest(143, account, 1_800_000_600)).not.toBe(base);
  });
});
