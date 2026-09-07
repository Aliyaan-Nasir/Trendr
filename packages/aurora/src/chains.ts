import { isAddress } from "viem";

/**
 * Aurora chain codes (the `blockchain` field of a token) and what Trendr needs to know about each:
 * a display name for transfer requirements and the address family, used to check that a refund
 * address can exist on the chain the user sends from.
 */

export type AddressFamily = "evm" | "solana" | "other";

const NAMES: Record<string, string> = {
  abs: "Abstract",
  adi: "ADI",
  aleo: "Aleo",
  aptos: "Aptos",
  arb: "Arbitrum",
  aurora: "Aurora",
  avax: "Avalanche",
  base: "Base",
  bch: "Bitcoin Cash",
  bera: "Berachain",
  bsc: "BNB Chain",
  btc: "Bitcoin",
  cardano: "Cardano",
  dash: "Dash",
  doge: "Dogecoin",
  eth: "Ethereum",
  fogo: "Fogo",
  gnosis: "Gnosis",
  hood: "Robinhood Chain",
  hypercore: "Hyperliquid",
  ltc: "Litecoin",
  monad: "Monad",
  movement: "Movement",
  near: "NEAR",
  op: "Optimism",
  plasma: "Plasma",
  pol: "Polygon",
  scroll: "Scroll",
  sol: "Solana",
  starknet: "Starknet",
  stellar: "Stellar",
  sui: "Sui",
  ton: "TON",
  tron: "Tron",
  xlayer: "X Layer",
  xrp: "XRP Ledger",
  zec: "Zcash",
};

/** EVM chains Aurora lists, where a refund address is a 20-byte 0x address. */
export const EVM_CHAINS: ReadonlySet<string> = new Set([
  "abs", "adi", "arb", "aurora", "avax", "base", "bera", "bsc", "eth", "gnosis", "hood", "monad", "op", "plasma", "pol", "scroll", "xlayer",
]);

export function chainName(blockchain: string): string {
  return NAMES[blockchain] ?? blockchain.toUpperCase();
}

export function addressFamily(blockchain: string): AddressFamily {
  if (EVM_CHAINS.has(blockchain)) return "evm";
  if (blockchain === "sol") return "solana";
  return "other";
}

const BASE58 = /^[1-9A-HJ-NP-Za-km-z]+$/;

/**
 * Whether `address` can be an account on `blockchain`. EVM and Solana are checked exactly; other
 * chains only need a non-empty value here, because Aurora validates them itself ("refundTo is not
 * valid") before it quotes.
 */
export function isAddressOn(blockchain: string, address: string): boolean {
  switch (addressFamily(blockchain)) {
    case "evm":
      return isAddress(address, { strict: false });
    case "solana":
      return address.length >= 32 && address.length <= 44 && BASE58.test(address);
    default:
      return address.trim().length > 0 && address.trim() === address;
  }
}
