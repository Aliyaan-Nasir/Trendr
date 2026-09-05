import { describe, expect, test } from "bun:test";
import { encodeAbiParameters, encodePacked, getAbiItem, hashTypedData, keccak256, parseAbi, toFunctionSelector, zeroAddress } from "viem";
import {
  deployments,
  delegateOf,
  legacyPasskeyAccounts,
  passkeyAccountVersion,
  PERPL_ORDER_BAND_BPS,
  perplPermissions,
  perplSessionMaxLeverage,
  sessionMarker,
  sessionHash,
  sessionsHash,
  tradingPermissions,
  upgradeTypedData,
} from "../src";

const d = deployments[10143]!;
const V1 = "0xdF6C6019C70fC321211A0483E74E2DDe839fa955" as const;
const ORDER = "(uint256,uint256,uint8,uint256,uint256,uint256,uint256,bool,bool,bool,uint256,uint256,uint256,uint256,uint256)";
/** Perpl's order entry points, as the Exchange declares them. */
const perplOrderGuardOrders = parseAbi([`function execOrder(${ORDER} orderDesc)`, `function execOrders(${ORDER}[] orderDescs, bool revertOnFail)`]);

describe("PasskeyAccount version 2 helpers", () => {
  test("Perpl order permissions name the deployment's order guard; nothing else has one", () => {
    const permissions = tradingPermissions(d);
    const guarded = permissions.filter((p) => p.guard !== zeroAddress);
    const orders = [toFunctionSelector(getAbiItem({ abi: perplOrderGuardOrders, name: "execOrder" })), toFunctionSelector(getAbiItem({ abi: perplOrderGuardOrders, name: "execOrders" }))];
    expect(guarded.map((p) => p.selector)).toEqual(orders);
    expect(guarded.every((p) => p.guard === d.perplOrderGuard && p.target === d.perplExchange)).toBe(true);
    expect(guarded).toHaveLength(2);
    // Without a guard there is no Perpl from a session at all.
    expect(perplPermissions(d.perplExchange, zeroAddress)).toEqual([]);
    expect(PERPL_ORDER_BAND_BPS).toBe(200);
  });

  test("sessions open Perpl positions at up to the guard's cap, 10x on Testnet", () => {
    expect(d.perplSessionMaxLeverageHdths).toBe(1000);
    expect(perplSessionMaxLeverage(d)).toBe(10);
    expect(perplSessionMaxLeverage({ perplSessionMaxLeverageHdths: 0 })).toBe(0);
  });

  test("the session marker is the guarded Perpl order, so a session naming a replaced guard renews", () => {
    const marker = sessionMarker(d);
    expect(marker).toEqual(tradingPermissions(d).find((p) => p.guard !== zeroAddress)!);
    expect(marker.guard).toBe(d.perplOrderGuard);
    // Without Perpl, TrendrSpot's banded sell marks the current set.
    const noPerpl = { ...d, perplExchange: zeroAddress, perplOrderGuard: zeroAddress };
    expect(sessionMarker(noPerpl)).toEqual({ target: d.trendrSpot, selector: toFunctionSelector("sell(address,uint256,uint256,address)"), recipientArg: 4, guard: zeroAddress });
  });

  test("a session's hash covers each permission's guard", () => {
    const s = { key: d.treasury, validUntil: 1, dailyLimit: 2n, permissions: tradingPermissions(d) };
    const unguarded = { ...s, permissions: s.permissions.map((p) => ({ ...p, guard: zeroAddress })) };
    expect(sessionHash(s)).not.toBe(sessionHash(unguarded));
    const tuple = [{ type: "tuple[]", components: [{ type: "address" }, { type: "bytes4" }, { type: "uint8" }, { type: "address" }] }] as const;
    const permissions = keccak256(encodeAbiParameters(tuple, [s.permissions.map((p) => [p.target, p.selector, p.recipientArg, p.guard] as const)]));
    expect(sessionHash(s)).toBe(
      keccak256(encodeAbiParameters([{ type: "address" }, { type: "uint48" }, { type: "uint128" }, { type: "bytes32" }], [s.key, s.validUntil, s.dailyLimit, permissions])),
    );
  });

  test("Upgrade signs the packed session hashes under the account's own, unchanged domain", () => {
    const a = { key: d.treasury, validUntil: 1, dailyLimit: 2n, permissions: tradingPermissions(d) };
    const b = { ...a, key: d.ausd };
    expect(sessionsHash([a, b])).toBe(keccak256(encodePacked(["bytes32", "bytes32"], [sessionHash(a), sessionHash(b)])));
    expect(sessionsHash([a, b])).not.toBe(sessionsHash([b, a]));
    const typed = upgradeTypedData(10143, d.treasury, [a], 5n);
    expect(typed.domain).toEqual({ name: "Trendr PasskeyAccount", version: "1", chainId: 10143, verifyingContract: d.treasury });
    expect(hashTypedData(typed)).toBe(
      hashTypedData({ ...typed, types: { Upgrade: [{ name: "sessionsHash", type: "bytes32" }, { name: "deadline", type: "uint256" }] } }),
    );
  });

  test("which PasskeyAccount version an account runs", () => {
    expect(legacyPasskeyAccounts(10143)).toEqual([V1]);
    expect(legacyPasskeyAccounts(143)).toEqual([]);
    expect(passkeyAccountVersion(d, d.passkeyAccount)).toBe(2);
    expect(passkeyAccountVersion(d, V1.toLowerCase() as `0x${string}`)).toBe(1);
    expect(passkeyAccountVersion(d, d.ausd)).toBeNull();
    expect(passkeyAccountVersion(d, null)).toBeNull();
    expect(passkeyAccountVersion(d, V1, [])).toBeNull();
    expect(delegateOf(`0xef0100${V1.slice(2)}`)).toBe(V1.toLowerCase() as `0x${string}`);
    expect(delegateOf("0x")).toBeNull();
    expect(delegateOf(`0xef0100${V1.slice(2)}00`)).toBeNull();
    expect(delegateOf(undefined)).toBeNull();
  });
});
