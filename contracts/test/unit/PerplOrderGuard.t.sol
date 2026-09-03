// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Test} from "forge-std/Test.sol";
import {WebAuthn} from "solady/utils/WebAuthn.sol";

import {IPermissionGuard} from "../../src/account/IPermissionGuard.sol";
import {PasskeyAccount} from "../../src/account/PasskeyAccount.sol";
import {PerplOrderGuard} from "../../src/account/guards/PerplOrderGuard.sol";
import {IPerplExchange} from "../../src/interfaces/perpl/IPerplExchange.sol";
import {MockPerplExchange} from "../mocks/MockPerplExchange.sol";
import {MockStable} from "../mocks/MockStable.sol";
import {WebAuthnSigner} from "../utils/WebAuthnSigner.sol";

contract PerplOrderGuardTest is Test {
    uint256 internal constant BAND = 200;
    uint256 internal constant MAX_AGE = 120;
    /// @dev 10x, in Perpl's hundredths.
    uint256 internal constant MAX_LEVERAGE = 1000;
    uint256 internal constant PERP = 16;
    /// @dev BTC at 83,037.7 with one price decimal, as on Perpl.
    uint256 internal constant MARK = 830_377;
    uint256 internal constant UNIT = 1e6;
    uint256 internal constant EOA_PK = 0xE0A;
    uint256 internal constant PASSKEY_PK = 0x9A55;
    uint256 internal constant SESSION_PK = 0x5E5;

    MockStable internal ausd;
    MockPerplExchange internal exchange;
    PerplOrderGuard internal guard;
    PasskeyAccount internal impl;
    address internal account;
    address internal session;

    function setUp() public {
        vm.warp(1_800_000_000);
        ausd = new MockStable();
        exchange = new MockPerplExchange(ausd);
        exchange.setMark(PERP, MARK, block.timestamp);
        guard = new PerplOrderGuard(IPerplExchange(address(exchange)), BAND, MAX_AGE, MAX_LEVERAGE);
        impl = new PasskeyAccount(ausd);
        account = vm.addr(EOA_PK);
        session = vm.addr(SESSION_PK);
        vm.signAndAttachDelegation(address(impl), EOA_PK);
        (bool ok,) = account.call("");
        assertTrue(ok);
        ausd.mint(account, 1000 * UNIT);
    }

    // --- helpers --------------------------------------------------------------------------

    /// @dev An immediate-or-cancel order, as packages/perpl's openMarketOrder and closeMarketOrder build
    ///      them: opens at 5x, closes naming no leverage.
    function _order(uint8 orderType, uint256 price)
        internal
        pure
        returns (IPerplExchange.OrderDesc memory o)
    {
        o.orderDescId = 1;
        o.perpId = PERP;
        o.orderType = orderType;
        o.pricePNS = price;
        o.lotLNS = 1000;
        o.immediateOrCancel = true;
        o.leverageHdths = orderType < 2 ? 500 : 0;
        o.maxNegPnlCollatBPS = 1000;
    }

    function _execOrder(IPerplExchange.OrderDesc memory o) internal pure returns (bytes memory) {
        return abi.encodeCall(IPerplExchange.execOrder, (o));
    }

    function _check(bytes memory data) internal view returns (bytes4) {
        return guard.check(account, address(exchange), data);
    }

    function _perplSession(uint128 dailyLimit)
        internal
        view
        returns (PasskeyAccount.SessionConfig memory cfg)
    {
        PasskeyAccount.Permission[] memory perms = new PasskeyAccount.Permission[](4);
        perms[0] = PasskeyAccount.Permission(
            address(exchange), IPerplExchange.execOrder.selector, 0, address(guard)
        );
        perms[1] = PasskeyAccount.Permission(
            address(exchange), IPerplExchange.execOrders.selector, 0, address(guard)
        );
        perms[2] = PasskeyAccount.Permission(
            address(exchange), MockPerplExchange.depositCollateral.selector, 0, address(0)
        );
        perms[3] = PasskeyAccount.Permission(address(exchange), bytes4(0), 0, address(0));
        cfg = PasskeyAccount.SessionConfig({
            key: session,
            validUntil: uint48(block.timestamp + 7 days),
            dailyLimit: dailyLimit,
            permissions: perms
        });
    }

    function _initialize(PasskeyAccount.SessionConfig memory cfg) internal {
        (bytes32 x, bytes32 y) = WebAuthnSigner.publicKey(PASSKEY_PK);
        uint256 deadline = block.timestamp + 1 hours;
        (uint8 v, bytes32 r, bytes32 s) =
            vm.sign(EOA_PK, PasskeyAccount(payable(account)).initializeDigest(x, y, cfg, deadline));
        PasskeyAccount(payable(account)).initialize(x, y, cfg, deadline, abi.encodePacked(r, s, v));
    }

    function _sessionCalls(PasskeyAccount.Call[] memory calls) external {
        PasskeyAccount a = PasskeyAccount(payable(account));
        uint256 deadline = block.timestamp + 10 minutes;
        (uint8 v, bytes32 r, bytes32 s) =
            vm.sign(SESSION_PK, a.sessionExecuteDigest(calls, session, a.sessionOf(session).nonce, deadline));
        a.executeWithSession(calls, session, deadline, abi.encodePacked(r, s, v));
    }

    function _one(bytes memory data) internal view returns (PasskeyAccount.Call[] memory calls) {
        calls = new PasskeyAccount.Call[](1);
        calls[0] = PasskeyAccount.Call(address(exchange), 0, data);
    }

    function _leveraged(uint8 orderType, uint256 leverageHdths) internal pure returns (bytes memory) {
        IPerplExchange.OrderDesc memory o = _order(orderType, MARK);
        o.leverageHdths = leverageHdths;
        return _execOrder(o);
    }

    function _ownerCalls(PasskeyAccount.Call[] memory calls) internal {
        PasskeyAccount a = PasskeyAccount(payable(account));
        uint256 deadline = block.timestamp + 10 minutes;
        WebAuthn.WebAuthnAuth memory auth =
            WebAuthnSigner.sign(PASSKEY_PK, a.ownerExecuteDigest(calls, a.ownerNonce(), deadline));
        a.executeAsOwner(calls, deadline, auth);
    }

    // --- construction ---------------------------------------------------------------------

    function test_constructorRejectsBadSettings() public {
        IPerplExchange ex = IPerplExchange(address(exchange));
        vm.expectRevert(PerplOrderGuard.ZeroAddress.selector);
        new PerplOrderGuard(IPerplExchange(address(0)), BAND, MAX_AGE, MAX_LEVERAGE);
        vm.expectRevert(PerplOrderGuard.BadBand.selector);
        new PerplOrderGuard(ex, 0, MAX_AGE, MAX_LEVERAGE);
        vm.expectRevert(PerplOrderGuard.BadBand.selector);
        new PerplOrderGuard(ex, 10_000, MAX_AGE, MAX_LEVERAGE);
        vm.expectRevert(PerplOrderGuard.BadMaxAge.selector);
        new PerplOrderGuard(ex, BAND, 0, MAX_LEVERAGE);
        // The cap is at least 1x.
        vm.expectRevert(PerplOrderGuard.BadMaxLeverage.selector);
        new PerplOrderGuard(ex, BAND, MAX_AGE, 0);
        vm.expectRevert(PerplOrderGuard.BadMaxLeverage.selector);
        new PerplOrderGuard(ex, BAND, MAX_AGE, 99);
        PerplOrderGuard oneX = new PerplOrderGuard(ex, BAND, MAX_AGE, 100);
        assertEq(oneX.maxLeverageHdths(), 100);
        assertEq(guard.maxLeverageHdths(), MAX_LEVERAGE);
    }

    // --- the band -------------------------------------------------------------------------

    function test_ordersInsideTheBandPass() public view {
        for (uint8 t; t <= 3; ++t) {
            assertEq(_check(_execOrder(_order(t, MARK))), IPermissionGuard.check.selector);
            assertEq(_check(_execOrder(_order(t, MARK * 10_200 / 10_000))), IPermissionGuard.check.selector);
            assertEq(_check(_execOrder(_order(t, MARK * 9800 / 10_000 + 1))), IPermissionGuard.check.selector);
        }
    }

    function test_ordersOutsideTheBandFail() public {
        uint256 above = MARK * 10_200 / 10_000 + 1;
        vm.expectRevert(abi.encodeWithSelector(PerplOrderGuard.PriceOutsideBand.selector, 0, above, MARK));
        _check(_execOrder(_order(0, above)));
        uint256 below = MARK * 9800 / 10_000 - 1;
        vm.expectRevert(abi.encodeWithSelector(PerplOrderGuard.PriceOutsideBand.selector, 0, below, MARK));
        _check(_execOrder(_order(3, below)));
        // A buy far below the market and a sell far above it are refused too: the band is two-sided.
        vm.expectRevert(abi.encodeWithSelector(PerplOrderGuard.PriceOutsideBand.selector, 0, 1, MARK));
        _check(_execOrder(_order(0, 1)));
        vm.expectRevert(
            abi.encodeWithSelector(PerplOrderGuard.PriceOutsideBand.selector, 0, type(uint256).max, MARK)
        );
        _check(_execOrder(_order(1, type(uint256).max)));
    }

    /// @notice The worst prices Trendr's own clients send pass: the app (up to 1% from its reference)
    ///         and the Autopilot executor and copy-trading (its slippage, at most 1%, from the mark).
    function test_trendrClientPricesPass() public view {
        uint256[4] memory slippageBps = [uint256(50), 100, 150, 30];
        for (uint256 i; i < slippageBps.length; ++i) {
            uint256 up = MARK * (10_000 + slippageBps[i]) / 10_000;
            uint256 down = MARK * (10_000 - slippageBps[i]) / 10_000;
            _check(_execOrder(_order(0, up))); // open long at mark + slippage
            _check(_execOrder(_order(1, down))); // open short
            _check(_execOrder(_order(2, down))); // close long sells
            _check(_execOrder(_order(3, up))); // close short buys
        }
    }

    function testFuzz_passesExactlyInsideTheBand(uint256 price, uint256 mark) public {
        mark = bound(mark, 1, 1e30);
        price = bound(price, 0, 3 * mark);
        exchange.setMark(PERP, mark, block.timestamp);
        uint256 distance = price > mark ? price - mark : mark - price;
        bool inside = distance * 10_000 <= mark * BAND;
        try this.checkExternal(_execOrder(_order(0, price))) returns (bytes4 answer) {
            assertTrue(inside, "outside the band but passed");
            assertEq(answer, IPermissionGuard.check.selector);
        } catch (bytes memory reason) {
            assertFalse(inside, "inside the band but refused");
            assertEq(bytes4(reason), PerplOrderGuard.PriceOutsideBand.selector);
        }
    }

    function checkExternal(bytes memory data) external view returns (bytes4) {
        return _check(data);
    }

    // --- leverage -------------------------------------------------------------------------

    function test_opensUpToTheCapPass() public view {
        for (uint8 t; t <= 1; ++t) {
            assertEq(_check(_leveraged(t, 1)), IPermissionGuard.check.selector);
            assertEq(_check(_leveraged(t, 100)), IPermissionGuard.check.selector);
            assertEq(_check(_leveraged(t, MAX_LEVERAGE)), IPermissionGuard.check.selector);
        }
    }

    function test_opensAboveTheCapOrWithoutLeverageFail() public {
        for (uint8 t; t <= 1; ++t) {
            vm.expectRevert(
                abi.encodeWithSelector(
                    PerplOrderGuard.LeverageNotAllowed.selector, 0, MAX_LEVERAGE + 1, MAX_LEVERAGE
                )
            );
            _check(_leveraged(t, MAX_LEVERAGE + 1));
            vm.expectRevert(
                abi.encodeWithSelector(PerplOrderGuard.LeverageNotAllowed.selector, 0, 2000, MAX_LEVERAGE)
            );
            _check(_leveraged(t, 2000));
            vm.expectRevert(
                abi.encodeWithSelector(
                    PerplOrderGuard.LeverageNotAllowed.selector, 0, type(uint256).max, MAX_LEVERAGE
                )
            );
            _check(_leveraged(t, type(uint256).max));
            // An opening must name its leverage.
            vm.expectRevert(
                abi.encodeWithSelector(PerplOrderGuard.LeverageNotAllowed.selector, 0, 0, MAX_LEVERAGE)
            );
            _check(_leveraged(t, 0));
        }
    }

    /// @notice Closes are reduce-only, so whatever leverage they name, they pass.
    function test_closesAreNotCapped() public view {
        uint256[4] memory leverages = [uint256(0), MAX_LEVERAGE, MAX_LEVERAGE + 1, type(uint256).max];
        for (uint8 t = 2; t <= 3; ++t) {
            for (uint256 i; i < leverages.length; ++i) {
                assertEq(_check(_leveraged(t, leverages[i])), IPermissionGuard.check.selector);
            }
        }
    }

    function testFuzz_capsOpensOnly(uint8 orderType, uint256 leverageHdths) public view {
        orderType = uint8(bound(orderType, 0, 3));
        bool allowed = orderType > 1 || (leverageHdths > 0 && leverageHdths <= MAX_LEVERAGE);
        try this.checkExternal(_leveraged(orderType, leverageHdths)) returns (bytes4 answer) {
            assertTrue(allowed, "an opening above the cap passed");
            assertEq(answer, IPermissionGuard.check.selector);
        } catch (bytes memory reason) {
            assertFalse(allowed, "an allowed order was refused");
            assertEq(
                reason,
                abi.encodeWithSelector(
                    PerplOrderGuard.LeverageNotAllowed.selector, 0, leverageHdths, MAX_LEVERAGE
                )
            );
        }
    }

    // --- freshness ------------------------------------------------------------------------

    function test_staleOrMissingMarkFails() public {
        exchange.setMark(PERP, MARK, block.timestamp - MAX_AGE);
        _check(_execOrder(_order(0, MARK)));
        exchange.setMark(PERP, MARK, block.timestamp - MAX_AGE - 1);
        vm.expectRevert(
            abi.encodeWithSelector(PerplOrderGuard.StaleMark.selector, PERP, block.timestamp - MAX_AGE - 1)
        );
        _check(_execOrder(_order(0, MARK)));
        // A mark stamped a little ahead of the block clock is fresh.
        exchange.setMark(PERP, MARK, block.timestamp + 5);
        _check(_execOrder(_order(0, MARK)));
        // An unknown perpetual has no mark.
        IPerplExchange.OrderDesc memory o = _order(0, MARK);
        o.perpId = 999;
        vm.expectRevert(abi.encodeWithSelector(PerplOrderGuard.StaleMark.selector, 999, 0));
        _check(_execOrder(o));
    }

    // --- shapes ---------------------------------------------------------------------------

    function test_onlyImmediateOpensAndClosesPass() public {
        for (uint8 t = 4; t <= 6; ++t) {
            vm.expectRevert(abi.encodeWithSelector(PerplOrderGuard.OrderTypeNotAllowed.selector, 0, t));
            _check(_execOrder(_order(t, MARK)));
        }
        IPerplExchange.OrderDesc memory resting = _order(0, MARK);
        resting.immediateOrCancel = false;
        vm.expectRevert(abi.encodeWithSelector(PerplOrderGuard.MustBeImmediate.selector, 0));
        _check(_execOrder(resting));
        IPerplExchange.OrderDesc memory postOnly = _order(0, MARK);
        postOnly.postOnly = true;
        vm.expectRevert(abi.encodeWithSelector(PerplOrderGuard.MustBeImmediate.selector, 0));
        _check(_execOrder(postOnly));
    }

    function test_everyOrderInABatchIsChecked() public {
        IPerplExchange.OrderDesc[] memory orders = new IPerplExchange.OrderDesc[](3);
        orders[0] = _order(0, MARK);
        orders[1] = _order(2, MARK);
        orders[2] = _order(1, MARK / 2);
        vm.expectRevert(abi.encodeWithSelector(PerplOrderGuard.PriceOutsideBand.selector, 2, MARK / 2, MARK));
        _check(abi.encodeCall(IPerplExchange.execOrders, (orders, false)));
        orders[2] = _order(1, MARK);
        assertEq(
            _check(abi.encodeCall(IPerplExchange.execOrders, (orders, true))), IPermissionGuard.check.selector
        );
        orders[1].leverageHdths = MAX_LEVERAGE + 1; // a close: not capped
        orders[2].leverageHdths = MAX_LEVERAGE + 1;
        vm.expectRevert(
            abi.encodeWithSelector(
                PerplOrderGuard.LeverageNotAllowed.selector, 2, MAX_LEVERAGE + 1, MAX_LEVERAGE
            )
        );
        _check(abi.encodeCall(IPerplExchange.execOrders, (orders, false)));
    }

    function test_otherCallsAndTargetsFail() public {
        vm.expectRevert(abi.encodeWithSelector(PerplOrderGuard.WrongTarget.selector, address(0xBAD)));
        guard.check(account, address(0xBAD), _execOrder(_order(0, MARK)));
        bytes memory v2 = abi.encodeCall(MockPerplExchange.execOrderV2, (_order(0, MARK), ""));
        vm.expectRevert(abi.encodeWithSelector(PerplOrderGuard.UnsupportedCall.selector, bytes4(v2)));
        _check(v2);
        vm.expectRevert(abi.encodeWithSelector(PerplOrderGuard.UnsupportedCall.selector, bytes4(0)));
        _check(hex"01");
        // Truncated calldata does not decode.
        bytes memory truncated = _execOrder(_order(0, MARK));
        assembly {
            mstore(truncated, 100)
        }
        vm.expectRevert();
        _check(truncated);
    }

    // --- through an account ---------------------------------------------------------------

    function test_sessionTradesInsideTheBandAndCannotSelfDeal() public {
        _initialize(_perplSession(uint128(100 * UNIT)));
        this._sessionCalls(_one(_execOrder(_order(0, MARK * 10_050 / 10_000))));
        assertEq(exchange.executedCount(), 1);

        // A thief's order priced into its own resting ask, 5% above the mark.
        PasskeyAccount.Call[] memory calls = _one(_execOrder(_order(0, MARK * 10_500 / 10_000)));
        vm.expectRevert(
            abi.encodeWithSelector(
                PasskeyAccount.GuardRejected.selector,
                0,
                abi.encodeWithSelector(
                    PerplOrderGuard.PriceOutsideBand.selector, 0, MARK * 10_500 / 10_000, MARK
                )
            )
        );
        this._sessionCalls(calls);
        assertEq(exchange.executedCount(), 1);
    }

    /// @notice A session opens at up to 10x and closes at any leverage; above 10x takes the passkey.
    function test_sessionLeverageIsCappedButThePasskeyIsNot() public {
        _initialize(_perplSession(uint128(100 * UNIT)));
        this._sessionCalls(_one(_leveraged(0, MAX_LEVERAGE)));
        this._sessionCalls(_one(_leveraged(2, MAX_LEVERAGE * 5)));
        assertEq(exchange.executedCount(), 2);

        PasskeyAccount.Call[] memory calls = _one(_leveraged(1, 2000));
        vm.expectRevert(
            abi.encodeWithSelector(
                PasskeyAccount.GuardRejected.selector,
                0,
                abi.encodeWithSelector(PerplOrderGuard.LeverageNotAllowed.selector, 0, 2000, MAX_LEVERAGE)
            )
        );
        this._sessionCalls(calls);
        assertEq(exchange.executedCount(), 2);

        _ownerCalls(calls);
        assertEq(exchange.executedCount(), 3);
        assertEq(exchange.executedAt(2).leverageHdths, 2000);
    }

    function test_perplDepositsCountAgainstTheGrossLimit() public {
        _initialize(_perplSession(uint128(100 * UNIT)));
        PasskeyAccount.Call[] memory calls = new PasskeyAccount.Call[](3);
        calls[0] = PasskeyAccount.Call(
            address(ausd), 0, abi.encodeCall(IERC20.approve, (address(exchange), 80 * UNIT))
        );
        calls[1] = PasskeyAccount.Call(
            address(exchange), 0, abi.encodeCall(MockPerplExchange.depositCollateral, (80 * UNIT))
        );
        calls[2] = PasskeyAccount.Call(address(exchange), 0, _execOrder(_order(0, MARK)));
        this._sessionCalls(calls);
        assertEq(PasskeyAccount(payable(account)).sessionOf(session).spentToday, 80 * UNIT);
        calls = new PasskeyAccount.Call[](2);
        calls[0] = PasskeyAccount.Call(
            address(ausd), 0, abi.encodeCall(IERC20.approve, (address(exchange), 21 * UNIT))
        );
        calls[1] = PasskeyAccount.Call(
            address(exchange), 0, abi.encodeCall(MockPerplExchange.depositCollateral, (21 * UNIT))
        );
        vm.expectRevert(
            abi.encodeWithSelector(PasskeyAccount.SpendLimitExceeded.selector, 21 * UNIT, 20 * UNIT)
        );
        this._sessionCalls(calls);
    }
}
