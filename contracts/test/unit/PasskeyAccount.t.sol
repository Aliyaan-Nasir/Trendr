// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ReentrancyGuardTransient} from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";
import {WebAuthn} from "solady/utils/WebAuthn.sol";

import {IPermissionGuard} from "../../src/account/IPermissionGuard.sol";
import {PasskeyAccount} from "../../src/account/PasskeyAccount.sol";
import {ITrendRegistry} from "../../src/interfaces/ITrendRegistry.sol";
import {Fixture} from "../utils/Fixture.sol";
import {WebAuthnSigner} from "../utils/WebAuthnSigner.sol";

/// @notice An allowlisted target that calls back into the account.
contract Reenterer {
    function poke(address account, bytes calldata data) external {
        (bool ok, bytes memory ret) = account.call(data);
        if (!ok) {
            assembly {
                revert(add(ret, 32), mload(ret))
            }
        }
    }
}

/// @notice A guard that approves calls up to a ceiling on their amount argument and records nothing.
contract CeilingGuard is IPermissionGuard {
    uint256 public ceiling;
    bytes4 public answer = IPermissionGuard.check.selector;

    error AboveCeiling(uint256 amount);

    function set(uint256 ceiling_, bytes4 answer_) external {
        ceiling = ceiling_;
        answer = answer_;
    }

    /// @dev Reads mint(seriesId, amount, to)'s amount; the account and target are checked by the test.
    function check(address, address, bytes calldata data) external view returns (bytes4) {
        (, uint256 amount,) = abi.decode(data[4:], (bytes32, uint256, address));
        if (amount > ceiling) revert AboveCeiling(amount);
        return answer;
    }
}

/// @notice A guard that tries to write state, which the account's STATICCALL forbids. It does not
///         declare IPermissionGuard, whose `check` is a view.
contract WritingGuard {
    uint256 public calls;

    function check(address, address, bytes calldata) external returns (bytes4) {
        ++calls;
        return IPermissionGuard.check.selector;
    }
}

contract PasskeyAccountTest is Fixture {
    uint256 internal constant EOA_PK = 0xE0A;
    uint256 internal constant PASSKEY_PK = 0x9A55;
    uint256 internal constant OTHER_PASSKEY_PK = 0xBEEF;
    uint256 internal constant SESSION_PK = 0x5E5;

    PasskeyAccount internal impl;
    address internal account;
    address internal session;
    address internal relayer = address(0x7E1A);
    address internal receiver = address(0xDEAD1);
    bytes32 internal trend;
    bytes32 internal seriesId;

    function setUp() public override {
        super.setUp();
        impl = new PasskeyAccount(IERC20(address(ausd)));
        account = vm.addr(EOA_PK);
        session = vm.addr(SESSION_PK);
        vm.signAndAttachDelegation(address(impl), EOA_PK);
        // The delegation lands with the next call; make a no-op call so the code is installed.
        (bool ok,) = account.call("");
        assertTrue(ok);
        ausd.mint(account, 1000 * UNIT);
        trend = createTrend("hantavirus", ITrendRegistry.AssetClass.Topic, 40 * POINT);
        seriesId = outcomes.openSeries("hantavirus", 1 days);
    }

    function acct() internal view returns (PasskeyAccount) {
        return PasskeyAccount(payable(account));
    }

    // --- helpers --------------------------------------------------------------------------

    function _tradingSession(uint48 validUntil, uint128 dailyLimit)
        internal
        view
        returns (PasskeyAccount.SessionConfig memory cfg)
    {
        PasskeyAccount.Permission[] memory perms = new PasskeyAccount.Permission[](2);
        perms[0] = PasskeyAccount.Permission({
            target: address(outcomes), selector: outcomes.mint.selector, recipientArg: 3, guard: address(0)
        });
        perms[1] = PasskeyAccount.Permission({
            target: address(outcomes), selector: bytes4(0), recipientArg: 0, guard: address(0)
        }); // approved spender
        cfg = PasskeyAccount.SessionConfig({
            key: session, validUntil: validUntil, dailyLimit: dailyLimit, permissions: perms
        });
    }

    function _initialize(PasskeyAccount.SessionConfig memory cfg) internal {
        (bytes32 x, bytes32 y) = WebAuthnSigner.publicKey(PASSKEY_PK);
        uint256 deadline = block.timestamp + 1 hours;
        bytes32 digest = acct().initializeDigest(x, y, cfg, deadline);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(EOA_PK, digest);
        vm.prank(relayer);
        acct().initialize(x, y, cfg, deadline, abi.encodePacked(r, s, v));
    }

    function _emptySession() internal pure returns (PasskeyAccount.SessionConfig memory cfg) {
        cfg.permissions = new PasskeyAccount.Permission[](0);
    }

    function _ownerExec(PasskeyAccount.Call[] memory calls, uint256 pk) internal {
        uint256 deadline = block.timestamp + 10 minutes;
        bytes32 digest = acct().ownerExecuteDigest(calls, acct().ownerNonce(), deadline);
        WebAuthn.WebAuthnAuth memory auth = WebAuthnSigner.sign(pk, digest);
        vm.prank(relayer);
        acct().executeAsOwner(calls, deadline, auth);
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

    function _sessionExec(PasskeyAccount.Call[] memory calls, uint256 pk) internal {
        uint256 deadline = block.timestamp + 10 minutes;
        bytes32 digest =
            acct().sessionExecuteDigest(calls, session, acct().sessionOf(session).nonce, deadline);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, digest);
        vm.prank(relayer);
        acct().executeWithSession(calls, session, deadline, abi.encodePacked(r, s, v));
    }

    function _transferCall(uint256 amount) internal view returns (PasskeyAccount.Call[] memory calls) {
        calls = new PasskeyAccount.Call[](1);
        calls[0] = PasskeyAccount.Call(address(ausd), 0, abi.encodeCall(IERC20.transfer, (receiver, amount)));
    }

    // --- initialization -------------------------------------------------------------------

    function test_delegationInstalled() public view {
        assertEq(account.code, abi.encodePacked(hex"ef0100", address(impl)));
    }

    function test_initialize() public {
        _initialize(_tradingSession(uint48(block.timestamp + 1 days), uint128(100 * UNIT)));
        assertTrue(acct().isInitialized());
        (bytes32 x, bytes32 y) = acct().owner();
        (bytes32 ex, bytes32 ey) = WebAuthnSigner.publicKey(PASSKEY_PK);
        assertEq(x, ex);
        assertEq(y, ey);
        assertTrue(acct().sessionOf(session).active);
        assertEq(acct().remainingToday(session), 100 * UNIT);
    }

    function test_initializeOnlyOnceAndOnlyByAccountKey() public {
        PasskeyAccount.SessionConfig memory cfg = _emptySession();
        (bytes32 x, bytes32 y) = WebAuthnSigner.publicKey(OTHER_PASSKEY_PK);
        uint256 deadline = block.timestamp + 1 hours;
        bytes32 digest = acct().initializeDigest(x, y, cfg, deadline);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(0xBAD, digest);
        vm.expectRevert(PasskeyAccount.BadSignature.selector);
        acct().initialize(x, y, cfg, deadline, abi.encodePacked(r, s, v));

        _initialize(cfg);
        (v, r, s) = vm.sign(EOA_PK, digest);
        vm.expectRevert(PasskeyAccount.AlreadyInitialized.selector);
        acct().initialize(x, y, cfg, deadline, abi.encodePacked(r, s, v));
    }

    // --- owner path -----------------------------------------------------------------------

    function test_ownerWithdrawsWithPasskey() public {
        _initialize(_emptySession());
        _ownerExec(_transferCall(250 * UNIT), PASSKEY_PK);
        assertEq(ausd.balanceOf(receiver), 250 * UNIT);
        assertEq(acct().ownerNonce(), 1);
    }

    function test_ownerRejectsWrongPasskey() public {
        _initialize(_emptySession());
        PasskeyAccount.Call[] memory calls = _transferCall(1);
        uint256 deadline = block.timestamp + 10 minutes;
        bytes32 digest = acct().ownerExecuteDigest(calls, 0, deadline);
        WebAuthn.WebAuthnAuth memory auth = WebAuthnSigner.sign(OTHER_PASSKEY_PK, digest);
        vm.expectRevert(PasskeyAccount.BadSignature.selector);
        acct().executeAsOwner(calls, deadline, auth);
    }

    function test_ownerRejectsReplay() public {
        _initialize(_emptySession());
        PasskeyAccount.Call[] memory calls = _transferCall(10 * UNIT);
        uint256 deadline = block.timestamp + 10 minutes;
        bytes32 digest = acct().ownerExecuteDigest(calls, 0, deadline);
        WebAuthn.WebAuthnAuth memory auth = WebAuthnSigner.sign(PASSKEY_PK, digest);
        acct().executeAsOwner(calls, deadline, auth);
        vm.expectRevert(PasskeyAccount.BadSignature.selector);
        acct().executeAsOwner(calls, deadline, auth);
        assertEq(ausd.balanceOf(receiver), 10 * UNIT);
    }

    function test_ownerRejectsTamperedCalls() public {
        _initialize(_emptySession());
        PasskeyAccount.Call[] memory calls = _transferCall(10 * UNIT);
        uint256 deadline = block.timestamp + 10 minutes;
        WebAuthn.WebAuthnAuth memory auth =
            WebAuthnSigner.sign(PASSKEY_PK, acct().ownerExecuteDigest(calls, 0, deadline));
        PasskeyAccount.Call[] memory tampered = _transferCall(900 * UNIT);
        vm.expectRevert(PasskeyAccount.BadSignature.selector);
        acct().executeAsOwner(tampered, deadline, auth);
    }

    function test_ownerRejectsOtherChain() public {
        _initialize(_emptySession());
        PasskeyAccount.Call[] memory calls = _transferCall(10 * UNIT);
        uint256 deadline = block.timestamp + 10 minutes;
        WebAuthn.WebAuthnAuth memory auth =
            WebAuthnSigner.sign(PASSKEY_PK, acct().ownerExecuteDigest(calls, 0, deadline));
        vm.chainId(143);
        vm.expectRevert(PasskeyAccount.BadSignature.selector);
        acct().executeAsOwner(calls, deadline, auth);
    }

    function test_ownerRejectsMalleatedSignature() public {
        _initialize(_emptySession());
        PasskeyAccount.Call[] memory calls = _transferCall(10 * UNIT);
        uint256 deadline = block.timestamp + 10 minutes;
        WebAuthn.WebAuthnAuth memory auth =
            WebAuthnSigner.sign(PASSKEY_PK, acct().ownerExecuteDigest(calls, 0, deadline));
        auth.s = bytes32(0xFFFFFFFF00000000FFFFFFFFFFFFFFFFBCE6FAADA7179E84F3B9CAC2FC632551 - uint256(auth.s));
        vm.expectRevert(PasskeyAccount.BadSignature.selector);
        acct().executeAsOwner(calls, deadline, auth);
    }

    function test_ownerExpired() public {
        _initialize(_emptySession());
        PasskeyAccount.Call[] memory calls = _transferCall(1);
        WebAuthn.WebAuthnAuth memory auth;
        vm.expectRevert(PasskeyAccount.Expired.selector);
        acct().executeAsOwner(calls, block.timestamp - 1, auth);
    }

    function test_ownerAddsAndRevokesSession() public {
        _initialize(_emptySession());
        PasskeyAccount.Call[] memory calls = new PasskeyAccount.Call[](1);
        calls[0] = PasskeyAccount.Call(
            account,
            0,
            abi.encodeCall(
                PasskeyAccount.addSession, (_tradingSession(uint48(block.timestamp + 1 days), 50 * 1e6))
            )
        );
        _ownerExec(calls, PASSKEY_PK);
        assertTrue(acct().sessionOf(session).active);
        assertTrue(acct().isPermitted(session, address(outcomes), outcomes.mint.selector));

        calls[0] = PasskeyAccount.Call(account, 0, abi.encodeCall(PasskeyAccount.revokeSession, (session)));
        _ownerExec(calls, PASSKEY_PK);
        assertFalse(acct().sessionOf(session).active);
        assertFalse(acct().isPermitted(session, address(outcomes), outcomes.mint.selector));
    }

    function test_adminFunctionsAreSelfOnly() public {
        _initialize(_emptySession());
        vm.expectRevert(PasskeyAccount.OnlySelf.selector);
        acct().revokeSession(session);
        // The account key itself may call directly.
        vm.prank(account);
        acct().revokeSession(session);
    }

    // --- session path ---------------------------------------------------------------------

    function test_sessionTradesWithinLimits() public {
        _initialize(_tradingSession(uint48(block.timestamp + 1 days), uint128(100 * UNIT)));
        _sessionExec(_mintCalls(60 * UNIT), SESSION_PK);
        assertEq(outcomes.seriesOf(seriesId).up.balanceOf(account), 60 * UNIT);
        assertEq(acct().remainingToday(session), 40 * UNIT);
    }

    function test_sessionDailyCap() public {
        _initialize(_tradingSession(uint48(block.timestamp + 3 days), uint128(100 * UNIT)));
        _sessionExec(_mintCalls(60 * UNIT), SESSION_PK);
        PasskeyAccount.Call[] memory calls = _mintCalls(50 * UNIT);
        uint256 deadline = block.timestamp + 10 minutes;
        bytes32 digest = acct().sessionExecuteDigest(calls, session, 1, deadline);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(SESSION_PK, digest);
        vm.expectRevert(
            abi.encodeWithSelector(PasskeyAccount.SpendLimitExceeded.selector, 50 * UNIT, 40 * UNIT)
        );
        acct().executeWithSession(calls, session, deadline, abi.encodePacked(r, s, v));

        // A new day resets the cap.
        advance(1 days);
        pushIndex(trend, 40 * POINT);
        seriesId = outcomes.openSeries("hantavirus", 7 days);
        _sessionExec(_mintCalls(100 * UNIT), SESSION_PK);
        assertEq(acct().remainingToday(session), 0);
    }

    function test_sessionCannotCallUnlistedTarget() public {
        _initialize(_tradingSession(uint48(block.timestamp + 1 days), uint128(100 * UNIT)));
        PasskeyAccount.Call[] memory calls = _transferCall(1 * UNIT);
        uint256 deadline = block.timestamp + 10 minutes;
        bytes32 digest = acct().sessionExecuteDigest(calls, session, 0, deadline);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(SESSION_PK, digest);
        vm.expectRevert(abi.encodeWithSelector(PasskeyAccount.CallNotAllowed.selector, 0));
        acct().executeWithSession(calls, session, deadline, abi.encodePacked(r, s, v));
    }

    function test_sessionCannotApproveUnlistedSpender() public {
        _initialize(_tradingSession(uint48(block.timestamp + 1 days), uint128(100 * UNIT)));
        PasskeyAccount.Call[] memory calls = new PasskeyAccount.Call[](1);
        calls[0] = PasskeyAccount.Call(
            address(ausd), 0, abi.encodeCall(IERC20.approve, (receiver, type(uint256).max))
        );
        uint256 deadline = block.timestamp + 10 minutes;
        bytes32 digest = acct().sessionExecuteDigest(calls, session, 0, deadline);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(SESSION_PK, digest);
        vm.expectRevert(abi.encodeWithSelector(PasskeyAccount.CallNotAllowed.selector, 0));
        acct().executeWithSession(calls, session, deadline, abi.encodePacked(r, s, v));
    }

    function test_sessionCannotRouteProceedsElsewhere() public {
        _initialize(_tradingSession(uint48(block.timestamp + 1 days), uint128(100 * UNIT)));
        PasskeyAccount.Call[] memory calls = _mintCalls(10 * UNIT);
        calls[1].data = abi.encodeCall(outcomes.mint, (seriesId, 10 * UNIT, receiver));
        uint256 deadline = block.timestamp + 10 minutes;
        bytes32 digest = acct().sessionExecuteDigest(calls, session, 0, deadline);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(SESSION_PK, digest);
        vm.expectRevert(abi.encodeWithSelector(PasskeyAccount.CallNotAllowed.selector, 1));
        acct().executeWithSession(calls, session, deadline, abi.encodePacked(r, s, v));

        // Dirty upper bits around the account address are rejected too.
        calls[1].data = abi.encodePacked(
            outcomes.mint.selector,
            seriesId,
            uint256(10 * UNIT),
            bytes32(uint256(uint160(account)) | (1 << 200))
        );
        digest = acct().sessionExecuteDigest(calls, session, 0, deadline);
        (v, r, s) = vm.sign(SESSION_PK, digest);
        vm.expectRevert(abi.encodeWithSelector(PasskeyAccount.CallNotAllowed.selector, 1));
        acct().executeWithSession(calls, session, deadline, abi.encodePacked(r, s, v));
    }

    function test_loweredLimitDoesNotUnderflow() public {
        _initialize(_tradingSession(uint48(block.timestamp + 1 days), uint128(100 * UNIT)));
        _sessionExec(_mintCalls(60 * UNIT), SESSION_PK);
        vm.prank(account);
        acct().addSession(_tradingSession(uint48(block.timestamp + 1 days), uint128(10 * UNIT)));
        assertEq(acct().remainingToday(session), 0);
        PasskeyAccount.Call[] memory calls = _mintCalls(1);
        uint256 deadline = block.timestamp + 10 minutes;
        bytes32 digest = acct().sessionExecuteDigest(calls, session, 1, deadline);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(SESSION_PK, digest);
        vm.expectRevert(abi.encodeWithSelector(PasskeyAccount.SpendLimitExceeded.selector, 1, 0));
        acct().executeWithSession(calls, session, deadline, abi.encodePacked(r, s, v));
    }

    function test_sessionCannotLeaveAllowance() public {
        _initialize(_tradingSession(uint48(block.timestamp + 1 days), uint128(100 * UNIT)));
        PasskeyAccount.Call[] memory calls = _mintCalls(10 * UNIT);
        calls[0].data = abi.encodeCall(IERC20.approve, (address(outcomes), 20 * UNIT)); // approve more than used
        uint256 deadline = block.timestamp + 10 minutes;
        bytes32 digest = acct().sessionExecuteDigest(calls, session, 0, deadline);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(SESSION_PK, digest);
        vm.expectRevert(
            abi.encodeWithSelector(PasskeyAccount.AllowanceLeft.selector, address(ausd), address(outcomes))
        );
        acct().executeWithSession(calls, session, deadline, abi.encodePacked(r, s, v));
    }

    function test_sessionCannotSendMon() public {
        _initialize(_tradingSession(uint48(block.timestamp + 1 days), uint128(100 * UNIT)));
        PasskeyAccount.Call[] memory calls = _mintCalls(10 * UNIT);
        calls[1].value = 1;
        uint256 deadline = block.timestamp + 10 minutes;
        bytes32 digest = acct().sessionExecuteDigest(calls, session, 0, deadline);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(SESSION_PK, digest);
        vm.expectRevert(abi.encodeWithSelector(PasskeyAccount.ValueNotAllowed.selector, 1));
        acct().executeWithSession(calls, session, deadline, abi.encodePacked(r, s, v));
    }

    function test_sessionExpiresAndRejectsReplayAndWrongKey() public {
        _initialize(_tradingSession(uint48(block.timestamp + 1 hours), uint128(100 * UNIT)));
        PasskeyAccount.Call[] memory calls = _mintCalls(10 * UNIT);
        uint256 deadline = block.timestamp + 10 minutes;
        bytes32 digest = acct().sessionExecuteDigest(calls, session, 0, deadline);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(SESSION_PK, digest);
        acct().executeWithSession(calls, session, deadline, abi.encodePacked(r, s, v));
        vm.expectRevert(PasskeyAccount.BadSignature.selector);
        acct().executeWithSession(calls, session, deadline, abi.encodePacked(r, s, v));

        digest = acct().sessionExecuteDigest(calls, session, 1, deadline);
        (v, r, s) = vm.sign(0xBAD, digest);
        vm.expectRevert(PasskeyAccount.BadSignature.selector);
        acct().executeWithSession(calls, session, deadline, abi.encodePacked(r, s, v));

        advance(1 hours + 1);
        vm.expectRevert(PasskeyAccount.SessionExpired.selector);
        acct().executeWithSession(calls, session, block.timestamp + 1, "");
    }

    function test_revokedSessionRejected() public {
        _initialize(_tradingSession(uint48(block.timestamp + 1 days), uint128(100 * UNIT)));
        vm.prank(account);
        acct().revokeSession(session);
        vm.expectRevert(PasskeyAccount.SessionInactive.selector);
        acct().executeWithSession(_mintCalls(1), session, block.timestamp + 1, "");
    }

    function test_sessionBatchCannotReenterTheAccount() public {
        Reenterer reenterer = new Reenterer();
        PasskeyAccount.Permission[] memory perms = new PasskeyAccount.Permission[](3);
        perms[0] = PasskeyAccount.Permission({
            target: address(outcomes), selector: outcomes.mint.selector, recipientArg: 3, guard: address(0)
        });
        perms[1] = PasskeyAccount.Permission({
            target: address(outcomes), selector: bytes4(0), recipientArg: 0, guard: address(0)
        });
        perms[2] = PasskeyAccount.Permission({
            target: address(reenterer), selector: Reenterer.poke.selector, recipientArg: 0, guard: address(0)
        });
        _initialize(
            PasskeyAccount.SessionConfig({
                key: session,
                validUntil: uint48(block.timestamp + 1 days),
                dailyLimit: uint128(100 * UNIT),
                permissions: perms
            })
        );

        // A second batch, validly signed for nonce 1, that the first tries to run from inside.
        PasskeyAccount.Call[] memory inner = _mintCalls(60 * UNIT);
        uint256 deadline = block.timestamp + 10 minutes;
        (uint8 v, bytes32 r, bytes32 s) =
            vm.sign(SESSION_PK, acct().sessionExecuteDigest(inner, session, 1, deadline));
        bytes memory reentry = abi.encodeCall(
            PasskeyAccount.executeWithSession, (inner, session, deadline, abi.encodePacked(r, s, v))
        );

        PasskeyAccount.Call[] memory outer = new PasskeyAccount.Call[](1);
        outer[0] =
            PasskeyAccount.Call(address(reenterer), 0, abi.encodeCall(Reenterer.poke, (account, reentry)));
        (v, r, s) = vm.sign(SESSION_PK, acct().sessionExecuteDigest(outer, session, 0, deadline));
        vm.expectRevert(
            abi.encodeWithSelector(
                PasskeyAccount.CallFailed.selector,
                0,
                abi.encodeWithSelector(ReentrancyGuardTransient.ReentrancyGuardReentrantCall.selector)
            )
        );
        acct().executeWithSession(outer, session, deadline, abi.encodePacked(r, s, v));
    }

    // --- gross daily limit ----------------------------------------------------------------

    function _redeemCall(uint256 amount) internal view returns (PasskeyAccount.Call memory) {
        return PasskeyAccount.Call(
            address(outcomes), 0, abi.encodeCall(outcomes.redeemSets, (seriesId, amount, account))
        );
    }

    function _withRedeem(PasskeyAccount.Permission[] memory perms)
        internal
        view
        returns (PasskeyAccount.Permission[] memory out)
    {
        out = new PasskeyAccount.Permission[](perms.length + 1);
        for (uint256 i; i < perms.length; ++i) {
            out[i] = perms[i];
        }
        out[perms.length] = PasskeyAccount.Permission({
            target: address(outcomes),
            selector: outcomes.redeemSets.selector,
            recipientArg: 3,
            guard: address(0)
        });
    }

    function _redeemingSession(uint128 dailyLimit)
        internal
        view
        returns (PasskeyAccount.SessionConfig memory cfg)
    {
        cfg = _tradingSession(uint48(block.timestamp + 3 days), dailyLimit);
        cfg.permissions = _withRedeem(cfg.permissions);
    }

    /// @notice The H1 shape: inflows earlier in a batch never pay for outflows later in it.
    function test_inflowsDoNotOffsetOutflows() public {
        _initialize(_redeemingSession(uint128(100 * UNIT)));
        _sessionExec(_mintCalls(60 * UNIT), SESSION_PK);
        assertEq(acct().remainingToday(session), 40 * UNIT);

        // Redeem 60 (60 AUSD in), then spend 60 again: the net change is zero, the gross outflow 60.
        PasskeyAccount.Call[] memory calls = new PasskeyAccount.Call[](3);
        calls[0] = _redeemCall(60 * UNIT);
        PasskeyAccount.Call[] memory mint = _mintCalls(60 * UNIT);
        calls[1] = mint[0];
        calls[2] = mint[1];
        uint256 deadline = block.timestamp + 10 minutes;
        (uint8 v, bytes32 r, bytes32 s) =
            vm.sign(SESSION_PK, acct().sessionExecuteDigest(calls, session, 1, deadline));
        vm.expectRevert(
            abi.encodeWithSelector(PasskeyAccount.SpendLimitExceeded.selector, 60 * UNIT, 40 * UNIT)
        );
        acct().executeWithSession(calls, session, deadline, abi.encodePacked(r, s, v));

        // Within what is left, the same shape goes through and is charged its outflow alone.
        calls[0] = _redeemCall(40 * UNIT);
        mint = _mintCalls(40 * UNIT);
        calls[1] = mint[0];
        calls[2] = mint[1];
        _sessionExec(calls, SESSION_PK);
        assertEq(acct().remainingToday(session), 0);
        assertEq(acct().sessionOf(session).spentToday, 100 * UNIT);
    }

    /// @notice Every call's outflow counts, not only the batch's net change.
    function test_everyOutflowCounts() public {
        _initialize(_redeemingSession(uint128(100 * UNIT)));
        PasskeyAccount.Call[] memory first = _mintCalls(30 * UNIT);
        PasskeyAccount.Call[] memory second = _mintCalls(25 * UNIT);
        PasskeyAccount.Call[] memory calls = new PasskeyAccount.Call[](5);
        calls[0] = first[0];
        calls[1] = first[1];
        calls[2] = _redeemCall(30 * UNIT);
        calls[3] = second[0];
        calls[4] = second[1];
        uint256 before = ausd.balanceOf(account);
        _sessionExec(calls, SESSION_PK);
        assertEq(before - ausd.balanceOf(account), 25 * UNIT, "net change");
        assertEq(acct().sessionOf(session).spentToday, 55 * UNIT, "gross outflow");
    }

    /// @notice Allowances the owner left behind are measured too: the balance is read around each call.
    function test_outflowThroughAnEarlierAllowanceCounts() public {
        _initialize(_tradingSession(uint48(block.timestamp + 1 days), uint128(100 * UNIT)));
        PasskeyAccount.Call[] memory approve = new PasskeyAccount.Call[](1);
        approve[0] = PasskeyAccount.Call(
            address(ausd), 0, abi.encodeCall(IERC20.approve, (address(outcomes), 500 * UNIT))
        );
        _ownerExec(approve, PASSKEY_PK);

        PasskeyAccount.Call[] memory calls = new PasskeyAccount.Call[](1);
        calls[0] = _mintCalls(150 * UNIT)[1];
        uint256 deadline = block.timestamp + 10 minutes;
        (uint8 v, bytes32 r, bytes32 s) =
            vm.sign(SESSION_PK, acct().sessionExecuteDigest(calls, session, 0, deadline));
        vm.expectRevert(
            abi.encodeWithSelector(PasskeyAccount.SpendLimitExceeded.selector, 150 * UNIT, 100 * UNIT)
        );
        acct().executeWithSession(calls, session, deadline, abi.encodePacked(r, s, v));
    }

    /// @notice Inflows alone spend nothing.
    function test_inflowOnlyBatchSpendsNothing() public {
        _initialize(_redeemingSession(uint128(100 * UNIT)));
        _sessionExec(_mintCalls(100 * UNIT), SESSION_PK);
        PasskeyAccount.Call[] memory calls = new PasskeyAccount.Call[](1);
        calls[0] = _redeemCall(100 * UNIT);
        _sessionExec(calls, SESSION_PK);
        assertEq(acct().sessionOf(session).spentToday, 100 * UNIT);
        assertEq(ausd.balanceOf(account), 1000 * UNIT);
    }

    // --- guards ---------------------------------------------------------------------------

    function _guardedSession(address guard) internal view returns (PasskeyAccount.SessionConfig memory cfg) {
        cfg = _tradingSession(uint48(block.timestamp + 1 days), uint128(100 * UNIT));
        cfg.permissions[0].guard = guard;
    }

    function test_guardApprovesCall() public {
        CeilingGuard guard = new CeilingGuard();
        guard.set(50 * UNIT, IPermissionGuard.check.selector);
        _initialize(_guardedSession(address(guard)));
        assertEq(acct().guardOf(session, address(outcomes), outcomes.mint.selector), address(guard));
        assertEq(acct().guardOf(session, address(outcomes), bytes4(0)), address(0));
        _sessionExec(_mintCalls(50 * UNIT), SESSION_PK);
        assertEq(outcomes.seriesOf(seriesId).up.balanceOf(account), 50 * UNIT);
    }

    function test_guardRefusalRevertsTheBatch() public {
        CeilingGuard guard = new CeilingGuard();
        guard.set(50 * UNIT, IPermissionGuard.check.selector);
        _initialize(_guardedSession(address(guard)));
        PasskeyAccount.Call[] memory calls = _mintCalls(51 * UNIT);
        uint256 deadline = block.timestamp + 10 minutes;
        (uint8 v, bytes32 r, bytes32 s) =
            vm.sign(SESSION_PK, acct().sessionExecuteDigest(calls, session, 0, deadline));
        vm.expectRevert(
            abi.encodeWithSelector(
                PasskeyAccount.GuardRejected.selector,
                1,
                abi.encodeWithSelector(CeilingGuard.AboveCeiling.selector, 51 * UNIT)
            )
        );
        acct().executeWithSession(calls, session, deadline, abi.encodePacked(r, s, v));
    }

    function test_guardMustAnswerItsSelector() public {
        CeilingGuard guard = new CeilingGuard();
        guard.set(type(uint256).max, bytes4(0xdeadbeef));
        _initialize(_guardedSession(address(guard)));
        PasskeyAccount.Call[] memory calls = _mintCalls(1 * UNIT);
        uint256 deadline = block.timestamp + 10 minutes;
        (uint8 v, bytes32 r, bytes32 s) =
            vm.sign(SESSION_PK, acct().sessionExecuteDigest(calls, session, 0, deadline));
        vm.expectRevert(abi.encodeWithSelector(PasskeyAccount.GuardRejected.selector, 1, ""));
        acct().executeWithSession(calls, session, deadline, abi.encodePacked(r, s, v));
    }

    function test_guardRunsAsAView() public {
        WritingGuard guard = new WritingGuard();
        _initialize(_guardedSession(address(guard)));
        PasskeyAccount.Call[] memory calls = _mintCalls(1 * UNIT);
        uint256 deadline = block.timestamp + 10 minutes;
        (uint8 v, bytes32 r, bytes32 s) =
            vm.sign(SESSION_PK, acct().sessionExecuteDigest(calls, session, 0, deadline));
        // A write under STATICCALL fails and burns what the guard was given; cap it for the test.
        vm.expectRevert(abi.encodeWithSelector(PasskeyAccount.GuardRejected.selector, 1, ""));
        acct().executeWithSession{gas: 3_000_000}(calls, session, deadline, abi.encodePacked(r, s, v));
        assertEq(guard.calls(), 0);
    }

    function test_guardWithoutCodeFailsClosed() public {
        _initialize(_guardedSession(address(0xC0DE)));
        PasskeyAccount.Call[] memory calls = _mintCalls(1 * UNIT);
        uint256 deadline = block.timestamp + 10 minutes;
        (uint8 v, bytes32 r, bytes32 s) =
            vm.sign(SESSION_PK, acct().sessionExecuteDigest(calls, session, 0, deadline));
        vm.expectRevert();
        acct().executeWithSession(calls, session, deadline, abi.encodePacked(r, s, v));
        assertEq(outcomes.seriesOf(seriesId).up.balanceOf(account), 0);
    }

    function test_guardOnSpenderAppliesToApprovals() public {
        CeilingGuard guard = new CeilingGuard();
        guard.set(type(uint256).max, IPermissionGuard.check.selector);
        PasskeyAccount.SessionConfig memory cfg = _tradingSession(uint48(block.timestamp + 1 days), 100 * 1e6);
        cfg.permissions[1].guard = address(guard); // the approved-spender rule
        _initialize(cfg);
        assertEq(acct().guardOf(session, address(outcomes), bytes4(0)), address(guard));
        // The ceiling guard decodes a mint; an approve's two arguments do not decode that way.
        PasskeyAccount.Call[] memory calls = _mintCalls(1 * UNIT);
        uint256 deadline = block.timestamp + 10 minutes;
        (uint8 v, bytes32 r, bytes32 s) =
            vm.sign(SESSION_PK, acct().sessionExecuteDigest(calls, session, 0, deadline));
        vm.expectRevert(abi.encodeWithSelector(PasskeyAccount.GuardRejected.selector, 0, ""));
        acct().executeWithSession(calls, session, deadline, abi.encodePacked(r, s, v));
    }

    // --- static properties ----------------------------------------------------------------

    /// @notice Delegated code cannot CREATE or CREATE2 on Monad; the bytecode contains neither.
    function test_noCreateOpcodes() public view {
        assertFalse(_hasCreate(address(impl).code));
        // The scan is not vacuous: it finds the CREATE2 that OutcomeMarkets uses for its tokens.
        assertTrue(_hasCreate(address(outcomes).code));
    }

    /// @dev Walks the opcodes like the EVM's jump-destination analysis, skipping PUSH data and the
    ///      trailing CBOR metadata. After a terminating opcode, bytes count as executable again only
    ///      from the next JUMPDEST, so data sections the compiler appends are not read as code. This
    ///      over-approximates what can run, so it can only err towards reporting a CREATE.
    function _hasCreate(bytes memory code) internal pure returns (bool) {
        uint256 metadataLength = (uint256(uint8(code[code.length - 2])) << 8) | uint8(code[code.length - 1]);
        uint256 end = code.length - 2 - metadataLength;
        bool live = true;
        uint256 i;
        while (i < end) {
            uint8 op = uint8(code[i]);
            if (op == 0x5b) live = true;
            if (live && (op == 0xf0 || op == 0xf5)) return true;
            if (op == 0x00 || op == 0x56 || op == 0xf3 || op == 0xfd || op == 0xfe || op == 0xff) {
                live = false;
            }
            i += (op >= 0x60 && op <= 0x7f) ? op - 0x5e : 1;
        }
        return false;
    }

    function testFuzz_sessionNeverExceedsDailyLimit(uint96 a, uint96 b, uint96 limit) public {
        limit = uint96(bound(limit, UNIT, 500 * UNIT));
        a = uint96(bound(a, 1, 400 * UNIT));
        b = uint96(bound(b, 1, 400 * UNIT));
        _initialize(_tradingSession(uint48(block.timestamp + 1 days), limit));
        try this.execAsSession(_mintCalls(a), SESSION_PK) {} catch {}
        try this.execAsSession(_mintCalls(b), SESSION_PK) {} catch {}
        uint256 spent = 1000 * UNIT - ausd.balanceOf(account);
        assertLe(spent, limit);
    }

    /// @notice Whatever mix of redemptions and mints a session sends, the AUSD its calls pull out
    ///         in a day never exceeds the limit.
    function testFuzz_grossOutflowNeverExceedsDailyLimit(uint96[4] memory amounts, uint8 shape, uint96 limit)
        public
    {
        limit = uint96(bound(limit, UNIT, 300 * UNIT));
        _initialize(_redeemingSession(limit));
        uint256 pulled;
        for (uint256 i; i < amounts.length; ++i) {
            uint256 amount = bound(amounts[i], 1, 200 * UNIT);
            bool redeemFirst = (shape >> i) & 1 == 1;
            uint256 held = outcomes.seriesOf(seriesId).up.balanceOf(account);
            PasskeyAccount.Call[] memory mint = _mintCalls(amount);
            PasskeyAccount.Call[] memory calls = new PasskeyAccount.Call[](redeemFirst && held > 0 ? 3 : 2);
            uint256 j;
            if (calls.length == 3) calls[j++] = _redeemCall(held);
            calls[j++] = mint[0];
            calls[j] = mint[1];
            try this.execAsSession(calls, SESSION_PK) {
                pulled += amount;
            } catch {}
        }
        assertLe(pulled, limit);
        assertEq(acct().sessionOf(session).spentToday, pulled);
    }

    function execAsSession(PasskeyAccount.Call[] memory calls, uint256 pk) external {
        _sessionExec(calls, pk);
    }
}
