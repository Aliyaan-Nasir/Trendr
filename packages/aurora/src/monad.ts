import type { Address } from "viem";

/**
 * Monad Mainnet as Aurora sees it. Aurora supports Monad Mainnet only (chain 143), and lists three
 * Monad assets: MON, USDC and USDT0. AUSD, Trendr's collateral, is not an Aurora asset, so every
 * deposit lands as USDC and is converted to AUSD on Kuru (see kuru.ts).
 */

export const MONAD_CHAIN_ID = 143;
/** Aurora's chain code for Monad. */
export const MONAD_BLOCKCHAIN = "monad";

export type MonadSymbol = "USDC" | "USDT0" | "MON";

export interface MonadAsset {
  symbol: MonadSymbol;
  /** Aurora asset id (NEAR Intents multi-token id). */
  assetId: string;
  /** ERC-20 contract, or null for native MON. */
  address: Address | null;
  decimals: number;
}

/** Verified against the live token list on 2026-10-09; `monadAsset` re-checks it at runtime. */
export const MONAD_ASSETS: Record<MonadSymbol, MonadAsset> = {
  USDC: {
    symbol: "USDC",
    assetId: "nep245:v2_1.omni.hot.tg:143_2dmLwYWkCQKyTjeUPAsGJuiVLbFx",
    address: "0x754704Bc059F8C67012fEd69BC8A327a5aafb603",
    decimals: 6,
  },
  USDT0: {
    symbol: "USDT0",
    assetId: "nep245:v2_1.omni.hot.tg:143_4EJiJxSALvGoTZbnc8K7Ft9533et",
    address: "0xe7cd86e13AC4309349F30B3435a9d337750fC82D",
    decimals: 6,
  },
  MON: {
    symbol: "MON",
    assetId: "nep245:v2_1.omni.hot.tg:143_11111111111111111111",
    address: null,
    decimals: 18,
  },
};

/** Agora Dollar on Monad Mainnet: Trendr's collateral. Not listed by Aurora. */
export const AUSD_MAINNET = { address: "0x00000000eFE302BEAA2b3e6e1b18d08D69a9012a", decimals: 6 } as const satisfies {
  address: Address;
  decimals: number;
};
