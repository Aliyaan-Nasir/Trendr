// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {WebAuthn} from "solady/utils/WebAuthn.sol";

import {PasskeyAccount} from "../../src/account/PasskeyAccount.sol";
import {ITrendRegistry} from "../../src/interfaces/ITrendRegistry.sol";
import {PasskeyAccountV1} from "../legacy/PasskeyAccountV1.sol";
import {Fixture} from "../utils/Fixture.sol";
import {WebAuthnSigner} from "../utils/WebAuthnSigner.sol";

/// @notice A version 1 account moves to version 2 with one EIP-7702 re-delegation and `upgrade`:
///         owner, nonces, funds and revocations carry over through the shared storage, version 1
///         sessions do not, and nothing written by one version gives the other a permission.
contract PasskeyAccountUpgradeTest is Fixture {
    uint256 internal constant EOA_PK = 0xE0A;
    uint256 internal constant PASSKEY_PK = 0x9A55;
    uint256 internal constant SESSION_PK = 0x5E5;
    uint256 internal constant OTHER_SESSION_PK = 0x5E6;
    uint256 internal constant REVOKED_PK = 0x5E7;
    bytes32 internal constant STORAGE_SLOT =
        0xf494ccf0ead24d9fb3bde1c1119c1f86a8412c77c25a08cce2525df5071a7100;

    PasskeyAccountV1 internal v1;
    PasskeyAccount internal v2;
    address internal account;
    address internal session;
    address internal relayer = address(0x7E1A);
    bytes32 internal seriesId;

    function setUp() public override {
        super.setUp();
        v1 = new PasskeyAccountV1(IERC20(address(ausd)));
        v2 = new PasskeyAccount(IERC20(address(ausd)));
        account = vm.addr(EOA_PK);
        session = vm.addr(SESSION_PK);
        ausd.mint(account, 1000 * UNIT);
        createTrend("hantavirus", ITrendRegistry.AssetClass.Topic, 40 * POINT);
        seriesId = outcomes.openSeries("hantavirus", 1 days);

        // A version 1 account, as the app made them: delegate, initialize with a trading session.
        vm.signAndAttachDelegation(address(v1), EOA_PK);
        (bytes32 x, bytes32 y) = WebAuthnSigner.publicKey(PASSKEY_PK);
        PasskeyAccountV1.SessionConfig memory cfg = _v1Session(session);
        uint256 deadline = block.timestamp + 1 hours;
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(EOA_PK, _v1Account().initializeDigest(x, y, cfg, deadline));
        vm.prank(relayer);
        _v1Account().initialize(x, y, cfg, deadline, abi.encodePacked(r, s, v));
    }

    // --- helpers --------------------------------------------------------------------------

    function _v1Account() internal view returns (PasskeyAccountV1) {
        return PasskeyAccountV1(payable(account));
    }

    function _acct() internal view returns (PasskeyAccount) {
        return PasskeyAccount(payable(account));
    }

    function _v1Session(address key) internal view returns (PasskeyAccountV1.SessionConfig memory cfg) {
        PasskeyAccountV1.Permission[] memory perms = new PasskeyAccountV1.Permission[](3);
        perms[0] = PasskeyAccountV1.Permission(address(outcomes), outcomes.mint.selector, 3);
        perms[1] = PasskeyAccountV1.Permission(address(outcomes), outcomes.redeemSets.selector, 3);
        perms[2] = PasskeyAccountV1.Permission(address(outcomes), bytes4(0), 0);
        cfg = PasskeyAccountV1.SessionConfig({
            key: key,
            validUntil: uint48(block.timestamp + 7 days),
            dailyLimit: uint128(100 * UNIT),
            permissions: perms
        });
    }

    function _v2Session(address key) internal view returns (PasskeyAccount.SessionConfig memory cfg) {
        PasskeyAccount.Permission[] memory perms = new PasskeyAccount.Permission[](3);
        perms[0] = PasskeyAccount.Permission(address(outcomes), outcomes.mint.selector, 3, address(0));
        perms[1] = PasskeyAccount.Permission(address(outcomes), outcomes.redeemSets.selector, 3, address(0));
        perms[2] = PasskeyAccount.Permission(address(outcomes), bytes4(0), 0, address(0));
        cfg = PasskeyAccount.SessionConfig({
            key: key,
            validUntil: uint48(block.timestamp + 7 days),
            dailyLimit: uint128(100 * UNIT),
            permissions: perms
        });
    }

    function _mintCalls(uint256 amount) internal view returns (PasskeyAccount.Call[] memory calls) {
        calls = new PasskeyAccount.Call[](2);
        calls[0] = PasskeyAccount.Call(
            address(ausd), 0, abi.encodeCall(IERC20.approve, (address(outcomes), amount))
        );
        calls[1] = PasskeyAccount.Call(
            address(outcomes), 0, abi.encodeCall(outcomes.mint, (seriesId, amount, account))
        );
    }

    function _v1MintCalls(uint256 amount) internal view returns (PasskeyAccountV1.Call[] memory calls) {
        calls = new PasskeyAccountV1.Call[](2);
        calls[0] = PasskeyAccountV1.Call(
            address(ausd), 0, abi.encodeCall(IERC20.approve, (address(outcomes), amount))
        );
        calls[1] = PasskeyAccountV1.Call(
            address(outcomes), 0, abi.encodeCall(outcomes.mint, (seriesId, amount, account))
        );
    }

    function _v1SessionSign(PasskeyAccountV1.Call[] memory calls, uint256 pk, uint256 nonce)
        internal
        view
        returns (uint256 deadline, bytes memory signature)
    {
        deadline = block.timestamp + 10 minutes;
        (uint8 v, bytes32 r, bytes32 s) =
            vm.sign(pk, _v1Account().sessionExecuteDigest(calls, vm.addr(pk), nonce, deadline));
        signature = abi.encodePacked(r, s, v);
    }

    function _v1OwnerExec(PasskeyAccountV1.Call[] memory calls) internal {
        uint256 deadline = block.timestamp + 10 minutes;
        bytes32 digest = _v1Account().ownerExecuteDigest(calls, _v1Account().ownerNonce(), deadline);
        WebAuthn.WebAuthnAuth memory auth = WebAuthnSigner.sign(PASSKEY_PK, digest);
        vm.prank(relayer);
        _v1Account().executeAsOwner(calls, deadline, auth);
    }

    /// @dev The `Upgrade` digest, computed independently of the contract: the account still runs
    ///      version 1 when it is signed.
    function _upgradeDigest(PasskeyAccount.SessionConfig[] memory sessions, uint256 deadline)
        internal
        view
        returns (bytes32)
    {
        bytes32[] memory hashes = new bytes32[](sessions.length);
        for (uint256 i; i < sessions.length; ++i) {
            PasskeyAccount.SessionConfig memory c = sessions[i];
            hashes[i] = keccak256(
                abi.encode(c.key, c.validUntil, c.dailyLimit, keccak256(abi.encode(c.permissions)))
            );
        }
        bytes32 structHash = keccak256(
            abi.encode(
                keccak256("Upgrade(bytes32 sessionsHash,uint256 deadline)"),
                keccak256(abi.encodePacked(hashes)),
                deadline
            )
        );
        bytes32 domain = keccak256(
            abi.encode(
                keccak256(
                    "EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"
                ),
                keccak256("Trendr PasskeyAccount"),
                keccak256("1"),
                block.chainid,
                account
            )
        );
        return keccak256(abi.encodePacked("\x19\x01", domain, structHash));
    }

    /// @dev What the relayer submits: the EIP-7702 authorization to version 2 and `upgrade`, in one transaction.
    function _upgrade(PasskeyAccount.SessionConfig[] memory sessions) internal {
        uint256 deadline = block.timestamp + 10 minutes;
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(EOA_PK, _upgradeDigest(sessions, deadline));
        vm.signAndAttachDelegation(address(v2), EOA_PK);
        vm.prank(relayer);
        _acct().upgrade(sessions, deadline, abi.encodePacked(r, s, v));
    }

    function _one(PasskeyAccount.SessionConfig memory cfg)
        internal
        pure
        returns (PasskeyAccount.SessionConfig[] memory sessions)
    {
        sessions = new PasskeyAccount.SessionConfig[](1);
        sessions[0] = cfg;
    }

    function _sessionExec(PasskeyAccount.Call[] memory calls, uint256 pk) internal {
        uint256 deadline = block.timestamp + 10 minutes;
        address key = vm.addr(pk);
        (uint8 v, bytes32 r, bytes32 s) =
            vm.sign(pk, _acct().sessionExecuteDigest(calls, key, _acct().sessionOf(key).nonce, deadline));
        vm.prank(relayer);
        _acct().executeWithSession(calls, key, deadline, abi.encodePacked(r, s, v));
    }

    /// @dev Some version 1 history: two session trades, an owner withdrawal, a second session and a
    ///      revoked one.
    function _useVersion1() internal {
        (uint256 deadline, bytes memory sig) = _v1SessionSign(_v1MintCalls(30 * UNIT), SESSION_PK, 0);
        _v1Account().executeWithSession(_v1MintCalls(30 * UNIT), session, deadline, sig);
        (deadline, sig) = _v1SessionSign(_v1MintCalls(20 * UNIT), SESSION_PK, 1);
        _v1Account().executeWithSession(_v1MintCalls(20 * UNIT), session, deadline, sig);

        PasskeyAccountV1.Call[] memory calls = new PasskeyAccountV1.Call[](3);
        calls[0] = PasskeyAccountV1.Call(
            address(ausd), 0, abi.encodeCall(IERC20.transfer, (address(0xCAFE), 100 * UNIT))
        );
        calls[1] = PasskeyAccountV1.Call(
            account, 0, abi.encodeCall(PasskeyAccountV1.addSession, (_v1Session(vm.addr(OTHER_SESSION_PK))))
        );
        calls[2] = PasskeyAccountV1.Call(
            account, 0, abi.encodeCall(PasskeyAccountV1.addSession, (_v1Session(vm.addr(REVOKED_PK))))
        );
        _v1OwnerExec(calls);
        calls = new PasskeyAccountV1.Call[](1);
        calls[0] = PasskeyAccountV1.Call(
            account, 0, abi.encodeCall(PasskeyAccountV1.revokeSession, (vm.addr(REVOKED_PK)))
        );
        _v1OwnerExec(calls);
    }

    // --- the upgrade ----------------------------------------------------------------------

    function test_upgradeKeepsOwnerNoncesAndFunds() public {
        _useVersion1();
        (bytes32 x, bytes32 y) = _v1Account().owner();
        uint256 ausdBefore = ausd.balanceOf(account);
        uint256 upBefore = outcomes.seriesOf(seriesId).up.balanceOf(account);
        assertEq(_v1Account().ownerNonce(), 2);
        assertEq(_v1Account().sessionOf(session).nonce, 2);

        _upgrade(_one(_v2Session(session)));

        assertEq(account.code, abi.encodePacked(hex"ef0100", address(v2)));
        assertTrue(_acct().isInitialized());
        assertEq(_acct().accountVersion(), 2);
        (bytes32 x2, bytes32 y2) = _acct().owner();
        assertEq(x2, x);
        assertEq(y2, y);
        assertEq(_acct().ownerNonce(), 2, "owner nonce carries over");
        assertEq(ausd.balanceOf(account), ausdBefore);
        assertEq(outcomes.seriesOf(seriesId).up.balanceOf(account), upBefore);

        // The re-added session is live and continues its nonce sequence.
        PasskeyAccount.Session memory s = _acct().sessionOf(session);
        assertTrue(s.active);
        assertEq(s.nonce, 2, "session nonce carries over");
        _sessionExec(_mintCalls(10 * UNIT), SESSION_PK);
        assertEq(_acct().sessionOf(session).nonce, 3);

        // The passkey still owns the account.
        PasskeyAccount.Call[] memory calls = new PasskeyAccount.Call[](1);
        calls[0] = PasskeyAccount.Call(
            address(ausd), 0, abi.encodeCall(IERC20.transfer, (address(0xCAFE), 1 * UNIT))
        );
        uint256 deadline = block.timestamp + 10 minutes;
        WebAuthn.WebAuthnAuth memory auth =
            WebAuthnSigner.sign(PASSKEY_PK, _acct().ownerExecuteDigest(calls, 2, deadline));
        _acct().executeAsOwner(calls, deadline, auth);
        assertEq(ausd.balanceOf(address(0xCAFE)), 101 * UNIT);
    }

    /// @notice The signing domain is unchanged, so replay protection rests on the nonce carrying over.
    function test_versionOneSignaturesCannotReplay() public {
        (uint256 deadline, bytes memory sent) = _v1SessionSign(_v1MintCalls(5 * UNIT), SESSION_PK, 0);
        _v1Account().executeWithSession(_v1MintCalls(5 * UNIT), session, deadline, sent);

        _upgrade(_one(_v2Session(session)));
        // The same batch and signature (nonce 0) once more: the session is at nonce 1 now.
        vm.expectRevert(PasskeyAccount.BadSignature.selector);
        _acct().executeWithSession(_mintCalls(5 * UNIT), session, deadline, sent);
        // Owner assertions for an old nonce fail the same way.
        PasskeyAccount.Call[] memory calls = new PasskeyAccount.Call[](1);
        calls[0] =
            PasskeyAccount.Call(address(ausd), 0, abi.encodeCall(IERC20.transfer, (address(0xCAFE), 1)));
        WebAuthn.WebAuthnAuth memory auth =
            WebAuthnSigner.sign(PASSKEY_PK, _acct().ownerExecuteDigest(calls, 0, deadline));
        _acct().executeAsOwner(calls, deadline, auth);
        vm.expectRevert(PasskeyAccount.BadSignature.selector);
        _acct().executeAsOwner(calls, deadline, auth);
    }

    function test_versionOneSessionsDoNotCarryOver() public {
        _useVersion1();
        address other = vm.addr(OTHER_SESSION_PK);
        assertTrue(_v1Account().sessionOf(other).active);
        _upgrade(_one(_v2Session(session)));

        // Not re-added: inactive, nothing permitted, nothing to spend.
        PasskeyAccount.Session memory s = _acct().sessionOf(other);
        assertFalse(s.active);
        assertGt(s.validUntil, block.timestamp, "the version 1 record is still there");
        assertFalse(_acct().isPermitted(other, address(outcomes), outcomes.mint.selector));
        assertEq(_acct().remainingToday(other), 0);
        vm.expectRevert(PasskeyAccount.SessionInactive.selector);
        _acct().executeWithSession(_mintCalls(1 * UNIT), other, block.timestamp + 1, "");

        // A revoked key stays revoked: a record that is not active.
        PasskeyAccount.Session memory revoked = _acct().sessionOf(vm.addr(REVOKED_PK));
        assertFalse(revoked.active);
        assertGt(revoked.validUntil, 0);
    }

    function test_upgradeWithoutSessionsLeavesNoneActive() public {
        _upgrade(new PasskeyAccount.SessionConfig[](0));
        assertEq(_acct().accountVersion(), 2);
        assertFalse(_acct().sessionOf(session).active);
        vm.expectRevert(PasskeyAccount.SessionInactive.selector);
        _acct().executeWithSession(_mintCalls(1 * UNIT), session, block.timestamp + 1, "");
        // The owner can add one later.
        PasskeyAccount.Call[] memory calls = new PasskeyAccount.Call[](1);
        calls[0] =
            PasskeyAccount.Call(account, 0, abi.encodeCall(PasskeyAccount.addSession, (_v2Session(session))));
        uint256 deadline = block.timestamp + 10 minutes;
        WebAuthn.WebAuthnAuth memory auth =
            WebAuthnSigner.sign(PASSKEY_PK, _acct().ownerExecuteDigest(calls, 0, deadline));
        _acct().executeAsOwner(calls, deadline, auth);
        _sessionExec(_mintCalls(1 * UNIT), SESSION_PK);
    }

    function test_upgradeAppliesGrossLimitToTheNewSession() public {
        _upgrade(_one(_v2Session(session)));
        _sessionExec(_mintCalls(60 * UNIT), SESSION_PK);
        PasskeyAccount.Call[] memory calls = new PasskeyAccount.Call[](3);
        calls[0] = PasskeyAccount.Call(
            address(outcomes), 0, abi.encodeCall(outcomes.redeemSets, (seriesId, 60 * UNIT, account))
        );
        PasskeyAccount.Call[] memory mint = _mintCalls(60 * UNIT);
        calls[1] = mint[0];
        calls[2] = mint[1];
        uint256 deadline = block.timestamp + 10 minutes;
        (uint8 v, bytes32 r, bytes32 s) =
            vm.sign(SESSION_PK, _acct().sessionExecuteDigest(calls, session, 1, deadline));
        vm.expectRevert(
            abi.encodeWithSelector(PasskeyAccount.SpendLimitExceeded.selector, 60 * UNIT, 40 * UNIT)
        );
        _acct().executeWithSession(calls, session, deadline, abi.encodePacked(r, s, v));
    }

    // --- who may upgrade, and when --------------------------------------------------------

    function test_upgradeOnlyOnce() public {
        PasskeyAccount.SessionConfig[] memory sessions = _one(_v2Session(session));
        _upgrade(sessions);
        uint256 deadline = block.timestamp + 10 minutes;
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(EOA_PK, _acct().upgradeDigest(sessions, deadline));
        vm.expectRevert(PasskeyAccount.AlreadyUpgraded.selector);
        _acct().upgrade(sessions, deadline, abi.encodePacked(r, s, v));
    }

    function test_upgradeNeedsTheAccountKeyOverTheseSessions() public {
        PasskeyAccount.SessionConfig[] memory sessions = _one(_v2Session(session));
        uint256 deadline = block.timestamp + 10 minutes;
        vm.signAndAttachDelegation(address(v2), EOA_PK);
        (bool ok,) = account.call("");
        assertTrue(ok);

        (uint8 v, bytes32 r, bytes32 s) = vm.sign(0xBAD, _acct().upgradeDigest(sessions, deadline));
        vm.expectRevert(PasskeyAccount.BadSignature.selector);
        _acct().upgrade(sessions, deadline, abi.encodePacked(r, s, v));

        // Signed for other sessions (a front-runner swapping in its own key).
        (v, r, s) = vm.sign(EOA_PK, _acct().upgradeDigest(sessions, deadline));
        PasskeyAccount.SessionConfig[] memory swapped = _one(_v2Session(vm.addr(0xBAD)));
        vm.expectRevert(PasskeyAccount.BadSignature.selector);
        _acct().upgrade(swapped, deadline, abi.encodePacked(r, s, v));

        vm.warp(deadline + 1);
        vm.expectRevert(PasskeyAccount.Expired.selector);
        _acct().upgrade(sessions, deadline, abi.encodePacked(r, s, v));
    }

    function test_newAndUninitializedAccountsCannotUpgrade() public {
        uint256 freshPk = 0xF2E5;
        address fresh = vm.addr(freshPk);
        vm.signAndAttachDelegation(address(v2), freshPk);
        (bool ok,) = fresh.call("");
        assertTrue(ok);
        PasskeyAccount.SessionConfig[] memory sessions = new PasskeyAccount.SessionConfig[](0);
        vm.expectRevert(PasskeyAccount.NotInitialized.selector);
        PasskeyAccount(payable(fresh)).upgrade(sessions, block.timestamp + 1, "");

        // Initialized under version 2: already current.
        PasskeyAccount.SessionConfig memory cfg = _v2Session(session);
        (bytes32 x, bytes32 y) = WebAuthnSigner.publicKey(PASSKEY_PK);
        uint256 deadline = block.timestamp + 10 minutes;
        (uint8 v, bytes32 r, bytes32 s) =
            vm.sign(freshPk, PasskeyAccount(payable(fresh)).initializeDigest(x, y, cfg, deadline));
        PasskeyAccount(payable(fresh)).initialize(x, y, cfg, deadline, abi.encodePacked(r, s, v));
        assertEq(PasskeyAccount(payable(fresh)).accountVersion(), 2);
        (v, r, s) = vm.sign(freshPk, PasskeyAccount(payable(fresh)).upgradeDigest(sessions, deadline));
        vm.expectRevert(PasskeyAccount.AlreadyUpgraded.selector);
        PasskeyAccount(payable(fresh)).upgrade(sessions, deadline, abi.encodePacked(r, s, v));
    }

    // --- storage --------------------------------------------------------------------------

    /// @notice The raw slots version 1 wrote are the slots version 2 reads, field by field.
    function test_storageLayoutIsShared() public {
        _useVersion1();
        bytes32 base = STORAGE_SLOT;
        (bytes32 x, bytes32 y) = WebAuthnSigner.publicKey(PASSKEY_PK);
        assertEq(vm.load(account, base), x);
        assertEq(vm.load(account, bytes32(uint256(base) + 1)), y);
        // initialized (byte 0) and ownerNonce (bytes 1 to 8) share a slot.
        assertEq(uint256(vm.load(account, bytes32(uint256(base) + 2))), 1 | (2 << 8));
        // sessions[session]: slot 0 is validUntil | day | dailyLimit, slot 1 spentToday | nonce | active.
        bytes32 sessionSlot = keccak256(abi.encode(session, uint256(base) + 3));
        PasskeyAccountV1.Session memory s1 = _v1Account().sessionOf(session);
        assertEq(
            uint256(vm.load(account, sessionSlot)),
            uint256(s1.validUntil) | (uint256(s1.day) << 48) | (uint256(s1.dailyLimit) << 80)
        );
        assertEq(
            uint256(vm.load(account, bytes32(uint256(sessionSlot) + 1))),
            uint256(s1.spentToday) | (uint256(s1.nonce) << 128) | (1 << 192)
        );
        // Version 1 never wrote past generation; version 2's account version is the next slot.
        assertEq(vm.load(account, bytes32(uint256(base) + 6)), bytes32(0));

        _upgrade(_one(_v2Session(session)));
        assertEq(vm.load(account, bytes32(uint256(base) + 6)), bytes32(uint256(2)));
        // The session's version lands in byte 25 of its second slot, next to `active`.
        uint256 second = uint256(vm.load(account, bytes32(uint256(sessionSlot) + 1)));
        assertEq((second >> 192) & 0xff, 1, "active");
        assertEq((second >> 200) & 0xff, 2, "version");
        assertEq(uint64(second >> 128), s1.nonce, "nonce");
        // The other session's record has no version, and reads as inactive.
        bytes32 otherSlot = keccak256(abi.encode(vm.addr(OTHER_SESSION_PK), uint256(base) + 3));
        assertEq((uint256(vm.load(account, bytes32(uint256(otherSlot) + 1))) >> 200) & 0xff, 0);
        assertFalse(_acct().sessionOf(vm.addr(OTHER_SESSION_PK)).active);
    }

    /// @notice Neither version can use the other's rules: going back to version 1 with the account key
    ///         and forward again revives nothing.
    function test_rulesDoNotCrossVersions() public {
        _upgrade(_one(_v2Session(session)));
        // Back to version 1 (only the account key can sign this): version 2's rules are unusable there.
        vm.signAndAttachDelegation(address(v1), EOA_PK);
        (bool ok,) = account.call("");
        assertTrue(ok);
        assertTrue(_v1Account().sessionOf(session).active);
        (uint256 deadline, bytes memory sig) =
            _v1SessionSign(_v1MintCalls(1 * UNIT), SESSION_PK, _v1Account().sessionOf(session).nonce);
        // Version 1 reads a tagged rule as an absurd recipient position and reverts.
        vm.expectRevert();
        _v1Account().executeWithSession(_v1MintCalls(1 * UNIT), session, deadline, sig);

        // Version 1 adds a session there, then the account returns to version 2 without upgrading
        // (it already did): the version 1 session and its rules give nothing.
        address late = vm.addr(OTHER_SESSION_PK);
        vm.prank(account);
        _v1Account().addSession(_v1Session(late));
        vm.signAndAttachDelegation(address(v2), EOA_PK);
        (ok,) = account.call("");
        assertTrue(ok);
        assertFalse(_acct().sessionOf(late).active);
        assertFalse(_acct().isPermitted(late, address(outcomes), outcomes.mint.selector));
        vm.expectRevert(PasskeyAccount.SessionInactive.selector);
        _acct().executeWithSession(_mintCalls(1 * UNIT), late, block.timestamp + 1, "");
    }

    /// @notice A version 2 session that version 1 code re-added (after a trip back with the account key)
    ///         keeps its version mark but only version 1's untagged rules, which permit nothing.
    function test_versionOneRulesNeverPermit() public {
        _upgrade(_one(_v2Session(session)));
        vm.signAndAttachDelegation(address(v1), EOA_PK);
        (bool ok,) = account.call("");
        assertTrue(ok);
        PasskeyAccountV1.Permission[] memory perms = new PasskeyAccountV1.Permission[](2);
        // Pins the second argument: read one position off, it would pin mint's recipient instead.
        perms[0] = PasskeyAccountV1.Permission(address(outcomes), outcomes.mint.selector, 2);
        perms[1] = PasskeyAccountV1.Permission(address(outcomes), bytes4(0), 0);
        PasskeyAccountV1.SessionConfig memory cfg = _v1Session(session);
        cfg.permissions = perms;
        vm.prank(account);
        _v1Account().addSession(cfg);
        vm.signAndAttachDelegation(address(v2), EOA_PK);
        (ok,) = account.call("");
        assertTrue(ok);

        assertTrue(_acct().sessionOf(session).active, "the version mark survived");
        PasskeyAccount.Call[] memory calls = _mintCalls(1 * UNIT);
        uint256 deadline = block.timestamp + 10 minutes;
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(
            SESSION_PK,
            _acct().sessionExecuteDigest(calls, session, _acct().sessionOf(session).nonce, deadline)
        );
        vm.expectRevert(abi.encodeWithSelector(PasskeyAccount.CallNotAllowed.selector, 0));
        _acct().executeWithSession(calls, session, deadline, abi.encodePacked(r, s, v));
        // Without the approval, the mint alone is not permitted either.
        PasskeyAccount.Call[] memory mintOnly = new PasskeyAccount.Call[](1);
        mintOnly[0] = calls[1];
        (v, r, s) = vm.sign(
            SESSION_PK,
            _acct().sessionExecuteDigest(mintOnly, session, _acct().sessionOf(session).nonce, deadline)
        );
        vm.expectRevert(abi.encodeWithSelector(PasskeyAccount.CallNotAllowed.selector, 0));
        _acct().executeWithSession(mintOnly, session, deadline, abi.encodePacked(r, s, v));
    }

    function testFuzz_upgradeCarriesNonces(uint8 ownerActions, uint8 trades) public {
        ownerActions = uint8(bound(ownerActions, 0, 5));
        trades = uint8(bound(trades, 0, 5));
        for (uint256 i; i < trades; ++i) {
            (uint256 deadline, bytes memory sig) = _v1SessionSign(_v1MintCalls(1 * UNIT), SESSION_PK, i);
            _v1Account().executeWithSession(_v1MintCalls(1 * UNIT), session, deadline, sig);
        }
        for (uint256 i; i < ownerActions; ++i) {
            PasskeyAccountV1.Call[] memory calls = new PasskeyAccountV1.Call[](1);
            calls[0] = PasskeyAccountV1.Call(
                address(ausd), 0, abi.encodeCall(IERC20.transfer, (address(0xCAFE), 1))
            );
            _v1OwnerExec(calls);
        }
        _upgrade(_one(_v2Session(session)));
        assertEq(_acct().ownerNonce(), ownerActions);
        assertEq(_acct().sessionOf(session).nonce, trades);
        assertEq(ausd.balanceOf(account), 1000 * UNIT - trades * UNIT - ownerActions);
    }
}
