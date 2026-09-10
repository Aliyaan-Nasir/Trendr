import { z } from "zod";
import type { HttpRequest } from "../http";
import { CRYPTO, assetClassOf, normalizeIdentifier } from "../identifiers";
import type { TrendingToken } from "./elfa";

/**
 * Trend candidates: proposals from the backend trend radar (link pastes, AI extraction), the
 * configured seeds, and Elfa trending tokens. The backend proposes; only this workflow decides
 * what becomes a trend, through DON consensus.
 */

export interface Candidate {
  identifier: string;
  assetClass: number;
  keywords: string[];
  surfacer: string;
  /** Sampling order: explicit proposals before discovered ones (lower first). */
  priority: number;
}

export const PRIORITY_QUEUE = 0;
export const PRIORITY_SEED = 1;
export const PRIORITY_TRENDING = 2;

export const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

const candidateSchema = z.object({
  identifier: z.string(),
  keywords: z.array(z.string()).max(5).optional(),
  surfacer: z
    .string()
    .regex(/^0x[0-9a-fA-F]{40}$/)
    .optional(),
});

export function candidatesRequest(url: string, token: string): HttpRequest {
  const headers: Record<string, string> = { accept: "application/json" };
  if (token) headers.authorization = `Bearer ${token}`;
  return { url, method: "GET", headers };
}

/** Parses `{ candidates: [{ identifier, keywords?, surfacer? }] }` in the backend's ranked order, dropping invalid rows. */
export function parseCandidates(body: string): Candidate[] {
  const json = JSON.parse(body) as { candidates?: unknown };
  if (!Array.isArray(json.candidates)) throw new Error("candidates: malformed response");
  const out: Candidate[] = [];
  for (const raw of json.candidates) {
    const parsed = candidateSchema.safeParse(raw);
    if (!parsed.success) continue;
    // The backend ranks its queue; the fraction keeps that order inside the queue tier.
    const c = toCandidate(parsed.data.identifier, parsed.data.keywords, parsed.data.surfacer, PRIORITY_QUEUE + out.length / 100_000);
    if (c) out.push(c);
  }
  return out;
}

export function toCandidate(
  identifier: string,
  keywords?: string[],
  surfacer?: string,
  priority = PRIORITY_SEED,
): Candidate | null {
  const id = normalizeIdentifier(identifier);
  if (!id) return null;
  return {
    identifier: id,
    assetClass: assetClassOf(id),
    keywords: (keywords ?? []).map((k) => k.trim()).filter((k) => k.length > 0),
    surfacer: (surfacer ?? ZERO_ADDRESS).toLowerCase(),
    priority,
  };
}

/** Crypto candidates from Elfa trending tokens, strongest growth first. */
export function fromTrendingTokens(tokens: readonly TrendingToken[], max: number): Candidate[] {
  return [...tokens]
    .filter((t) => /^[A-Za-z0-9]{1,15}$/.test(t.token))
    .sort((a, b) => b.changePercent - a.changePercent || b.currentCount - a.currentCount || a.token.localeCompare(b.token))
    .slice(0, max)
    .map((t, rank) => ({
      identifier: `crypto:${t.token.toLowerCase()}`,
      assetClass: CRYPTO,
      keywords: [`$${t.token.toUpperCase()}`],
      surfacer: ZERO_ADDRESS,
      // Keeps the trending rank inside the trending tier.
      priority: PRIORITY_TRENDING + rank / 1000,
    }));
}

/**
 * Deduplicates by identifier (the highest-priority proposal wins), orders by priority then
 * identifier, rotates each tier by `rotation`, and caps: identical output on every node. Tiers
 * keep their precedence (the backend's queue, then seeds, then trending tokens). Inside a tier the
 * rotation walks the candidates in their order, so the backend's ranking decides who goes first in
 * each turn, and every candidate takes a turn: a few at the head that never qualify cannot hold a
 * run's slots.
 */
export function canonicalCandidates(lists: ReadonlyArray<readonly Candidate[]>, max: number, rotation = 0): Candidate[] {
  const seen = new Map<string, Candidate>();
  for (const list of lists) {
    for (const c of list) {
      const prior = seen.get(c.identifier);
      if (!prior || c.priority < prior.priority) seen.set(c.identifier, c);
    }
  }
  const sorted = [...seen.values()].sort((a, b) => a.priority - b.priority || a.identifier.localeCompare(b.identifier));
  const tiers = new Map<number, Candidate[]>();
  for (const c of sorted) {
    const tier = Math.floor(c.priority);
    tiers.set(tier, [...(tiers.get(tier) ?? []), c]);
  }
  const out: Candidate[] = [];
  for (const tier of [...tiers.keys()].sort((a, b) => a - b)) {
    const group = tiers.get(tier)!;
    const r = ((rotation % group.length) + group.length) % group.length;
    out.push(...group.slice(r), ...group.slice(0, r));
  }
  return out.slice(0, max);
}
