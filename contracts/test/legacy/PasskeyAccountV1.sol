// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ReentrancyGuardTransient} from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";
import {WebAuthn} from "solady/utils/WebAuthn.sol";

/// @title PasskeyAccountV1
/// @notice Version 1 of PasskeyAccount, as deployed on Monad Testnet before version 2, kept unchanged
///         (apart from its name) so tests can create version 1 accounts and upgrade them.
///
///         EIP-7702 delegate code for Trendr accounts. A user's EOA (whose key Mera derives from the
///         passkey's PRF output) delegates to this contract once; afterwards:
///         - Owner actions (adding or revoking session keys, changing limits, withdrawals, any
///           call) are authorized by a WebAuthn signature from the passkey itself, verified with
///           Monad's P256 precompile at 0x0100 (EIP-7951) through Solady's WebAuthn verifier.
///         - Everyday trading is authorized by a session key that is capped by expiry, a daily
///           collateral (AUSD) spend limit and an allowlist of target contracts and selectors.
///         - Calls are batched (for example approve plus trade), and anyone may submit them, so a
///           relayer pays the gas and the user never needs MON.
///         Replay protection: EIP-712 digests bind chain id and the account address, and every
///         signature consumes a nonce (one sequence for the owner, one per session key).
///         Delegated code cannot CREATE or CREATE2 on Monad and never does. Session calls cannot
///         send MON, which also respects Monad's 10 MON reserve rule for delegated accounts.
///         State lives in an ERC-7201 namespace so it cannot collide with other delegates, and the
///         entry points share a transient-storage reentrancy guard, which needs no setup.
contract PasskeyAccountV1 is ReentrancyGuardTransient {
    using SafeCast for uint256;

    struct Call {
        address target;
        uint256 value;
        bytes data;
    }

    /// @param recipientArg 1-based position of an address argument that must equal this account
    ///        (for example the `to` of a mint or buy), or 0 for none. It stops a session key from
    ///        routing proceeds elsewhere, which the collateral spend limit alone would not catch.
    struct Permission {
        address target;
        bytes4 selector;
        uint8 recipientArg;
    }

    struct SessionConfig {
        address key;
        uint48 validUntil;
        uint128 dailyLimit;
        Permission[] permissions;
    }

    struct Session {
        uint48 validUntil;
        uint32 day;
        uint128 dailyLimit;
        uint128 spentToday;
        uint64 nonce;
        bool active;
    }

    /// @custom:storage-location erc7201:trendr.passkey.account.v1
    struct AccountStorage {
        bytes32 ownerX;
        bytes32 ownerY;
        bool initialized;
        uint64 ownerNonce;
        mapping(address key => Session) sessions;
        mapping(address key => mapping(bytes32 permission => uint256 rule)) rules;
        mapping(address key => uint256) generation;
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
    bytes32 public constant OWNER_EXECUTE_TYPEHASH =
        keccak256("OwnerExecute(bytes32 callsHash,uint256 nonce,uint256 deadline)");
    bytes32 public constant SESSION_EXECUTE_TYPEHASH =
        keccak256("SessionExecute(bytes32 callsHash,address sessionKey,uint256 nonce,uint256 deadline)");

    bytes4 private constant APPROVE_SELECTOR = 0x095ea7b3;

    /// @notice Collateral whose outflows count against session spend limits (AUSD).
    IERC20 public immutable collateral;

    event Initialized(bytes32 ownerX, bytes32 ownerY);
    event SessionAdded(address indexed key, uint48 validUntil, uint128 dailyLimit, uint256 permissions);
    event SessionRevoked(address indexed key);
    event OwnerExecuted(uint256 nonce, uint256 calls);
    event SessionExecuted(address indexed key, uint256 nonce, uint256 calls, uint256 spent);

    error AlreadyInitialized();
    error NotInitialized();
    error OnlySelf();
    error Expired();
    error BadSignature();
    error SessionInactive();
    error SessionExpired();
    error CallNotAllowed(uint256 index);
    error ValueNotAllowed(uint256 index);
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
    // Initialization
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
        emit Initialized(ownerX, ownerY);
        if (session.key != address(0)) _addSession(session);
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

    // The spend limit measures the collateral balance around the batch on purpose; nonReentrant blocks reentry.
    // slither-disable-start reentrancy-balance
    /// @notice Executes `calls` signed by an active session key, within its limits. Every call
    ///         must hit an allowed (target, selector) pair whose pinned recipient argument, if any,
    ///         is this account, or be an `approve` whose spender is an allowed target; no call may
    ///         send MON; collateral leaving the account counts against the daily limit; and every
    ///         approval made in the batch must be fully consumed.
    function executeWithSession(
        Call[] calldata calls,
        address sessionKey,
        uint256 deadline,
        bytes calldata signature
    ) external nonReentrant {
        AccountStorage storage $ = _storage();
        if (!$.initialized) revert NotInitialized();
        if (block.timestamp > deadline) revert Expired();
        Session storage s = $.sessions[sessionKey];
        if (!s.active) revert SessionInactive();
        if (block.timestamp > s.validUntil) revert SessionExpired();

        uint64 nonce = s.nonce++;
        bytes32 digest = _hashTyped(
            keccak256(abi.encode(SESSION_EXECUTE_TYPEHASH, _callsHash(calls), sessionKey, nonce, deadline))
        );
        if (ECDSA.recover(digest, signature) != sessionKey) revert BadSignature();

        uint256 generation = $.generation[sessionKey];
        for (uint256 i; i < calls.length; ++i) {
            Call calldata c = calls[i];
            // A batch is all or nothing.
            // forge-lint: disable-next-line(require-revert-in-loop)
            if (c.value != 0) revert ValueNotAllowed(i);
            // forge-lint: disable-next-line(require-revert-in-loop)
            if (!_isAllowed(sessionKey, generation, c)) revert CallNotAllowed(i);
        }

        uint256 balanceBefore = collateral.balanceOf(address(this));
        for (uint256 i; i < calls.length; ++i) {
            _call(i, calls[i]);
        }
        uint256 balanceAfter = collateral.balanceOf(address(this));

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

        uint256 spent = balanceBefore > balanceAfter ? balanceBefore - balanceAfter : 0;
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

    function ownerNonce() external view returns (uint256) {
        return _storage().ownerNonce;
    }

    function sessionOf(address key) external view returns (Session memory) {
        return _storage().sessions[key];
    }

    /// @notice Collateral the session key can still spend today.
    function remainingToday(address key) external view returns (uint256) {
        Session storage s = _storage().sessions[key];
        if (!s.active || block.timestamp > s.validUntil) return 0;
        if (s.day != _today()) return s.dailyLimit;
        return s.dailyLimit > s.spentToday ? s.dailyLimit - s.spentToday : 0;
    }

    function isPermitted(address key, address target, bytes4 selector) external view returns (bool) {
        AccountStorage storage $ = _storage();
        return $.rules[key][_permissionId($.generation[key], target, selector)] != 0;
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

    // ---------------------------------------------------------------------------------------
    // Internals
    // ---------------------------------------------------------------------------------------

    modifier onlySelf() {
        if (msg.sender != address(this)) revert OnlySelf();
        _;
    }

    function _addSession(SessionConfig calldata session) internal {
        if (session.key == address(0)) revert ZeroAddress();
        AccountStorage storage $ = _storage();
        uint256 generation = ++$.generation[session.key];
        Session storage s = $.sessions[session.key];
        s.validUntil = session.validUntil;
        s.dailyLimit = session.dailyLimit;
        s.active = true;
        if (s.day != _today()) {
            s.day = _today();
            s.spentToday = 0;
        }
        for (uint256 i; i < session.permissions.length; ++i) {
            Permission calldata p = session.permissions[i];
            $.rules[session.key][_permissionId(generation, p.target, p.selector)] =
                uint256(p.recipientArg) + 1;
        }
        emit SessionAdded(session.key, session.validUntil, session.dailyLimit, session.permissions.length);
    }

    function _isAllowed(address key, uint256 generation, Call calldata c) internal view returns (bool) {
        AccountStorage storage $ = _storage();
        if (c.data.length < 4) return false;
        bytes4 selector = bytes4(c.data[:4]);
        uint256 rule = $.rules[key][_permissionId(generation, c.target, selector)];
        if (rule != 0) return _recipientIsSelf(c.data, rule - 1);
        // Approvals of any token are allowed only towards allowlisted targets.
        if (selector == APPROVE_SELECTOR && c.data.length >= 36) {
            address spender = address(uint160(uint256(bytes32(c.data[4:36]))));
            return $.rules[key][_permissionId(generation, spender, bytes4(0))] != 0;
        }
        return false;
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
