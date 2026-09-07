import { MONAD_ASSETS, MONAD_BLOCKCHAIN, type MonadSymbol } from "./monad";
import type { AuroraToken } from "./schemas";

/**
 * Lookups over Aurora's supported token list. The list changes rarely; the client caches it (see
 * AuroraClient.tokens) as Aurora's rate-limit guidance asks.
 */
export class TokenList {
  private readonly byId: Map<string, AuroraToken>;

  constructor(readonly tokens: readonly AuroraToken[]) {
    this.byId = new Map(tokens.map((t) => [t.assetId, t]));
  }

  byAssetId(assetId: string): AuroraToken | undefined {
    return this.byId.get(assetId);
  }

  /** Tokens on one chain, for the "N assets supported" line next to a deposit address. */
  onChain(blockchain: string): AuroraToken[] {
    return this.tokens.filter((t) => t.blockchain === blockchain);
  }

  chains(): string[] {
    return [...new Set(this.tokens.map((t) => t.blockchain))].sort();
  }

  /** The token at `contract` on `blockchain` (case-insensitive), or the native token when `contract` is null. */
  byContract(blockchain: string, contract: string | null): AuroraToken | undefined {
    const want = contract?.toLowerCase() ?? null;
    return this.tokens.find((t) => t.blockchain === blockchain && (t.contractAddress ? t.contractAddress.toLowerCase() : null) === want);
  }

  /** Tokens on `blockchain` with this symbol; several chains list two tokens under one symbol. */
  bySymbol(blockchain: string, symbol: string): AuroraToken[] {
    return this.onChain(blockchain).filter((t) => t.symbol === symbol);
  }
}

/**
 * The live Aurora token for a Monad asset, matched by contract address (or as the native token for
 * MON). Throws when Aurora no longer lists it, so a delisting fails loudly instead of quoting the
 * wrong asset.
 */
export function monadAsset(list: TokenList, symbol: MonadSymbol): AuroraToken {
  const known = MONAD_ASSETS[symbol];
  const token = list.byContract(MONAD_BLOCKCHAIN, known.address);
  if (!token || token.decimals !== known.decimals) {
    throw new Error(`Aurora does not list ${symbol} on Monad (${known.address ?? "native"}) with ${known.decimals} decimals`);
  }
  return token;
}

/** Monad assets whose live asset id no longer matches MONAD_ASSETS; empty when nothing drifted. */
export function monadAssetDrift(list: TokenList): MonadSymbol[] {
  return (Object.keys(MONAD_ASSETS) as MonadSymbol[]).filter((s) => {
    try {
      return monadAsset(list, s).assetId !== MONAD_ASSETS[s].assetId;
    } catch {
      return true;
    }
  });
}
