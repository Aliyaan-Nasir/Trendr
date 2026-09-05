import { type Address, getAddress, type Hex } from "viem";

/**
 * Activation tickets. The relayer pays the gas of every account activation (about 0.1 MON on
 * Testnet), and anyone can make fresh accounts for free, so the relayer activates only accounts the
 * backend vouched for. After its anti-abuse checks (the account is new, and the caller's network
 * and Trendr as a whole are within their sign-up caps) the backend signs a short-lived ticket naming
 * the account, and the relayer checks it against the backend's ticket key before paying.
 *
 * A ticket names one account, which can be activated only once, so it needs no nonce. The domain is
 * bound to the chain and is neither an account's nor the API's, so no other signature passes for one.
 */

/** How long a ticket stays valid: one sign-up, retries included. */
export const ACTIVATION_TICKET_TTL_SEC = 600;

export const activationTicketTypes = {
  ActivationTicket: [
    { name: "account", type: "address" },
    { name: "expiresAt", type: "uint64" },
  ],
} as const;

/** What the backend issues and the app passes on to the relayer with the activation. */
export interface ActivationTicket {
  expiresAt: number;
  signature: Hex;
}

export function activationTicketTypedData(chainId: number, account: Address, expiresAt: number) {
  return {
    domain: { name: "Trendr activation", version: "1", chainId },
    types: activationTicketTypes,
    primaryType: "ActivationTicket" as const,
    message: { account: getAddress(account), expiresAt: BigInt(expiresAt) },
  };
}
