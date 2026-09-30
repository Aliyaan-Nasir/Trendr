"use client";
import { useQueryClient } from "@tanstack/react-query";
import { type Call, deploymentPerplPermissions, passkeyAccountAbi } from "@trendr/contracts";
import { useCallback, useState } from "react";
import { encodeFunctionData, getAddress } from "viem";
import { useAccount } from "@/lib/account/AccountProvider";
import { ApiError, autopilot } from "@/lib/api";
import { DEPLOYMENT } from "@/lib/config";
import type { Tx } from "@/lib/trade/useTx";
import { sealGrantKey } from "./grant-key";

/**
 * Granting and revoking Autopilot's access. The app makes a Perpl-only session key on this device
 * and seals it to the executor, so the backend only stores a box it cannot open; the account adds
 * the key with one passkey prompt (and drops the previous key in the same batch). Revoking removes
 * the key on chain, then pauses what it was running.
 */

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const message = (e: unknown) => (e instanceof ApiError ? e.message : e instanceof Error ? e.message : "Something went wrong.");

export const DAILY_CAPS = [100, 250, 500, 1000] as const;
export const VALID_DAYS = [7, 30, 90] as const;

export function useGrantActions() {
  const account = useAccount();
  const qc = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  const [working, setWorking] = useState(false);

  const refresh = useCallback(async () => {
    await Promise.all([
      qc.invalidateQueries({ queryKey: ["ap-grant"] }),
      qc.invalidateQueries({ queryKey: ["ap-rules"] }),
      qc.invalidateQueries({ queryKey: ["ap-rule"] }),
      qc.invalidateQueries({ queryKey: ["follows"] }),
    ]);
  }, [qc]);

  /** One passkey prompt. Resolves true once the backend sees the key active on chain. */
  const grant = useCallback(
    async (tx: Tx, dailyCapAusd: number, validDays: number, previousKey: `0x${string}` | null): Promise<boolean> => {
      const owner = account.address;
      if (!owner) return false;
      setError(null);
      setWorking(true);
      try {
        const { publicKey } = await autopilot.sealKey();
        const key = await sealGrantKey(owner, publicKey);
        const dailyLimit = BigInt(dailyCapAusd) * 1_000_000n;
        const { session } = await autopilot.requestGrant(dailyLimit, validDays, key);
        // The passkey adds the key made here, Perpl-only, whatever the server answered.
        if (session.key.toLowerCase() !== key.sessionKey.toLowerCase()) throw new Error("The server answered with a different key. Nothing was added; try again.");
        const calls: Call[] = [
          {
            target: owner,
            value: 0n,
            data: encodeFunctionData({
              abi: passkeyAccountAbi,
              functionName: "addSession",
              args: [{ key: key.sessionKey, validUntil: session.validUntil, dailyLimit, permissions: deploymentPerplPermissions(DEPLOYMENT) }],
            }),
          },
        ];
        if (previousKey && previousKey.toLowerCase() !== key.sessionKey.toLowerCase()) {
          calls.push({ target: owner, value: 0n, data: encodeFunctionData({ abi: passkeyAccountAbi, functionName: "revokeSession", args: [getAddress(previousKey)] }) });
        }
        const renewing = Boolean(previousKey);
        const sent = await tx.run(() => account.ownerExecute(calls), renewing ? { action: "Renew Autopilot access", done: "Autopilot access renewed" } : { action: "Grant Autopilot access", done: "Autopilot access granted" });
        if (!sent) return false;
        // The backend reads the account on chain; its node may be a block behind the relayer's.
        for (let attempt = 0; ; attempt++) {
          try {
            await autopilot.confirmGrant();
            break;
          } catch (e) {
            if (!(e instanceof ApiError && e.status === 409) || attempt >= 8) throw e;
            await sleep(600 + attempt * 300);
          }
        }
        await refresh();
        return true;
      } catch (e) {
        setError(message(e));
        return false;
      } finally {
        setWorking(false);
      }
    },
    [account, refresh],
  );

  /** One passkey prompt: removes the key on chain, then pauses running rules and copies. */
  const revoke = useCallback(
    async (tx: Tx, key: `0x${string}`): Promise<boolean> => {
      const owner = account.address;
      if (!owner) return false;
      setError(null);
      setWorking(true);
      try {
        const sent = await tx.run(() => account.ownerExecute([{ target: owner, value: 0n, data: encodeFunctionData({ abi: passkeyAccountAbi, functionName: "revokeSession", args: [getAddress(key)] }) }]), { action: "Revoke Autopilot access", done: "Autopilot access revoked" });
        if (!sent) return false;
        const [{ rules }, { follows }] = await Promise.all([autopilot.rules(), autopilot.follows()]);
        await Promise.all([
          ...rules.filter((r) => r.status === "enabled").map((r) => autopilot.setStatus(r.id, "paused").catch(() => null)),
          ...follows.filter((f) => f.status === "active").map((f) => autopilot.setFollowStatus(f.id, "paused").catch(() => null)),
        ]);
        await refresh();
        return true;
      } catch (e) {
        setError(message(e));
        await refresh();
        return false;
      } finally {
        setWorking(false);
      }
    },
    [account, refresh],
  );

  return { grant, revoke, error, working, clearError: () => setError(null) };
}
