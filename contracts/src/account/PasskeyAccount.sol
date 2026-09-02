// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ReentrancyGuardTransient} from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";
import {WebAuthn} from "solady/utils/WebAuthn.sol";

import {IPermissionGuard} from "./IPermissionGuard.sol";

/// @title PasskeyAccount
/// @notice EIP-7702 delegate code for Trendr accounts, version 2. A user's EOA (whose key Mera
///         derives from the passkey's PRF output) delegates to this contract; afterwards:
///         - Owner actions (adding or revoking session keys, changing limits, withdrawals, any
///           call) are authorized by a WebAuthn signature from the passkey itself, verified with
///           Monad's P256 precompile at 0x0100 (EIP-7951) through Solady's WebAuthn verifier.
///         - Everyday trading is authorized by a session key that is capped by expiry, a daily
///           limit on the collateral (AUSD) its batches spend, and an allowlist of target contracts
///           and selectors, each of which may name a guard contract that checks the call's arguments.
///         - Calls are batched (for example approve plus trade), and anyone may submit them, so a
///           relayer pays the gas and the user never needs MON.
///         Replay protection: EIP-712 digests bind chain id and the account address, and every
///         signature consumes a nonce (one sequence for the owner, one per session key).
///         Delegated code cannot CREATE or CREATE2 on Monad and never does. Session calls cannot
///         send MON, which also respects Monad's 10 MON reserve rule for delegated accounts.
///         State lives in an ERC-7201 namespace so it cannot collide with other delegates, and the
///         entry points share a transient-storage reentrancy guard, which needs no setup.
///
///         Changes from version 1, whose accounts move here once with `upgrade`:
///         - The daily limit counts gross outflow: each call's decrease in the collateral balance,
///           never offset by what other calls in the batch bring in.
///         - A permission may name a guard (IPermissionGuard) that must approve each call it allows.
///         - Sessions that version 1 added are inactive here. Everything else (owner, owner nonce,
///           session nonces and revocations) is read from the same storage, and the signing domain
///           is unchanged: nonces only ever grow, so no version 1 signature can be replayed.
contract PasskeyAccount is ReentrancyGuardTransient {
    using SafeCast for uint256;

    /// @notice The version of this code, recorded on the account and on every session it adds.
    uint8 public constant VERSION = 2;

    struct Call {
        address target;
        uint256 value;
        bytes data;
    }

    /// @param recipientArg 1-based position of an address argument that must equal this account
    ///        (for example the `to` of a mint or buy), or 0 for none. It stops a session key from
    ///        routing proceeds elsewhere, which the collateral spend limit alone would not catch.
    /// @param guard An IPermissionGuard that must approve every call this permission allows, or zero.
    struct Permission {
        address target;
        bytes4 selector;
        uint8 recipientArg;
        address guard;
    }

    struct SessionConfig {
        address key;
        uint48 validUntil;
        uint128 dailyLimit;
        Permission[] permissions;
    }

    /// @notice A session as the views report it; `active` is false for sessions version 1 added.
    struct Session {
        uint48 validUntil;
        uint32 day;
        uint128 dailyLimit;
        uint128 spentToday;
        uint64 nonce;
        bool active;
    }

    /// @dev Version 1's Session layout plus the version that added the session (zero for version
    ///      1), which packs into the second slot after `active`.
    struct SessionState {
        uint48 validUntil;
        uint32 day;
        uint128 dailyLimit;
        uint128 spentToday;
        uint64 nonce;
        bool active;
        uint8 version;
    }

    /// @dev Version 1's layout with `version` appended. The namespace keeps its version 1 name.
    /// @custom:storage-location erc7201:trendr.passkey.account.v1
    struct AccountStorage {
        bytes32 ownerX;
        bytes32 ownerY;
        bool initialized;
        uint64 ownerNonce;
        mapping(address key => SessionState) sessions;
        mapping(address key => mapping(bytes32 permission => uint256 rule)) rules;
        mapping(address key => uint256) generation;
        uint8 version;
    }

    // keccak256(abi.encode(uint256(keccak256("trendr.passkey.account.v1")) - 1)) & ~bytes32(uint256(0xff))
    bytes32 private constant STORAGE_SLOT =
        0xf494ccf0ead24d9fb3bde1c1119c1f86a8412c77c25a08cce2525df5071a7100;

    bytes32 private constant DOMAIN_TYPEHASH =
        keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");
    bytes32 private constant NAME_HASH = keccak256("Trendr PasskeyAccount");
    bytes32 private constant VERSION_HASH = keccak256("1");
    bytes32 public constant INITIALIZE_TYPEHASH =
        keccak256("Initialize(bytes32 ownerX,bytes32 ownerY,bytes32 sessionHash,uint256 deadline)");
    bytes32 public constant UPGRADE_TYPEHASH = keccak256("Upgrade(bytes32 sessionsHash,uint256 deadline)");
    bytes32 public constant OWNER_EXECUTE_TYPEHASH =
        keccak256("OwnerExecute(bytes32 callsHash,uint256 nonce,uint256 deadline)");
    bytes32 public constant SESSION_EXECUTE_TYPEHASH =
        keccak256("SessionExecute(bytes32 callsHash,address sessionKey,uint256 nonce,uint256 deadline)");

    bytes4 private constant APPROVE_SELECTOR = 0x095ea7b3;
    /// @dev A stored rule is RULE_SET | guard << 8 | recipientArg. Version 1 stored recipientArg + 1,
    ///      which never has RULE_SET, so no rule version 1 wrote permits anything here.
    uint256 private constant RULE_SET = 1 << 255;

    /// @notice Collateral whose outflows count against session spend limits (AUSD).
    IERC20 public immutable collateral;

    event Initialized(bytes32 ownerX, bytes32 ownerY);
    event Upgraded(uint8 version);
    event SessionAdded(address indexed key, uint48 validUntil, uint128 dailyLimit, uint256 permissions);
    event SessionRevoked(address indexed key);
    event OwnerExecuted(uint256 nonce, uint256 calls);
    event SessionExecuted(address indexed key, uint256 nonce, uint256 calls, uint256 spent);

    error AlreadyInitialized();
    error AlreadyUpgraded();
    error NotInitialized();
    error OnlySelf();
    error Expired();
    error BadSignature();
    error SessionInactive();
    error SessionExpired();
    error CallNotAllowed(uint256 index);
    error ValueNotAllowed(uint256 index);
    error GuardRejected(uint256 index, bytes reason);
    error SpendLimitExceeded(uint256 spent, uint256 remaining);
    error AllowanceLeft(address token, address spender);
    error CallFailed(uint256 index, bytes reason);
    error ZeroAddress();

    constructor(IERC20 collateral_) {
        if (address(collateral_) == address(0)) revert ZeroAddress();
        collateral = collateral_;
    }

    receive() external payable {}

    // ---------------------------------------------------------------------------------------
    // Initialization and upgrade
    // ---------------------------------------------------------------------------------------

    /// @notice One-time setup, submitted by the relayer together with the EIP-7702 authorization.
    ///         Registers the passkey's P256 public key as owner and, optionally, the first session.
    /// @param eoaSignature EIP-712 `Initialize` signature from the account's own key, which proves
    ///        the account (and not a front-runner) chose this owner.
    function initialize(
        bytes32 ownerX,
        bytes32 ownerY,
        SessionConfig calldata session,
        uint256 deadline,
        bytes calldata eoaSignature
    ) external nonReentrant {
        AccountStorage storage $ = _storage();
        if ($.initialized) revert AlreadyInitialized();
        if (block.timestamp > deadline) revert Expired();
        bytes32 digest = _hashTyped(
            keccak256(abi.encode(INITIALIZE_TYPEHASH, ownerX, ownerY, _sessionHash(session), deadline))
        );
        if (ECDSA.recover(digest, eoaSignature) != address(this)) revert BadSignature();

        $.ownerX = ownerX;
        $.ownerY = ownerY;
        $.initialized = true;
        $.version = VERSION;
        emit Initialized(ownerX, ownerY);
        if (session.key != address(0)) _addSession(session);
    }

    /// @notice Moves a version 1 account to this version, once, submitted by the relayer together
    ///         with the EIP-7702 authorization that delegates the account here. The owner passkey
    ///         and every nonce stay; sessions version 1 added stay inactive, and `sessions` start.
    /// @param eoaSignature EIP-712 `Upgrade` signature from the account's own key.
    function upgrade(SessionConfig[] calldata sessions, uint256 deadline, bytes calldata eoaSignature)
        external
        nonReentrant
    {
        AccountStorage storage $ = _storage();
        if (!$.initialized) revert NotInitialized();
        if ($.version >= VERSION) revert AlreadyUpgraded();
        if (block.timestamp > deadline) revert Expired();
        bytes32 digest =
            _hashTyped(keccak256(abi.encode(UPGRADE_TYPEHASH, _sessionsHash(sessions), deadline)));
        if (ECDSA.recover(digest, eoaSignature) != address(this)) revert BadSignature();

        $.version = VERSION;
        emit Upgraded(VERSION);
        for (uint256 i; i < sessions.length; ++i) {
            _addSession(sessions[i]);
        }
    }

    // ---------------------------------------------------------------------------------------
    // Owner path (passkey)
    // ---------------------------------------------------------------------------------------

    /// @notice Executes `calls` authorized by a WebAuthn assertion from the owner passkey whose
    ///         challenge is the EIP-712 `OwnerExecute` digest.
    function executeAsOwner(Call[] calldata calls, uint256 deadline, WebAuthn.WebAuthnAuth calldata auth)
        external
        payable
        nonReentrant
    {
        AccountStorage storage $ = _storage();
        if (!$.initialized) revert NotInitialized();
        if (block.timestamp > deadline) revert Expired();
        uint256 nonce = $.ownerNonce++;
        bytes32 digest =
            _hashTyped(keccak256(abi.encode(OWNER_EXECUTE_TYPEHASH, _callsHash(calls), nonce, deadline)));
        if (!WebAuthn.verify(abi.encode(digest), true, auth, $.ownerX, $.ownerY)) revert BadSignature();

        for (uint256 i; i < calls.length; ++i) {
            _call(i, calls[i]);
        }
        emit OwnerExecuted(nonce, calls.length);
    }

    /// @notice Adds or replaces a session key. Only callable by the account itself (inside an
    ///         owner batch, or directly by the account's own key).
    function addSession(SessionConfig calldata session) external onlySelf {
        _addSession(session);
    }

    /// @notice Revokes a session key and its permissions immediately.
    function revokeSession(address key) external onlySelf {
        AccountStorage storage $ = _storage();
        $.sessions[key].active = false;
        ++$.generation[key];
        emit SessionRevoked(key);
    }

    // ---------------------------------------------------------------------------------------
    // Session path
    // ---------------------------------------------------------------------------------------

    // The spend limit measures the collateral balance around each call on purpose; nonReentrant blocks reentry.
    // slither-disable-start reentrancy-balance
    /// @notice Executes `calls` signed by an active session key, within its limits. Every call
    ///         must hit an allowed (target, selector) pair whose pinned recipient argument, if any,
    ///         is this account, or be an `approve` whose spender is an allowed target; the
    ///         permission's guard, if any, must approve the call right before it runs; no call may
    ///         send MON; each call's decrease in the collateral balance counts against the daily
    ///         limit, whatever other calls bring in; and every approval made in the batch must be
    ///         fully consumed.
    function executeWithSession(
        Call[] calldata calls,
        address sessionKey,
        uint256 deadline,
        bytes calldata signature
    ) external nonReentrant {
        AccountStorage storage $ = _storage();
        if (!$.initialized) revert NotInitialized();
        if (block.timestamp > deadline) revert Expired();
        SessionState storage s = $.sessions[sessionKey];
        if (!_isLive(s)) revert SessionInactive();
        if (block.timestamp > s.validUntil) revert SessionExpired();

        uint64 nonce = s.nonce++;
        bytes32 digest = _hashTyped(
            keccak256(abi.encode(SESSION_EXECUTE_TYPEHASH, _callsHash(calls), sessionKey, nonce, deadline))
        );
        if (ECDSA.recover(digest, signature) != sessionKey) revert BadSignature();

        uint256 generation = $.generation[sessionKey];
        address[] memory guards = new address[](calls.length);
        for (uint256 i; i < calls.length; ++i) {
            Call calldata c = calls[i];
            // A batch is all or nothing.
            // forge-lint: disable-next-line(require-revert-in-loop)
            if (c.value != 0) revert ValueNotAllowed(i);
            (bool allowed, address guard) = _permission(sessionKey, generation, c);
            // forge-lint: disable-next-line(require-revert-in-loop)
            if (!allowed) revert CallNotAllowed(i);
            guards[i] = guard;
        }

        uint256 balance = collateral.balanceOf(address(this));
        uint256 spent;
        for (uint256 i; i < calls.length; ++i) {
            if (guards[i] != address(0)) _checkGuard(i, guards[i], calls[i]);
            _call(i, calls[i]);
            // Reading the balance after every call is what makes the measure gross.
            // forge-lint: disable-next-line(calls-loop)
            uint256 balanceAfter = collateral.balanceOf(address(this));
            if (balanceAfter < balance) spent += balance - balanceAfter;
            balance = balanceAfter;
        }

        for (uint256 i; i < calls.length; ++i) {
            Call calldata c = calls[i];
            if (c.data.length >= 36 && bytes4(c.data[:4]) == APPROVE_SELECTOR) {
                address spender = address(uint160(uint256(bytes32(c.data[4:36]))));
                // Checking every approval the batch made is the point of this loop.
                // forge-lint: disable-next-line(calls-loop)
                if (IERC20(c.target).allowance(address(this), spender) != 0) {
                    // forge-lint: disable-next-line(require-revert-in-loop)
                    revert AllowanceLeft(c.target, spender);
                }
            }
        }

        uint32 today = _today();
        if (s.day != today) {
            s.day = today;
            s.spentToday = 0;
        }
        uint256 remaining = s.dailyLimit > s.spentToday ? s.dailyLimit - s.spentToday : 0;
        if (spent > remaining) revert SpendLimitExceeded(spent, remaining);
        s.spentToday += spent.toUint128();
        emit SessionExecuted(sessionKey, nonce, calls.length, spent);
    }
    // slither-disable-end reentrancy-balance

    // ---------------------------------------------------------------------------------------
    // Views
    // ---------------------------------------------------------------------------------------

    function owner() external view returns (bytes32 x, bytes32 y) {
        AccountStorage storage $ = _storage();
        return ($.ownerX, $.ownerY);
    }

    function isInitialized() external view returns (bool) {
        return _storage().initialized;
    }

    /// @notice The version of the code that initialized or last upgraded the account (zero for version 1).
    function accountVersion() external view returns (uint8) {
        return _storage().version;
    }

    function ownerNonce() external view returns (uint256) {
        return _storage().ownerNonce;
    }

    function sessionOf(address key) external view returns (Session memory) {
        SessionState storage s = _storage().sessions[key];
        return Session({
            validUntil: s.validUntil,
            day: s.day,
            dailyLimit: s.dailyLimit,
            spentToday: s.spentToday,
            nonce: s.nonce,
            active: _isLive(s)
        });
    }

    /// @notice Collateral the session key can still spend today.
    function remainingToday(address key) external view returns (uint256) {
        SessionState storage s = _storage().sessions[key];
        if (!_isLive(s) || block.timestamp > s.validUntil) return 0;
        if (s.day != _today()) return s.dailyLimit;
        return s.dailyLimit > s.spentToday ? s.dailyLimit - s.spentToday : 0;
    }

    function isPermitted(address key, address target, bytes4 selector) external view returns (bool) {
        AccountStorage storage $ = _storage();
        return $.rules[key][_permissionId($.generation[key], target, selector)] & RULE_SET != 0;
    }

    /// @notice The guard a session's permission names, or zero for none or no permission.
    function guardOf(address key, address target, bytes4 selector) external view returns (address) {
        AccountStorage storage $ = _storage();
        uint256 rule = $.rules[key][_permissionId($.generation[key], target, selector)];
        return rule & RULE_SET != 0 ? _guardOf(rule) : address(0);
    }

    function domainSeparator() public view returns (bytes32) {
        return keccak256(abi.encode(DOMAIN_TYPEHASH, NAME_HASH, VERSION_HASH, block.chainid, address(this)));
    }

    function ownerExecuteDigest(Call[] calldata calls, uint256 nonce, uint256 deadline)
        external
        view
        returns (bytes32)
    {
        return _hashTyped(keccak256(abi.encode(OWNER_EXECUTE_TYPEHASH, _callsHash(calls), nonce, deadline)));
    }

    function sessionExecuteDigest(Call[] calldata calls, address sessionKey, uint256 nonce, uint256 deadline)
        external
        view
        returns (bytes32)
    {
        return _hashTyped(
            keccak256(abi.encode(SESSION_EXECUTE_TYPEHASH, _callsHash(calls), sessionKey, nonce, deadline))
        );
    }

    function initializeDigest(
        bytes32 ownerX,
        bytes32 ownerY,
        SessionConfig calldata session,
        uint256 deadline
    ) external view returns (bytes32) {
        return _hashTyped(
            keccak256(abi.encode(INITIALIZE_TYPEHASH, ownerX, ownerY, _sessionHash(session), deadline))
        );
    }

    function upgradeDigest(SessionConfig[] calldata sessions, uint256 deadline)
        external
        view
        returns (bytes32)
    {
        return _hashTyped(keccak256(abi.encode(UPGRADE_TYPEHASH, _sessionsHash(sessions), deadline)));
    }

    // ---------------------------------------------------------------------------------------
    // Internals
    // ---------------------------------------------------------------------------------------

    modifier onlySelf() {
        if (msg.sender != address(this)) revert OnlySelf();
        _;
    }

    function _addSession(SessionConfig calldata session) internal {
        // `upgrade` adds sessions in a loop; a zero key fails the whole upgrade.
        // forge-lint: disable-next-line(require-revert-in-loop)
        if (session.key == address(0)) revert ZeroAddress();
        AccountStorage storage $ = _storage();
        uint256 generation = ++$.generation[session.key];
        SessionState storage s = $.sessions[session.key];
        s.validUntil = session.validUntil;
        s.dailyLimit = session.dailyLimit;
        s.active = true;
        s.version = VERSION;
        if (s.day != _today()) {
            s.day = _today();
            s.spentToday = 0;
        }
        for (uint256 i; i < session.permissions.length; ++i) {
            Permission calldata p = session.permissions[i];
            $.rules[session.key][_permissionId(generation, p.target, p.selector)] =
                RULE_SET | (uint256(uint160(p.guard)) << 8) | p.recipientArg;
        }
        emit SessionAdded(session.key, session.validUntil, session.dailyLimit, session.permissions.length);
    }

    /// @dev Active and added by this version: sessions version 1 added carry version 1's rules.
    function _isLive(SessionState storage s) internal view returns (bool) {
        return s.active && s.version == VERSION;
    }

    /// @dev Whether a session may make `c`, and the guard of the permission that allows it.
    function _permission(address key, uint256 generation, Call calldata c)
        internal
        view
        returns (bool allowed, address guard)
    {
        AccountStorage storage $ = _storage();
        if (c.data.length < 4) return (false, address(0));
        bytes4 selector = bytes4(c.data[:4]);
        uint256 rule = $.rules[key][_permissionId(generation, c.target, selector)];
        // The low byte of a rule is its recipient argument.
        // forge-lint: disable-next-line(unsafe-typecast)
        if (rule & RULE_SET != 0) return (_recipientIsSelf(c.data, uint8(rule)), _guardOf(rule));
        // Approvals of any token are allowed only towards allowlisted targets.
        if (selector == APPROVE_SELECTOR && c.data.length >= 36) {
            address spender = address(uint160(uint256(bytes32(c.data[4:36]))));
            rule = $.rules[key][_permissionId(generation, spender, bytes4(0))];
            if (rule & RULE_SET != 0) return (true, _guardOf(rule));
        }
        return (false, address(0));
    }

    function _guardOf(uint256 rule) internal pure returns (address) {
        // Truncating drops RULE_SET above the guard's 160 bits.
        // forge-lint: disable-next-line(unsafe-typecast)
        return address(uint160(rule >> 8));
    }

    /// @dev Runs the guard as a view (STATICCALL) and wraps its refusal with the call's index.
    function _checkGuard(uint256 index, address guard, Call calldata c) internal view {
        // forge-lint: disable-next-line(calls-loop)
        try IPermissionGuard(guard).check(address(this), c.target, c.data) returns (bytes4 answer) {
            // forge-lint: disable-next-line(require-revert-in-loop)
            if (answer != IPermissionGuard.check.selector) revert GuardRejected(index, "");
        } catch (bytes memory reason) {
            // forge-lint: disable-next-line(require-revert-in-loop)
            revert GuardRejected(index, reason);
        }
    }

    /// @dev Compares the whole ABI word, so dirty upper bits cannot smuggle in another address.
    function _recipientIsSelf(bytes calldata data, uint256 arg) internal view returns (bool) {
        if (arg == 0) return true;
        uint256 end = 4 + 32 * arg;
        if (data.length < end) return false;
        return bytes32(data[end - 32:end]) == bytes32(uint256(uint160(address(this))));
    }

    /// @dev Permission ids include the key's generation so revoking or replacing a session drops
    ///      every permission it had. Selector zero marks a target as an approved spender.
    function _permissionId(uint256 generation, address target, bytes4 selector)
        internal
        pure
        returns (bytes32)
    {
        return keccak256(abi.encode(generation, target, selector));
    }

    function _call(uint256 index, Call calldata c) internal {
        // Executing authorized batches is what an account does; session batches cannot carry value.
        // slither-disable-start arbitrary-send-eth
        // forge-lint: disable-next-line(arbitrary-send-eth, calls-loop)
        (bool ok, bytes memory ret) = c.target.call{value: c.value}(c.data);
        // slither-disable-end arbitrary-send-eth
        // forge-lint: disable-next-line(require-revert-in-loop)
        if (!ok) revert CallFailed(index, ret);
    }

    function _callsHash(Call[] calldata calls) internal pure returns (bytes32) {
        bytes32[] memory hashes = new bytes32[](calls.length);
        for (uint256 i; i < calls.length; ++i) {
            hashes[i] = keccak256(abi.encode(calls[i].target, calls[i].value, keccak256(calls[i].data)));
        }
        return keccak256(abi.encodePacked(hashes));
    }

    function _sessionHash(SessionConfig calldata s) internal pure returns (bytes32) {
        return keccak256(abi.encode(s.key, s.validUntil, s.dailyLimit, keccak256(abi.encode(s.permissions))));
    }

    /// @dev keccak256 over each session's hash, packed, as for calls.
    function _sessionsHash(SessionConfig[] calldata sessions) internal pure returns (bytes32) {
        bytes32[] memory hashes = new bytes32[](sessions.length);
        for (uint256 i; i < sessions.length; ++i) {
            hashes[i] = _sessionHash(sessions[i]);
        }
        return keccak256(abi.encodePacked(hashes));
    }

    function _hashTyped(bytes32 structHash) internal view returns (bytes32) {
        return keccak256(abi.encodePacked("\x19\x01", domainSeparator(), structHash));
    }

    function _today() internal view returns (uint32) {
        return (block.timestamp / 1 days).toUint32();
    }

    function _storage() private pure returns (AccountStorage storage $) {
        assembly {
            $.slot := STORAGE_SLOT
        }
    }
}
