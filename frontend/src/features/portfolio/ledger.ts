"use client";
import type { Hex } from "viem";

/**
 * The outcome series this device has seen the account hold. The chain's lens only returns each
 * trend's latest series per window, and a new series replaces it as soon as the old one settles,
 * so without this list a settled series (with winnings to redeem) would drop out of the
 * portfolio. Tickets can add a series the moment they buy into it with `rememberSeries`.
 */

const KEY = (account: string) => `trendr.portfolio.series:${account.toLowerCase()}`;
const MAX = 200;

export function rememberedSeries(account: string): Hex[] {
  try {
    const raw = localStorage.getItem(KEY(account));
    const list = raw ? (JSON.parse(raw) as unknown) : [];
    return Array.isArray(list) ? list.filter((s): s is Hex => typeof s === "string" && /^0x[0-9a-f]{64}$/i.test(s)) : [];
  } catch {
    return [];
  }
}

function write(account: string, list: readonly Hex[]) {
  try {
    localStorage.setItem(KEY(account), JSON.stringify(list.slice(-MAX)));
  } catch {
    // Storage blocked: the list lasts this visit.
  }
}

/** Adds series to the account's list (newest last). */
export function rememberSeries(account: string, ...seriesIds: Hex[]): void {
  const list = rememberedSeries(account);
  const known = new Set(list.map((s) => s.toLowerCase()));
  const added = seriesIds.filter((s) => !known.has(s.toLowerCase()));
  if (added.length > 0) write(account, [...list, ...added]);
}

/** Drops series the account no longer holds anything of. */
export function forgetSeries(account: string, seriesIds: readonly Hex[]): void {
  if (seriesIds.length === 0) return;
  const drop = new Set(seriesIds.map((s) => s.toLowerCase()));
  const list = rememberedSeries(account);
  const kept = list.filter((s) => !drop.has(s.toLowerCase()));
  if (kept.length !== list.length) write(account, kept);
}
