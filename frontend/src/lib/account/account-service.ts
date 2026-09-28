import {
  createPasskeyWithPrfOutput,
  createSecp256k1SigningSession,
  getPasskeyPrfOutput,
  type Secp256k1SigningSession,
} from "@category-labs/mera";
import { toViemAccount } from "@category-labs/mera/viem";
import {
  type ActivationTicket,
  type Call,
  type Deployment,
  delegateOf,
  initializeTypedData,
  type OwnerAssertion,
  ownerExecuteDigest,
  passkeyAccountAbi,
  passkeyAccountVersion,
  type SessionConfig,
  sessionExecuteTypedData,
  sessionMarker,
  toWebAuthnAuth,
  tradingPermissions,
  upgradeTypedData,
} from "@trendr/contracts";
import {
  type Address,
  createPublicClient,
  encodeFunctionData,
  fallback,
  type Hex,
  hexToBytes,
  http,
  isAddressEqual,
  type LocalAccount,
  type PublicClient,
  zeroAddress,
} from "viem";
import { accountPrivateKey, identityPrivateKey, perplApiSeed, privateDataSalt, sessionPrivateKey, vaultKey } from "./keys";
import { clearPrivateKeys, loadPrivateKeys, type PrivateKeys, savePrivateKeys } from "./private-store";
import { type Relayed, type RelayerClient, RelayerError } from "./relayer";
import { clearSession, loadSession, saveSession, type StoredSession } from "./session-store";
import { createTrendrWebAuthnClient } from "./webauthn-client";

export interface AccountConfig {
  chainId: number;
  deployment: Deployment;
  /** Read endpoints, in order of preference. */
  rpcUrls: readonly string[];
  rpId: string;
  rpName: string;
  /** How long a trading session lasts before it needs one passkey prompt to renew. */
  sessionLifetimeSec: number;
  /** AUSD (raw units) the session may spend per day without a prompt. */
  sessionDailyLimit: bigint;
}

/** The stages of creating an account, in order (the last, syncing with Trendr's backend, is the app's). */
export type SignUpStep = "passkey" | "account" | "session" | "sync";

export interface ActiveAccount {
  address: Address;
  credentialId: string;
  sessionAddress: Address;
  validUntil: number;
}

/** Thrown when the account exists but its trading session expired; one prompt renews it. */
export class SessionExpiredError extends Error {}
/**
 * Thrown when the trading session was added under an older set of permissions (before Trendr
 * tightened what sessions may do) and cannot reach the current contracts; one prompt renews it.
 */
export class SessionOutdatedError extends SessionExpiredError {}

const OUTDATED = "Trendr updated what trading sessions may do. Renew your session with your passkey to keep trading.";

/**
 * Thrown when the account still runs PasskeyAccount version 1: one passkey prompt upgrades it (same
 * address, passkey, funds and positions) and starts a session with version 2's limits.
 */
export class AccountUpgradeRequiredError extends SessionExpiredError {}

const UPGRADE = "Trendr upgraded its accounts. One passkey prompt moves yours to the new version, with the same address, funds and passkey.";

/** Thrown when a passkey answered but its account was never activated on this device's flow. */
export class AccountNotActivatedError extends Error {}

const PENDING_KEY = "trendr.pending-activation";
const MAX_EPOCHS = 16;

interface OnchainSession {
  validUntil: number;
  active: boolean;
  nonce: bigint;
}

/** Keys from the passkey's private-data namespace, unlinkable to the trading account. */
export interface PrivateIdentity {
  /** The caller identity: signs public calls and posts. */
  identity: LocalAccount;
  /** Seals Autopilot strategies and notes; non-extractable. */
  vaultKey: CryptoKey;
  /** Seed of the passkey-derived Perpl API key (Ed25519). */
  perplSeed: Uint8Array;
}

export class AccountService {
  private readonly client: PublicClient;
  private webauthn?: Awaited<ReturnType<typeof this.webauthnClient>>;
  private session?: { signer: Secp256k1SigningSession; account: LocalAccount; meta: StoredSession };
  private privateData?: { signer: Secp256k1SigningSession; value: PrivateIdentity };
  private restoring: Promise<ActiveAccount | null> | null = null;
  /** The passkey of a restored account that must upgrade, so the upgrade prompt offers just it. */
  private credentialHint: string | null = null;

  constructor(
    private readonly cfg: AccountConfig,
    private readonly relayer: RelayerClient,
    /** The API's activation ticket for a new account (see @trendr/contracts activation-ticket), or null without one. */
    private readonly ticket: (account: Address) => Promise<ActivationTicket | null> = async () => null,
  ) {
    this.client = createPublicClient({ transport: cfg.rpcUrls.length > 1 ? fallback(cfg.rpcUrls.map((u) => http(u, { retryCount: 1 })), { retryCount: 1 }) : http(cfg.rpcUrls[0]) });
  }

  private async webauthnClient() {
    return createTrendrWebAuthnClient(await privateDataSalt());
  }

  private async ceremonyClient() {
    this.webauthn ??= await this.webauthnClient();
    this.webauthn.reset();
    return this.webauthn;
  }

  get active(): ActiveAccount | null {
    const m = this.session?.meta;
    return m ? { address: m.account, credentialId: m.credentialId, sessionAddress: m.sessionAddress, validUntil: m.validUntil } : null;
  }

  /**
   * Restores a session stored on this device, without a prompt. Null when there is none or it
   * ended. Concurrent calls (React runs mount effects twice in development) share one restore, so
   * a slower duplicate can never end the signing keys a faster one already handed out.
   */
  restore(): Promise<ActiveAccount | null> {
    this.restoring ??= this.restoreOnce().finally(() => {
      this.restoring = null;
    });
    return this.restoring;
  }

  private async restoreOnce(): Promise<ActiveAccount | null> {
    const stored = await loadSession();
    if (!stored) return null;
    if ((await this.version(stored.meta.account)) === 1) {
      this.credentialHint = stored.meta.credentialId;
      throw new AccountUpgradeRequiredError(UPGRADE);
    }
    const onchain = await this.readSession(stored.meta.account, stored.meta.sessionAddress);
    if (!onchain.active || onchain.validUntil <= this.now()) return null;
    if (!(await this.isCurrent(stored.meta.account, stored.meta.sessionAddress))) throw new SessionOutdatedError(OUTDATED);
    this.useSession(stored.meta, stored.sessionKey);
    const keys = await loadPrivateKeys(stored.meta.account);
    if (keys) this.usePrivate(keys);
    return this.active;
  }

  /** The private-data keys, when this device holds them. */
  get privateIdentity(): PrivateIdentity | null {
    return this.privateData?.value ?? null;
  }

  /** Prompt-free: signs a message with the trading session key (backend sign-in). */
  async signWithSession(message: string): Promise<{ signer: Address; signature: Hex }> {
    const s = this.session;
    if (!s) throw new SessionExpiredError("No active trading session.");
    return { signer: s.meta.sessionAddress, signature: await s.account.signMessage({ message }) };
  }

  /** One passkey prompt: rebuilds the private-data keys on a device that lost them. */
  async unlockPrivate(): Promise<PrivateIdentity> {
    const a = this.active;
    if (!a) throw new Error("Sign in first.");
    const w = await this.ceremonyClient();
    const result = await getPasskeyPrfOutput({ rpId: this.cfg.rpId, credential: { credentialId: a.credentialId }, webAuthnClient: w.client });
    result.prfOutput.fill(0);
    await this.capturePrivate(a.address, w.captured().privateDataPrf);
    if (!this.privateData) throw new Error("This passkey provider did not return the private-data key.");
    return this.privateData.value;
  }

  /**
   * One passkey prompt: creates the passkey, derives the account and activates it gas-free.
   * `onStep` hears each stage as it starts, for the sign-up checklist.
   */
  async signUp(onStep?: (step: SignUpStep) => void): Promise<ActiveAccount> {
    onStep?.("passkey");
    const w = await this.ceremonyClient();
    const created = await createPasskeyWithPrfOutput({
      rp: { id: this.cfg.rpId, name: this.cfg.rpName },
      user: { name: "Trendr", displayName: "Trendr account" },
      webAuthnClient: w.client,
    });
    const publicKey = w.captured().publicKey;
    if (!publicKey) throw new Error("The passkey did not report its public key.");
    const credentialId = created.credentialId;
    // Not secret: lets a retry finish activation if the network fails after the prompt.
    localStorage.setItem(PENDING_KEY, JSON.stringify({ credentialId, publicKey }));
    const privatePrf = w.captured().privateDataPrf;
    try {
      onStep?.("account");
      const active = await this.activate(created.prfOutput, publicKey, credentialId, () => onStep?.("session"));
      await this.capturePrivate(active.address, privatePrf);
      return active;
    } finally {
      created.prfOutput.fill(0);
    }
  }

  /** One passkey prompt: rebuilds the account and its session from the passkey alone. */
  async signIn(): Promise<ActiveAccount> {
    const w = await this.ceremonyClient();
    const result = await getPasskeyPrfOutput({ rpId: this.cfg.rpId, webAuthnClient: w.client });
    const credentialId = result.credentialId;
    try {
      const address = this.accountAddress(result.prfOutput);
      const status = await this.relayer.status(address);
      if (!status.active) {
        const pending = this.pending(credentialId);
        if (!pending) throw new AccountNotActivatedError("This passkey has no Trendr account yet.");
        const privatePrf = w.captured().privateDataPrf;
        const active = await this.activate(result.prfOutput, pending.publicKey, credentialId);
        await this.capturePrivate(active.address, privatePrf);
        return active;
      }
      // A version 1 account upgrades within this same prompt.
      if (status.version === 1) return await this.upgradeWith(result.prfOutput, credentialId, w.captured().privateDataPrf);
      const { epoch, key, onchain } = await this.currentSession(result.prfOutput, address);
      if (!onchain.active || onchain.validUntil <= this.now()) {
        throw new SessionExpiredError("Your trading session ended. Renew it with your passkey.");
      }
      if (!(await this.isCurrent(address, this.addressOf(key)))) throw new SessionOutdatedError(OUTDATED);
      const meta: StoredSession = { account: address, credentialId, sessionAddress: this.addressOf(key), epoch, validUntil: onchain.validUntil };
      await saveSession(meta, key);
      this.useSession(meta, key);
      await this.capturePrivate(address, w.captured().privateDataPrf);
      return this.active!;
    } finally {
      result.prfOutput.fill(0);
    }
  }

  /**
   * One passkey prompt that both unlocks the account and renews its trading session: the prompt
   * signs an owner batch adding the session key for the current epoch with a new expiry.
   */
  async renewSession(): Promise<ActiveAccount> {
    const w = await this.ceremonyClient();
    // The account is only known after the prompt, so first learn it, then sign the renewal.
    const first = await getPasskeyPrfOutput({ rpId: this.cfg.rpId, webAuthnClient: w.client });
    const credentialId = first.credentialId;
    try {
      const address = this.accountAddress(first.prfOutput);
      if ((await this.version(address)) === 1) return await this.upgradeWith(first.prfOutput, credentialId, w.captured().privateDataPrf);
      const { epoch, key } = await this.currentSession(first.prfOutput, address);
      const config = this.sessionConfig(this.addressOf(key));
      const calls: Call[] = [{ target: address, value: 0n, data: encodeFunctionData({ abi: passkeyAccountAbi, functionName: "addSession", args: [config] }) }];
      const privatePrf = w.captured().privateDataPrf;
      await this.ownerExecuteAs(address, credentialId, calls);
      const meta: StoredSession = { account: address, credentialId, sessionAddress: config.key, epoch, validUntil: config.validUntil };
      await saveSession(meta, key);
      this.useSession(meta, key);
      await this.capturePrivate(address, privatePrf);
      return this.active!;
    } finally {
      first.prfOutput.fill(0);
    }
  }

  /**
   * One passkey prompt: moves a version 1 account to the current PasskeyAccount. The passkey's PRF
   * output rebuilds the account key, which signs the EIP-7702 authorization and the `Upgrade` over
   * a new trading session for the same session key; the relayer sends both at once. The address,
   * passkey owner, funds, positions and private keys stay as they are.
   */
  async upgrade(): Promise<ActiveAccount> {
    const w = await this.ceremonyClient();
    const hint = this.credentialHint;
    const result = await getPasskeyPrfOutput({ rpId: this.cfg.rpId, ...(hint ? { credential: { credentialId: hint } } : {}), webAuthnClient: w.client });
    try {
      return await this.upgradeWith(result.prfOutput, result.credentialId, w.captured().privateDataPrf);
    } finally {
      result.prfOutput.fill(0);
    }
  }

  /** Prompt-free: a batch signed by the session key, inside its limits, relayed gas-free. */
  async trade(calls: Call[]): Promise<Relayed> {
    const s = this.session;
    if (!s) throw new SessionExpiredError("No active trading session.");
    if (s.meta.validUntil <= this.now()) throw new SessionExpiredError("Your trading session ended.");
    const onchain = await this.readSession(s.meta.account, s.meta.sessionAddress);
    const deadline = BigInt(this.now() + 300);
    const signature = await s.account.signTypedData(
      sessionExecuteTypedData(this.cfg.chainId, s.meta.account, calls, s.meta.sessionAddress, onchain.nonce, deadline),
    );
    try {
      return await this.relayer.session({ account: s.meta.account, calls, sessionKey: s.meta.sessionAddress, deadline, signature });
    } catch (e) {
      // A session from before the current permissions cannot reach the contracts trades use now.
      if (e instanceof RelayerError && (e.code === "policy" || e.code === "simulation_failed") && !(await this.isCurrent(s.meta.account, s.meta.sessionAddress))) {
        throw new SessionOutdatedError(OUTDATED);
      }
      throw e;
    }
  }

  /** One passkey prompt: an owner batch (withdrawals, session changes) signed by the passkey. */
  async ownerExecute(calls: Call[]): Promise<Relayed> {
    const a = this.active;
    if (!a) throw new Error("Sign in first.");
    return this.ownerExecuteAs(a.address, a.credentialId, calls);
  }

  /**
   * One passkey prompt: the passkey signs `digest` as its WebAuthn challenge, approving one backend
   * action (see @trendr/contracts owner-approval). Nothing is sent on chain.
   */
  async signOwnerChallenge(digest: Hex): Promise<OwnerAssertion> {
    const a = this.active;
    if (!a) throw new Error("Sign in first.");
    const { authenticatorData, clientDataJSON, r, s } = toWebAuthnAuth(await this.assert(a.credentialId, digest));
    return { authenticatorData, clientDataJSON, r, s };
  }

  /** Ends the in-memory session; the encrypted copy stays on this device. */
  lock() {
    this.session?.signer.end();
    this.session = undefined;
    this.privateData?.signer.end();
    this.privateData = undefined;
  }

  /** Signs out on this device: ends the session and deletes the stored copies. */
  async logout() {
    this.lock();
    await clearSession();
    await clearPrivateKeys();
  }

  // --- internals -------------------------------------------------------------------------

  private now() {
    return Math.floor(Date.now() / 1000);
  }

  private addressOf(privateKey: Uint8Array): Address {
    const signer = createSecp256k1SigningSession({ privateKey });
    try {
      return toViemAccount(signer).address;
    } finally {
      signer.end();
    }
  }

  private accountAddress(prf: Uint8Array): Address {
    const key = accountPrivateKey(prf);
    try {
      return this.addressOf(key);
    } finally {
      key.fill(0);
    }
  }

  private pending(credentialId: string): { publicKey: { x: Hex; y: Hex } } | null {
    try {
      const p = JSON.parse(localStorage.getItem(PENDING_KEY) ?? "null") as { credentialId: string; publicKey: { x: Hex; y: Hex } } | null;
      return p && p.credentialId === credentialId ? p : null;
    } catch {
      return null;
    }
  }

  private sessionConfig(key: Address): SessionConfig {
    return {
      key,
      validUntil: this.now() + this.cfg.sessionLifetimeSec,
      dailyLimit: this.cfg.sessionDailyLimit,
      permissions: tradingPermissions(this.cfg.deployment),
    };
  }

  /**
   * Whether the session carries the current trading permissions (see sessionMarker): a guarded
   * marker must name the deployment's guard, so a session on a replaced Perpl order guard renews.
   */
  private async isCurrent(account: Address, key: Address): Promise<boolean> {
    const m = sessionMarker(this.cfg.deployment);
    if (isAddressEqual(m.guard, zeroAddress)) {
      return (await this.client.readContract({ address: account, abi: passkeyAccountAbi, functionName: "isPermitted", args: [key, m.target, m.selector] })) as boolean;
    }
    const guard = (await this.client.readContract({ address: account, abi: passkeyAccountAbi, functionName: "guardOf", args: [key, m.target, m.selector] })) as Address;
    return isAddressEqual(guard, m.guard);
  }

  /** The PasskeyAccount version the account runs: 2 current, 1 replaced (it upgrades), null for none. */
  private async version(account: Address): Promise<1 | 2 | null> {
    return passkeyAccountVersion(this.cfg.deployment, delegateOf(await this.client.getCode({ address: account })));
  }

  /**
   * The upgrade itself, from the passkey's PRF output: the session key is the first epoch version 1
   * never revoked (renewed in place), the account key signs the delegation to the current
   * PasskeyAccount and the `Upgrade` over that session, and the relayer sends both.
   */
  private async upgradeWith(prf: Uint8Array, credentialId: string, privatePrf: Uint8Array | undefined): Promise<ActiveAccount> {
    const accountKey = accountPrivateKey(prf);
    const signer = createSecp256k1SigningSession({ privateKey: accountKey });
    accountKey.fill(0);
    try {
      const owner = toViemAccount(signer);
      const status = await this.relayer.status(owner.address);
      if (status.version !== 1 || !status.active) throw new Error("This account does not need an upgrade.");
      const { epoch, key } = await this.currentSession(prf, owner.address);
      const session = this.sessionConfig(this.addressOf(key));
      const deadline = BigInt(this.now() + 600);
      const eoaSignature = await owner.signTypedData(upgradeTypedData(this.cfg.chainId, owner.address, [session], deadline));
      const nonce = await this.client.getTransactionCount({ address: owner.address });
      const authorization = await owner.signAuthorization!({ contractAddress: this.cfg.deployment.passkeyAccount, chainId: this.cfg.chainId, nonce });
      await this.relayer.upgrade({
        account: owner.address,
        authorization: {
          address: authorization.address,
          chainId: authorization.chainId,
          nonce: authorization.nonce,
          r: authorization.r,
          s: authorization.s,
          yParity: authorization.yParity,
        },
        sessions: [session],
        deadline,
        eoaSignature,
      });
      this.credentialHint = null;
      const meta: StoredSession = { account: owner.address, credentialId, sessionAddress: session.key, epoch, validUntil: session.validUntil };
      await saveSession(meta, key);
      this.useSession(meta, key);
      await this.capturePrivate(owner.address, privatePrf);
      return this.active!;
    } finally {
      // The account key lives only for this ceremony.
      signer.end();
    }
  }

  private async readSession(account: Address, key: Address): Promise<OnchainSession> {
    const s = (await this.client.readContract({ address: account, abi: passkeyAccountAbi, functionName: "sessionOf", args: [key] })) as {
      validUntil: number;
      active: boolean;
      nonce: bigint;
    };
    return { validUntil: Number(s.validUntil), active: s.active, nonce: BigInt(s.nonce) };
  }

  /**
   * The first session epoch that was never revoked. A revoked key is gone for good, so a lost
   * device's key can never be re-enabled; an expired key is renewed in place.
   */
  private async currentSession(prf: Uint8Array, account: Address) {
    for (let epoch = 0; epoch < MAX_EPOCHS; epoch++) {
      const key = await sessionPrivateKey(prf, epoch);
      const onchain = await this.readSession(account, this.addressOf(key));
      const revoked = onchain.validUntil > 0 && !onchain.active;
      if (!revoked) return { epoch, key, onchain };
    }
    throw new Error("No session epoch left; contact support.");
  }

  /** `onActivated` runs once the account is live on chain, before its session is stored here. */
  private async activate(prf: Uint8Array, publicKey: { x: Hex; y: Hex }, credentialId: string, onActivated?: () => void): Promise<ActiveAccount> {
    const accountKey = accountPrivateKey(prf);
    const signer = createSecp256k1SigningSession({ privateKey: accountKey });
    accountKey.fill(0);
    try {
      const owner = toViemAccount(signer);
      const sessionKey = await sessionPrivateKey(prf, 0);
      const session = this.sessionConfig(this.addressOf(sessionKey));
      // The ticket arrives while the account signs, so asking for it adds no wait.
      const ticketing = this.ticket(owner.address);
      ticketing.catch(() => undefined);
      const nonce = await this.client.getTransactionCount({ address: owner.address });
      const authorization = await owner.signAuthorization!({
        contractAddress: this.cfg.deployment.passkeyAccount,
        chainId: this.cfg.chainId,
        nonce,
      });
      const deadline = BigInt(this.now() + 600);
      const eoaSignature = await owner.signTypedData(initializeTypedData(this.cfg.chainId, owner.address, publicKey, session, deadline));
      const ticket = await ticketing;
      await this.relayer.activate({
        account: owner.address,
        authorization: {
          address: authorization.address,
          chainId: authorization.chainId,
          nonce: authorization.nonce,
          r: authorization.r,
          s: authorization.s,
          yParity: authorization.yParity,
        },
        owner: publicKey,
        session,
        deadline,
        eoaSignature,
        ...(ticket ? { ticket } : {}),
      });
      localStorage.removeItem(PENDING_KEY);
      onActivated?.();
      const meta: StoredSession = { account: owner.address, credentialId, sessionAddress: session.key, epoch: 0, validUntil: session.validUntil };
      await saveSession(meta, sessionKey);
      this.useSession(meta, sessionKey);
      return this.active!;
    } finally {
      // The owner key lives only for this ceremony.
      signer.end();
    }
  }

  /** Derives the private-data keys from the second PRF output and keeps them (wrapped) on this device. */
  private async capturePrivate(account: Address, prf: Uint8Array | undefined) {
    if (!prf) return;
    try {
      const keys: PrivateKeys = { identityKey: await identityPrivateKey(prf), vaultKey: await vaultKey(prf), perplSeed: await perplApiSeed(prf) };
      await savePrivateKeys(account, keys);
      this.usePrivate(keys);
    } finally {
      prf.fill(0);
    }
  }

  private usePrivate(keys: PrivateKeys) {
    this.privateData?.signer.end();
    const signer = createSecp256k1SigningSession({ privateKey: keys.identityKey });
    keys.identityKey.fill(0);
    this.privateData = { signer, value: { identity: toViemAccount(signer), vaultKey: keys.vaultKey, perplSeed: keys.perplSeed } };
  }

  private useSession(meta: StoredSession, key: Uint8Array) {
    this.session?.signer.end();
    const signer = createSecp256k1SigningSession({ privateKey: key });
    key.fill(0);
    this.session = { signer, account: toViemAccount(signer), meta };
  }

  private async ownerExecuteAs(account: Address, credentialId: string, calls: Call[]): Promise<Relayed> {
    const nonce = (await this.client.readContract({ address: account, abi: passkeyAccountAbi, functionName: "ownerNonce" })) as bigint;
    const deadline = BigInt(this.now() + 300);
    const digest = ownerExecuteDigest(this.cfg.chainId, account, calls, nonce, deadline);
    const assertion = await this.assert(credentialId, digest);
    return this.relayer.owner({ account, calls, deadline, auth: toWebAuthnAuth(assertion) });
  }

  /** One passkey prompt with `digest` as the challenge: the passkey's signature over it. */
  private async assert(credentialId: string, digest: Hex) {
    const w = await this.ceremonyClient();
    const result = await w.withChallenge(Uint8Array.from(hexToBytes(digest)), () =>
      getPasskeyPrfOutput({
        rpId: this.cfg.rpId,
        credential: { credentialId },
        webAuthnClient: w.client,
      }),
    );
    result.prfOutput.fill(0);
    const assertion = w.captured().assertion;
    if (!assertion) throw new Error("The passkey did not sign.");
    return assertion;
  }
}
