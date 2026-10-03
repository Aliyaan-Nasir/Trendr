import { afterEach, describe, expect, test } from "bun:test";
import { type OwnerApproval, ownerApprovalDigest, type OwnerRequest, ownerRequests } from "@trendr/contracts";
import type { Hex } from "viem";
import { approveAsOwner } from "../src/lib/account/owner-approval";
import { autopilot, setUserToken, social } from "../src/lib/api";

const account = "0x00000000000000000000000000000000000000a1";
const nonce: Hex = `0x${"11".repeat(32)}`;
const assertion = { authenticatorData: "0x01" as Hex, clientDataJSON: "{}", r: "0x02" as Hex, s: "0x03" as Hex };

describe("approveAsOwner", () => {
  test("asks for a nonce for the action, then has the passkey sign the digest of exactly this request", async () => {
    const asked: string[] = [];
    const signed: Hex[] = [];
    const request = ownerRequests.enableRule(7, "AB".repeat(16));
    const approval = await approveAsOwner(
      {
        account,
        chainId: 10143,
        challenge: async (action) => (asked.push(action), { nonce, expiresAt: 1_800_000_300, chainId: 10143 }),
        sign: async (digest) => (signed.push(digest), assertion),
      },
      request,
    );
    expect(asked).toEqual(["enable-rule"]);
    expect(signed).toEqual([ownerApprovalDigest({ chainId: 10143, account, request, nonce, expiresAt: 1_800_000_300 })]);
    expect(approval).toEqual({ nonce, ...assertion });
  });

  test("never prompts for a server on another chain", async () => {
    let prompted = false;
    const run = approveAsOwner(
      {
        account,
        chainId: 10143,
        challenge: async () => ({ nonce, expiresAt: 1_800_000_300, chainId: 143 }),
        sign: async () => ((prompted = true), assertion),
      },
      ownerRequests.linkIdentity(account),
    );
    await expect(run).rejects.toThrow("chain 143");
    expect(prompted).toBe(false);
  });
});

describe("approved API calls", () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
    setUserToken(null);
  });
  /** Captures the JSON bodies sent, answering each with `answer`. */
  function capture(answer: unknown = { ok: true }) {
    const sent: Array<{ url: string; body: Record<string, unknown> }> = [];
    globalThis.fetch = (async (url: string, init?: RequestInit) => {
      sent.push({ url, body: JSON.parse(String(init?.body ?? "null")) as Record<string, unknown> });
      return new Response(JSON.stringify(answer), { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof fetch;
    return sent;
  }
  const approver = () => {
    const requests: OwnerRequest[] = [];
    const approve = async (r: OwnerRequest): Promise<OwnerApproval> => (requests.push(r), { nonce, ...assertion });
    return { requests, approve };
  };

  test("a follow sends the approval with exactly the leader and settings it approved", async () => {
    setUserToken("token");
    const sent = capture({ follow: {} });
    const { requests, approve } = approver();
    const settings = { mode: "ratio" as const, ratio: 0.5, fixedMarginAusd: 0, maxMarginAusd: 30, maxLeverage: 2, maxDailyLossAusd: 10, maxSlippagePct: 0.3, maxOpenLossAusd: 8 };
    await autopilot.follow("0x6CFACB4C9A1B63CBC87750EC471CE194BFEA0211", settings, approve);
    expect(requests).toEqual([ownerRequests.follow("0x6CFACB4C9A1B63CBC87750EC471CE194BFEA0211", settings)]);
    expect(sent[0]?.url).toEndWith("/v1/follows");
    expect(sent[0]?.body).toEqual({ leader: "0x6CFACB4C9A1B63CBC87750EC471CE194BFEA0211", settings, approval: { nonce, ...assertion } });
  });

  test("enabling names the rule hash it approved; pausing and unfollowing never ask", async () => {
    setUserToken("token");
    const sent = capture({ rule: {} });
    const { requests, approve } = approver();
    await autopilot.enable({ id: 4, ruleHash: "ab".repeat(16) }, approve);
    await autopilot.setStatus(4, "paused");
    await autopilot.setFollowStatus(9, "stopped");
    await autopilot.resumeFollow(9, approve);
    expect(requests).toEqual([ownerRequests.enableRule(4, "ab".repeat(16)), ownerRequests.resumeFollow(9)]);
    expect(sent.map((s) => s.body)).toEqual([
      { status: "enabled", ruleHash: "ab".repeat(16), approval: { nonce, ...assertion } },
      { status: "paused" },
      { status: "stopped" },
      { status: "active", approval: { nonce, ...assertion } },
    ]);
  });

  test("a link carries the identity's signature and the passkey's approval, and no session signature", async () => {
    const sent = capture({ caller: account, linkedAccount: account });
    const { requests, approve } = approver();
    await social.link({ identity: "0x00000000000000000000000000000000000000b2", account, issuedAt: 1, identitySignature: "0x05" }, approve);
    expect(requests).toEqual([ownerRequests.linkIdentity("0x00000000000000000000000000000000000000b2")]);
    expect(sent[0]?.body).toEqual({ identity: "0x00000000000000000000000000000000000000b2", account, issuedAt: 1, identitySignature: "0x05", approval: { nonce, ...assertion } });
  });

  test("a cancelled prompt sends nothing", async () => {
    setUserToken("token");
    const sent = capture();
    await expect(autopilot.follow(account, { mode: "ratio", ratio: 1, fixedMarginAusd: 0, maxMarginAusd: 1, maxLeverage: 1, maxDailyLossAusd: 1, maxSlippagePct: 0.3, maxOpenLossAusd: 1 }, async () => Promise.reject(new Error("cancelled")))).rejects.toThrow("cancelled");
    expect(sent).toEqual([]);
  });
});
