import type { Address } from "viem";

/** Perpl endpoints and contracts per Monad network; markets come from the live context. */
export interface PerplNetwork {
  chainId: number;
  /** REST base, including /api. */
  rest: string;
  /** WebSocket base, without /api. */
  ws: string;
  exchange: Address;
  collateral: Address;
  collateralDecimals: number;
}

export const PERPL_NETWORKS: Record<number, PerplNetwork> = {
  143: {
    chainId: 143,
    rest: "https://app.perpl.xyz/api",
    ws: "wss://app.perpl.xyz",
    exchange: "0x34B6552d57a35a1D042CcAe1951BD1C370112a6F",
    collateral: "0x00000000eFE302BEAA2b3e6e1b18d08D69a9012a",
    collateralDecimals: 6,
  },
  10143: {
    chainId: 10143,
    rest: "https://testnet.perpl.xyz/api",
    ws: "wss://testnet.perpl.xyz",
    exchange: "0x1964C32f0bE608E7D29302AFF5E61268E72080cc",
    collateral: "0xa9012a055bd4e0eDfF8Ce09f960291C09D5322dC",
    collateralDecimals: 6,
  },
};

export function perplNetwork(chainId: number): PerplNetwork {
  const n = PERPL_NETWORKS[chainId];
  if (!n) throw new Error(`Perpl is not available on chain ${chainId}`);
  return n;
}
