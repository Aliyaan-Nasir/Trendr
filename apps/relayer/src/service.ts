import {
  ACTIVATION_TICKET_TTL_SEC,
  type ActivationTicket,
  activationTicketTypedData,
  type Call,
  type Deployment,
  delegateOf,
  encodeExecuteAsOwner,
  encodeExecuteWithSession,
  encodeInitialize,
  encodeUpgrade,
  legacyPasskeyAccounts,
  passkeyAccountAbi,
  passkeyAccountVersion,
  type SessionConfig,
  tradingPermissions,
  type WebAuthnAuth,
} from "@trendr/contracts";
import { type Address, type Hex, isAddressEqual, type SignedAuthorization } from "viem";
import { recoverAuthorizationAddress, recoverTypedDataAddress } from "viem/utils";
import { type Chain, type Sent, SimulationRevert } from "@trendr/chain";
import { type BudgetLimits, type BudgetStore, type BudgetUsage, DEFAULT_LIMITS, MemoryBudget, type RelayKind } from "./budget";
import { AccountLanes } from "./lanes";
import { checkOwnerCalls, checkSessionCalls, checkSessionConfig, checkUpgradeSessions, type PolicyResult } from "./policy";
import { CachedTrendrTokens, chainTokenLookup, type TrendrTokens } from "./tokens";

export class RelayError extends Error {
  constructor(
    readonly status: 400 | 403 | 409 | 422 | 429 | 502,
    readonly code: string,
    message: string,
    /** Seconds until a refused request may succeed, for 429s. */
    readonly retryAfter?: number,
  ) {
    super(message);
  }
}

export const GAS_CAP = { session: 2_000_000n, owner: 1_500_000n } as const;

/**
 * Activation writes one storage slot per session permission, so its cap grows with them. Sessions
 * carry exactly the standard trading permissions (checkSessionConfig), so the relayer caps every
 * activation at the cap for that count.
 */
export function activationGasCap(permissions: number): bigint {
  return 400_000n + 40_000n * BigInt(permissions);
}

/** Requests per account in flight or waiting their turn; the next one is refused. */
export const MAX_PENDING_PER_ACCOUNT = 3;
/** Signed requests must expire soon, so a captured request cannot be replayed much later. */
const MAX_DEADLINE_AHEAD = 3_600;

export interface ActivateInput {
  account: Address;
  authorization: SignedAuthorization;
  owner: { x: Hex; y: Hex };
  session: SessionConfig;
  deadline: bigint;
  eoaSignature: Hex;
  /** The backend's ticket for this account; required when the service has a ticket signer. */
  ticket?: ActivationTicket;
}

/** Moving a version 1 account to the deployment's PasskeyAccount (see PasskeyAccount.upgrade). */
export interface UpgradeInput {
  account: Address;
  authorization: SignedAuthorization;
  sessions: SessionConfig[];
  deadline: bigint;
  eoaSignature: Hex;
}

export interface SessionInput {
  account: Address;
  calls: Call[];
  sessionKey: Address;
  deadline: bigint;
  signature: Hex;
}

export interface OwnerInput {
  account: Address;
  calls: Call[];
  deadline: bigint;
  auth: WebAuthnAuth;
}

export interface AccountStatus {
  delegatedTo: Address | null;
  /** Initialized on a Trendr PasskeyAccount, the current one or a replaced version 1. */
  active: boolean;
  /** 2 on the deployment's PasskeyAccount, 1 on a replaced one (it should upgrade), else null. */
  version: 1 | 2 | null;
}

export interface ServiceConfig {
  deployment: Deployment;
  maxSessionDailyLimit: bigint;
  maxSessionLifetime: number;
  /** The backend's activation ticket key: when set, every activation needs a ticket it signed. */
  activationTicketSigner?: Address;
  /** Replaced (version 1) PasskeyAccounts; @trendr/contracts lists them per chain. */
  legacyPasskeyAccounts?: readonly Address[];
  /** Sponsorship budgets; DEFAULT_LIMITS for any left out. */
  limits?: Partial<BudgetLimits>;
  maxPendingPerAccount?: number;
}

/** Collaborators the service builds for itself unless given (tests pass fakes). */
export interface ServiceDeps {
  budget?: BudgetStore;
  tokens?: TrendrTokens;
}

/** The transaction a relay sends once every check has passed. */
interface Prepared {
  data: Hex;
  authorizationList?: SignedAuthorization[];
}

function enforce(r: PolicyResult) {
  if (!r.ok) throw new RelayError(403, "policy", r.index === undefined ? r.reason : `call ${r.index}: ${r.reason}`);
}

export class RelayerService {
  private readonly budget: BudgetStore;
  private readonly tokens: TrendrTokens;
  private readonly lanes: AccountLanes;

  constructor(
    private readonly chain: Chain,
    private readonly cfg: ServiceConfig,
    private readonly now: () => number = () => Math.floor(Date.now() / 1000),
    deps: ServiceDeps = {},
  ) {
    this.budget = deps.budget ?? new MemoryBudget({ ...DEFAULT_LIMITS, ...cfg.limits });
    this.tokens = deps.tokens ?? new CachedTrendrTokens(chainTokenLookup(chain, cfg.deployment));
    this.lanes = new AccountLanes(cfg.maxPendingPerAccount ?? MAX_PENDING_PER_ACCOUNT);
  }

  /** Delegation target from the account's EIP-7702 designator (0xef0100 || address), and which Trendr version it runs. */
  async status(account: Address): Promise<AccountStatus> {
    const delegatedTo = delegateOf(await this.chain.code(account));
    const d = this.cfg.deployment;
    const version = passkeyAccountVersion(d, delegatedTo, this.cfg.legacyPasskeyAccounts ?? legacyPasskeyAccounts(d.chainId));
    let active = false;
    if (version !== null) {
      active = (await this.chain.read({ address: account, abi: passkeyAccountAbi, functionName: "isInitialized" })) === true;
    }
    return { delegatedTo, active, version };
  }

  /** Gas spent against the budgets, and accounts with a relay in flight, for health. */
  async usage(): Promise<BudgetUsage & { busyAccounts: number }> {
    return { ...(await this.budget.usage(this.now())), busyAccounts: this.lanes.busy };
  }

  async activate(input: ActivateInput): Promise<Sent> {
    const d = this.cfg.deployment;
    const cap = activationGasCap(tradingPermissions(d).length);
    return this.relay("activation", input.account, cap, async () => {
      enforce(checkSessionConfig(input.session, d, this.now(), this.cfg.maxSessionDailyLimit, this.cfg.maxSessionLifetime));
      this.checkDeadline(input.deadline);
      await this.checkTicket(input.account, input.ticket);
      const auth = input.authorization;
      if (!isAddressEqual(auth.address, d.passkeyAccount)) {
        throw new RelayError(403, "wrong_delegate", "the authorization must delegate to the Trendr PasskeyAccount");
      }
      if (auth.chainId !== this.chain.chainId) throw new RelayError(400, "wrong_chain", "the authorization is for another chain");
      const signer = await recoverAuthorizationAddress({ authorization: auth });
      if (!isAddressEqual(signer, input.account)) throw new RelayError(400, "bad_authorization", "the authorization is not signed by the account");

      const status = await this.status(input.account);
      if (status.active && status.version === 1) throw new RelayError(409, "upgrade_required", "the account runs version 1; upgrade it instead");
      if (status.active) throw new RelayError(409, "already_active", "the account is already active");
      // An account delegated to a Trendr implementation that never initialized activates afresh.
      if (status.delegatedTo && status.version === null) {
        throw new RelayError(409, "foreign_delegation", "the account is delegated to another contract");
      }
      if ((await this.chain.nonce(input.account)) !== auth.nonce) {
        throw new RelayError(409, "stale_authorization", "the authorization nonce does not match the account nonce");
      }
      return {
        data: encodeInitialize(input.owner, input.session, input.deadline, input.eoaSignature),
        authorizationList: [auth],
      };
    });
  }

  /**
   * The one-time move of a genuine version 1 account (initialized on a replaced PasskeyAccount) to
   * the deployment's PasskeyAccount: the account key's EIP-7702 authorization to exactly that
   * contract, sent with `upgrade` and the standard trading session it signed. Counts as an
   * activation against the budgets.
   */
  async upgrade(input: UpgradeInput): Promise<Sent> {
    const d = this.cfg.deployment;
    const cap = activationGasCap(tradingPermissions(d).length);
    return this.relay("activation", input.account, cap, async () => {
      enforce(checkUpgradeSessions(input.sessions, d, this.now(), this.cfg.maxSessionDailyLimit, this.cfg.maxSessionLifetime));
      this.checkDeadline(input.deadline);
      const auth = input.authorization;
      if (!isAddressEqual(auth.address, d.passkeyAccount)) {
        throw new RelayError(403, "wrong_delegate", "an upgrade must delegate to the current Trendr PasskeyAccount");
      }
      if (auth.chainId !== this.chain.chainId) throw new RelayError(400, "wrong_chain", "the authorization is for another chain");
      const signer = await recoverAuthorizationAddress({ authorization: auth });
      if (!isAddressEqual(signer, input.account)) throw new RelayError(400, "bad_authorization", "the authorization is not signed by the account");

      const status = await this.status(input.account);
      if (status.version === 2) throw new RelayError(409, "already_upgraded", "the account already runs the current PasskeyAccount");
      if (status.version !== 1 || !status.active) {
        throw new RelayError(409, "not_upgradable", "only an active version 1 Trendr account can upgrade");
      }
      if ((await this.chain.nonce(input.account)) !== auth.nonce) {
        throw new RelayError(409, "stale_authorization", "the authorization nonce does not match the account nonce");
      }
      return { data: encodeUpgrade(input.sessions, input.deadline, input.eoaSignature), authorizationList: [auth] };
    });
  }

  async executeSession(input: SessionInput): Promise<Sent> {
    return this.relay("session", input.account, GAS_CAP.session, async () => {
      enforce(await checkSessionCalls(input.calls, this.cfg.deployment, this.tokens));
      this.checkDeadline(input.deadline);
      await this.requireActive(input.account);
      return { data: encodeExecuteWithSession(input.calls, input.sessionKey, input.deadline, input.signature) };
    });
  }

  async executeOwner(input: OwnerInput): Promise<Sent> {
    return this.relay("owner", input.account, GAS_CAP.owner, async () => {
      enforce(await checkOwnerCalls(input.calls, this.cfg.deployment, input.account, this.tokens));
      this.checkDeadline(input.deadline);
      await this.requireActive(input.account);
      return { data: encodeExecuteAsOwner(input.calls, input.deadline, input.auth) };
    });
  }

  /**
   * Activations cost the relayer gas and fresh accounts cost nothing, so with a ticket signer set an
   * activation must carry the backend's ticket for this very account, still valid. A ticket for one
   * account cannot activate another, and an account activates once, so tickets need no nonce.
   */
  private async checkTicket(account: Address, ticket: ActivationTicket | undefined) {
    const signer = this.cfg.activationTicketSigner;
    if (!signer) return;
    if (!ticket) throw new RelayError(403, "ticket_required", "activation needs a ticket from the Trendr API");
    const now = this.now();
    if (ticket.expiresAt <= now) throw new RelayError(403, "ticket_expired", "the activation ticket has expired");
    if (ticket.expiresAt > now + ACTIVATION_TICKET_TTL_SEC) throw new RelayError(403, "bad_ticket", "the activation ticket lasts too long");
    const recovered = await recoverTypedDataAddress({ ...activationTicketTypedData(this.chain.chainId, account, ticket.expiresAt), signature: ticket.signature }).catch(() => null);
    if (!recovered || !isAddressEqual(recovered, signer)) throw new RelayError(403, "bad_ticket", "the activation ticket is not for this account");
  }

  private checkDeadline(deadline: bigint) {
    const now = BigInt(this.now());
    if (deadline < now) throw new RelayError(400, "expired", "the request deadline has passed");
    if (deadline > now + BigInt(MAX_DEADLINE_AHEAD)) throw new RelayError(400, "deadline_too_far", "the request deadline is too far ahead");
  }

  private async requireActive(account: Address) {
    const status = await this.status(account);
    if (!status.active) throw new RelayError(409, "not_active", "the account is not an active Trendr account");
  }

  /**
   * One relay: waits for the account's earlier relays, reserves the gas cap against the budgets,
   * runs the checks, then simulates and sends. The budgets keep the gas limit actually sent, all
   * of the cap when the outcome is unknown, and nothing when no transaction went out.
   */
  private async relay(kind: RelayKind, account: Address, gasCap: bigint, prepare: () => Promise<Prepared>): Promise<Sent> {
    const run = this.lanes.run(account, async () => {
      const reserved = await this.budget.reserve(account, kind, gasCap, this.now());
      if (!reserved.ok) throw new RelayError(429, reserved.code, reserved.message, reserved.retryAfter);
      let spent = 0n;
      try {
        const tx = await prepare();
        spent = gasCap;
        const sent = await this.chain.send({ to: account, data: tx.data, gasCap, authorizationList: tx.authorizationList });
        spent = sent.gasLimit;
        if (sent.status !== "success") {
          await this.budget.recordRevert(account, this.now());
          throw new RelayError(502, "reverted", `transaction ${sent.hash} reverted`);
        }
        return sent;
      } catch (e) {
        if (e instanceof SimulationRevert) {
          spent = 0n;
          throw new RelayError(422, "simulation_failed", e.reason);
        }
        throw e;
      } finally {
        await this.budget.settle(reserved.reservation, spent);
      }
    });
    if (!run) throw new RelayError(409, "account_busy", "this account already has requests in flight; wait for them to finish");
    return run;
  }
}
