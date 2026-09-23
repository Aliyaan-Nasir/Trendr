import { indexer } from "envio";
import { MAINNET_PASSKEY_ACCOUNTS } from "./mainnet";

export const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

/** Id of the single Protocol row per chain. */
export const PROTOCOL_ID = "trendr";

/** AUSD, every collateral amount and Perpl CNS. */
export const AUSD_DECIMALS = 6;
/** UP and DOWN tokens use the collateral's decimals. */
export const OUTCOME_DECIMALS = 6;
/** TrendCoin is a plain 18-decimal ERC-20. */
export const COIN_DECIMALS = 18;
/** Attention index values: 1_000_000 is one point. */
export const INDEX_DECIMALS = 6;
/** Kuru fill prices are 1e18-scaled quote per whole base token. */
export const KURU_PRICE_DECIMALS = 18;

export const WAD = 10n ** 18n;
export const BPS = 10_000n;

/** OutcomeListing's fixed Kuru market parameters (contracts/src/outcome/OutcomeListing.sol). */
export const OUTCOME_MARKET_PARAMS = {
  pricePrecision: 10_000n,
  sizePrecision: 100n,
  tickSize: 10n,
  minSize: 100n,
  maxSize: 1_000_000_000n,
  takerFeeBps: 10,
  makerFeeBps: 0,
} as const;

/** AttentionPerp funding constants (contracts/src/perp/AttentionPerp.sol). */
export const FUNDING_RATE_PER_BLOCK_AT_FULL_SKEW = 200_000_000_000n;
export const MAX_FUNDING_RATE_PER_BLOCK = 200_000_000_000n;

/** BondingCurve.VIRTUAL_TOKENS: one billion coins, 18 decimals. */
export const CURVE_VIRTUAL_TOKENS = 1_000_000_000n * WAD;

interface ChainConstants {
  /** The quote coin (AUSD on Mainnet, Agora's test AUSD on Testnet). */
  ausd?: string;
  /** Kuru's MarginAccount, which escrows tokens behind resting orders. */
  kuruMarginAccount?: string;
  /** Trendr service wallets whose Perpl accounts are indexed, such as the Perpl bot. */
  botWallets: readonly string[];
  /** PasskeyAccount implementations (contracts/deployments) that Trendr accounts delegate to under EIP-7702. */
  passkeyAccounts: readonly string[];
}

/**
 * Addresses that are not in the chain's config. Mainnet's PasskeyAccount implementation comes from
 * its deployment through `pnpm mainnet:config` (src/lib/mainnet.ts), like config.mainnet.yaml.
 */
const CHAINS: Record<number, ChainConstants> = {
  10143: {
    ausd: "0xa9012a055bd4e0edff8ce09f960291c09d5322dc",
    kuruMarginAccount: "0xd029c2d98ff85d8f64799017fe00a59b1159ce02",
    botWallets: [
      "0x6cfacb4c9a1b63cbc87750ec471ce194bfea0211",
      "0x590a56b00a09715ae1d5d495840bf1b22b3ba221",
      "0x8b81c6fcb4b37417184f81a207a4d9104e07f9fa",
    ],
    // Version 2 (current) and version 1, which accounts run until they upgrade (packages/contracts-ts legacy.ts).
    passkeyAccounts: ["0xa3023591e43085c782444937f96f2b82e98b2524", "0xdf6c6019c70fc321211a0483e74e2dde839fa955"],
  },
  143: {
    ausd: "0x00000000efe302beaa2b3e6e1b18d08d69a9012a",
    kuruMarginAccount: "0x2a68ba1833cdf93fa9da1eebd7f46242ad8e90c5",
    // Add the Mainnet Autopilot bot wallet (AUTOPILOT_BOT_ADDRESS, lowercase) once it exists, so its
    // Perpl account is indexed.
    botWallets: [],
    passkeyAccounts: MAINNET_PASSKEY_ACCOUNTS,
  },
};

const EMPTY: ChainConstants = { botWallets: [], passkeyAccounts: [] };

export function chainConstants(chainId: number): ChainConstants {
  return CHAINS[chainId] ?? EMPTY;
}

export function isBotWallet(chainId: number, address: string): boolean {
  return chainConstants(chainId).botWallets.includes(address.toLowerCase());
}

export function isPasskeyImplementation(chainId: number, address: string): boolean {
  return chainConstants(chainId).passkeyAccounts.includes(address.toLowerCase());
}

type ConfiguredContract =
  | "OutcomeMarkets"
  | "OutcomeListing"
  | "AttentionPerp"
  | "BondingCurve"
  | "KuruGraduationVenue"
  | "CurationFees"
  | "TrendrSpot"
  | "KuruRouter"
  | "PerplExchange";

function configuredAddresses(chainId: number, contract: ConfiguredContract): readonly string[] {
  const chain = (indexer.chains as unknown as Record<number, Record<string, { addresses: readonly string[] }>>)[
    chainId
  ];
  return chain?.[contract]?.addresses ?? [];
}

export function isContract(chainId: number, contract: ConfiguredContract, address: string): boolean {
  return configuredAddresses(chainId, contract).includes(address.toLowerCase());
}

const infrastructure = new Map<number, Set<string>>();

/**
 * Contracts that only hold Trendr tokens in passing or in escrow. They keep balance rows but are
 * never counted as holders or traders.
 */
export function isInfrastructure(chainId: number, address: string): boolean {
  let set = infrastructure.get(chainId);
  if (!set) {
    const contracts: ConfiguredContract[] = [
      "OutcomeMarkets",
      "OutcomeListing",
      "AttentionPerp",
      "BondingCurve",
      "KuruGraduationVenue",
      "CurationFees",
      "TrendrSpot",
      "KuruRouter",
      "PerplExchange",
    ];
    set = new Set(contracts.flatMap((c) => configuredAddresses(chainId, c)));
    const margin = chainConstants(chainId).kuruMarginAccount;
    if (margin) set.add(margin);
    infrastructure.set(chainId, set);
  }
  return set.has(address.toLowerCase());
}
