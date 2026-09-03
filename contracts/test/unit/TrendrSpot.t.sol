// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {PasskeyAccount} from "../../src/account/PasskeyAccount.sol";
import {BondingCurve} from "../../src/curve/BondingCurve.sol";
import {ITrendRegistry} from "../../src/interfaces/ITrendRegistry.sol";
import {IKuruRouter} from "../../src/interfaces/kuru/IKuru.sol";
import {OutcomeListing} from "../../src/outcome/OutcomeListing.sol";
import {OutcomeMarkets} from "../../src/outcome/OutcomeMarkets.sol";
import {AttentionPricing} from "../../src/spot/AttentionPricing.sol";
import {TrendrSpot} from "../../src/spot/TrendrSpot.sol";
import {MockKuruRouter} from "../mocks/MockKuru.sol";
import {Fixture} from "../utils/Fixture.sol";

contract TrendrSpotTest is Fixture {
    MockKuruRouter internal router;
    OutcomeListing internal listing;
    TrendrSpot internal spot;
    bytes32 internal trend;
    bytes32 internal sid;
    IERC20 internal up;
    IERC20 internal down;
    address internal trader = address(0x7A);
    address internal account = address(0xACC);

    function setUp() public override {
        super.setUp();
        router = new MockKuruRouter(false);
        listing = new OutcomeListing(IKuruRouter(address(router)), outcomes, false);
        spot = new TrendrSpot(IKuruRouter(address(router)), listing, curve);
        trend = createTrend("hantavirus", ITrendRegistry.AssetClass.Topic, 40 * POINT);
        sid = outcomes.openSeries("hantavirus", 1 days);
        OutcomeMarkets.Series memory s = outcomes.seriesOf(sid);
        up = IERC20(address(s.up));
        down = IERC20(address(s.down));
        listing.list(sid);

        // The router holds both sides to pay out; the trader holds AUSD, UP and DOWN.
        fund(address(this), 10_000 * UNIT);
        outcomes.mint(sid, 1000 * UNIT, address(router));
        ausd.mint(address(router), 1000 * UNIT);
        fund(trader, 1000 * UNIT);
        vm.startPrank(trader);
        outcomes.mint(sid, 100 * UNIT, trader);
        ausd.approve(address(spot), type(uint256).max);
        up.approve(address(spot), type(uint256).max);
        down.approve(address(spot), type(uint256).max);
        vm.stopPrank();
    }

    function test_buyAndSellThroughTheCanonicalMarket() public {
        // At the opening level, a day out, UP is a coin flip and the router trades at 0.50.
        vm.prank(trader);
        uint256 bought = spot.buy(address(up), 30 * UNIT, 59 * UNIT, account);
        assertEq(bought, 60 * UNIT, "30 AUSD at 0.50");
        assertEq(up.balanceOf(account), 60 * UNIT, "paid to the recipient");

        vm.prank(trader);
        uint256 proceeds = spot.sell(address(up), 40 * UNIT, 19 * UNIT, account);
        assertEq(proceeds, 20 * UNIT);
        assertEq(ausd.balanceOf(account), 20 * UNIT);

        // Nothing stays with the spot contract or approved to the router.
        assertEq(ausd.balanceOf(address(spot)), 0);
        assertEq(up.balanceOf(address(spot)), 0);
        assertEq(ausd.allowance(address(spot), address(router)), 0);
        assertEq(up.allowance(address(spot), address(router)), 0);
    }

    function test_priceBandFollowsTheAttentionIndex() public {
        (uint256 fair, uint256 low, uint256 high) = spot.priceBand(address(up));
        assertApproxEqAbs(fair, 0.5e18, 1e9, "a coin flip at the opening level");
        assertEq(low, fair - spot.MAX_DEVIATION());
        assertEq(high, fair + spot.MAX_DEVIATION());

        // The index doubles: UP is now likely, DOWN the mirror image.
        _setIndex(80 * POINT);
        (uint256 upFair,,) = spot.priceBand(address(up));
        (uint256 downFair,,) = spot.priceBand(address(down));
        uint256 tau = outcomes.seriesOf(sid).expiry - vm.getBlockTimestamp();
        assertEq(upFair, AttentionPricing.upProbability(80 * POINT, 40 * POINT, tau));
        assertGt(upFair, 0.85e18);
        assertEq(upFair + downFair, 1e18);

        // Close to expiry the band is pinned to [0, 1] AUSD at its ends.
        advance(1 days - 600);
        _setIndex(80 * POINT);
        (uint256 f, uint256 l, uint256 h) = spot.priceBand(address(up));
        assertEq(f, AttentionPricing.MAX_PROBABILITY);
        assertEq(h, 1e18);
        assertEq(l, f - spot.MAX_DEVIATION());
        (f, l,) = spot.priceBand(address(down));
        assertEq(f, AttentionPricing.MIN_PROBABILITY);
        assertEq(l, 0);
    }

    /// @dev The M1 attack: a stolen session key sells the account's tokens into the thief's bid at
    ///      the bottom of the book with a minimum of one unit. The band floor refuses it.
    function test_sellBelowTheBandIsRefusedWhateverTheMinimum() public {
        router.setSwap(0.3e18, 10_000);
        vm.prank(trader);
        vm.expectRevert(bytes("slippage"));
        spot.sell(address(up), 40 * UNIT, 1, account);
        // At the band's floor it goes through.
        router.setSwap(0.4e18 + 1e9, 10_000);
        vm.prank(trader);
        assertGe(spot.sell(address(up), 40 * UNIT, 1, account), 16 * UNIT);
    }

    /// @dev The mirror attack: the thief's ask at the top of the book. The band's top refuses it.
    function test_buyAboveTheBandIsRefusedWhateverTheMinimum() public {
        router.setSwap(0.7e18, 10_000);
        vm.prank(trader);
        vm.expectRevert(bytes("slippage"));
        spot.buy(address(up), 10 * UNIT, 1, account);
        router.setSwap(0.6e18 - 1e9, 10_000);
        vm.prank(trader);
        assertGe(spot.buy(address(up), 12 * UNIT, 1, account), 20 * UNIT);
    }

    function test_theBandMovesWithTheIndex() public {
        // UP is worth about 0.88 once the index doubles: selling at 0.50 is now far too cheap.
        _setIndex(80 * POINT);
        vm.prank(trader);
        vm.expectRevert(bytes("slippage"));
        spot.sell(address(up), 10 * UNIT, 1, account);
        // DOWN at 0.50 is far too dear.
        vm.prank(trader);
        vm.expectRevert(bytes("slippage"));
        spot.buy(address(down), 10 * UNIT, 1, account);
        // The owner may still trade at its own limit.
        vm.prank(trader);
        assertEq(spot.sellWithLimit(address(up), 10 * UNIT, 5 * UNIT, account), 5 * UNIT);
    }

    function test_sessionTradesNeedAnOpenSeriesAndAFreshIndex() public {
        // The oracle stops reporting.
        advance(11 minutes);
        vm.prank(trader);
        vm.expectRevert(TrendrSpot.IndexStale.selector);
        spot.sell(address(up), 10 * UNIT, 1, account);
        // The series expires.
        advance(1 days);
        _setIndex(40 * POINT);
        vm.prank(trader);
        vm.expectRevert(TrendrSpot.SeriesClosed.selector);
        spot.buy(address(up), 10 * UNIT, 1, account);
        vm.expectRevert(TrendrSpot.SeriesClosed.selector);
        spot.priceBand(address(up));
        // Owner trades do not depend on the oracle.
        vm.prank(trader);
        assertEq(spot.sellWithLimit(address(up), 10 * UNIT, 5 * UNIT, account), 5 * UNIT);
    }

    function test_refusesUnsafeOrUnknownTrades() public {
        vm.startPrank(trader);
        for (uint256 limited; limited < 2; ++limited) {
            _expectBuyRevert(
                limited == 1, address(up), 10 * UNIT, 0, account, TrendrSpot.NoMinimumOut.selector
            );
            _expectBuyRevert(limited == 1, address(up), 0, 1, account, TrendrSpot.ZeroAmount.selector);
            _expectBuyRevert(
                limited == 1, address(up), 10 * UNIT, 1, address(0), TrendrSpot.ZeroAddress.selector
            );
            // AUSD itself, a random contract and a non-contract have no Trendr market.
            _expectBuyRevert(
                limited == 1, address(ausd), 10 * UNIT, 1, account, TrendrSpot.NotTradable.selector
            );
            _expectBuyRevert(
                limited == 1, address(router), 10 * UNIT, 1, account, TrendrSpot.NotTradable.selector
            );
            _expectBuyRevert(
                limited == 1, address(0xBEEF), 10 * UNIT, 1, account, TrendrSpot.NotTradable.selector
            );
        }
        vm.stopPrank();
        vm.expectRevert(TrendrSpot.NotTradable.selector);
        spot.priceBand(address(ausd));
    }

    /// @dev Reports `target` in steps the registry accepts (it clamps each move), a minute apart.
    function _setIndex(uint64 target) internal {
        for (uint256 i; i < 8; ++i) {
            advance(60);
            pushIndex(trend, target);
            (uint64 index,) = registry.indexOf(trend);
            if (index == target) return;
        }
        revert("index did not converge");
    }

    function _expectBuyRevert(
        bool limited,
        address token,
        uint256 amount,
        uint256 minOut,
        address to,
        bytes4 err
    ) internal {
        vm.expectRevert(err);
        if (limited) spot.buyWithLimit(token, amount, minOut, to);
        else spot.buy(token, amount, minOut, to);
    }

    function test_unlistedSeriesIsNotTradable() public {
        createTrend("gamma", ITrendRegistry.AssetClass.Topic, 40 * POINT);
        bytes32 other = outcomes.openSeries("gamma", 1 days);
        address otherUp = address(outcomes.seriesOf(other).up);
        assertEq(spot.marketOf(otherUp), address(0));
        listing.list(other);
        assertEq(spot.marketOf(otherUp), listing.marketOf(otherUp));
    }

    function test_enforcesTheMinimumOutput() public {
        router.setSwap(0.5e18, 9000);
        vm.startPrank(trader);
        vm.expectRevert(bytes("slippage"));
        spot.buy(address(up), 10 * UNIT, 19 * UNIT, account);
        vm.expectRevert(bytes("slippage"));
        spot.buyWithLimit(address(up), 10 * UNIT, 19 * UNIT, account);
        vm.stopPrank();
    }

    /// @dev Trend coins have no attention-implied price, so only owner trades reach them.
    function test_trendCoinsTradeOnlyAfterGraduationAndOnlyAtTheOwnersLimit() public {
        address coin = curve.createCurve("hantavirus");
        assertEq(spot.marketOf(coin), address(0), "still on its curve");
        fund(trader, 100_000 * UNIT);
        while (curve.curveOf(trend).state == BondingCurve.State.Open) {
            BondingCurve.Curve memory c = curve.curveOf(trend);
            vm.prank(trader);
            curve.buy(trend, (c.virtualQuote + c.reserve) / 12, 0, trader, block.timestamp);
        }
        address market = curve.graduate(trend);
        assertEq(spot.marketOf(coin), market);

        vm.startPrank(trader);
        vm.expectRevert(abi.encodeWithSelector(TrendrSpot.NoReferencePrice.selector, coin));
        spot.buy(coin, 10 * UNIT, 1, account);
        IERC20(coin).approve(address(spot), 1e18);
        vm.expectRevert(abi.encodeWithSelector(TrendrSpot.NoReferencePrice.selector, coin));
        spot.sell(coin, 1e18, 1, account);
        vm.stopPrank();
        vm.expectRevert(TrendrSpot.NotTradable.selector);
        spot.priceBand(coin);
    }

    /// @dev Whatever the router pays and wherever the index stands, a session sale that succeeds
    ///      paid at least the band's floor, and a purchase no more than its top.
    function testFuzz_sessionTradesStayInsideTheBand(uint256 price, uint64 index, bool isBuy) public {
        price = bound(price, 0.01e18, 0.99e18);
        index = uint64(bound(index, 10 * POINT, 80 * POINT));
        _setIndex(index);
        router.setSwap(price, 10_000);
        (, uint256 low, uint256 high) = spot.priceBand(address(up));
        uint256 amount = 10 * UNIT;
        vm.prank(trader);
        if (isBuy) {
            try spot.buy(address(up), amount, 1, account) returns (uint256 out) {
                assertLe(amount * 1e18 / out, high + 1e12, "paid at most the top");
            } catch {
                assertGt(price, high - 1e12, "refused only above the top");
            }
        } else {
            try spot.sell(address(up), amount, 1, account) returns (uint256 out) {
                assertGe(out * 1e18 / amount + 1e12, low, "received at least the floor");
            } catch {
                assertLt(price, low + 1e12, "refused only below the floor");
            }
        }
    }
}

/// @notice The session path end to end: a PasskeyAccount whose trading session may call TrendrSpot's
///         `buy` and `sell` (recipient pinned to the account), as the app's tradingPermissions grant.
contract TrendrSpotSessionTest is Fixture {
    uint256 internal constant EOA_PK = 0xE0A;
    uint256 internal constant SESSION_PK = 0x5E5;

    MockKuruRouter internal router;
    OutcomeListing internal listing;
    TrendrSpot internal spot;
    address internal account;
    address internal session;
    IERC20 internal up;

    function setUp() public override {
        super.setUp();
        router = new MockKuruRouter(false);
        listing = new OutcomeListing(IKuruRouter(address(router)), outcomes, false);
        spot = new TrendrSpot(IKuruRouter(address(router)), listing, curve);
        createTrend("hantavirus", ITrendRegistry.AssetClass.Topic, 40 * POINT);
        bytes32 sid = outcomes.openSeries("hantavirus", 1 days);
        up = IERC20(address(outcomes.seriesOf(sid).up));
        listing.list(sid);
        fund(address(this), 10_000 * UNIT);
        outcomes.mint(sid, 1000 * UNIT, address(router));
        ausd.mint(address(router), 1000 * UNIT);

        account = vm.addr(EOA_PK);
        session = vm.addr(SESSION_PK);
        vm.signAndAttachDelegation(address(new PasskeyAccount(IERC20(address(ausd)))), EOA_PK);
        (bool ok,) = account.call("");
        assertTrue(ok);
        outcomes.mint(sid, 100 * UNIT, account);

        PasskeyAccount.Permission[] memory perms = new PasskeyAccount.Permission[](3);
        perms[0] = PasskeyAccount.Permission({
            target: address(spot), selector: spot.buy.selector, recipientArg: 4, guard: address(0)
        });
        perms[1] = PasskeyAccount.Permission({
            target: address(spot), selector: spot.sell.selector, recipientArg: 4, guard: address(0)
        });
        perms[2] = PasskeyAccount.Permission({
            target: address(spot), selector: bytes4(0), recipientArg: 0, guard: address(0)
        });
        PasskeyAccount.SessionConfig memory cfg = PasskeyAccount.SessionConfig({
            key: session,
            validUntil: uint48(block.timestamp + 1 days),
            dailyLimit: uint128(100 * UNIT),
            permissions: perms
        });
        uint256 deadline = block.timestamp + 1 hours;
        bytes32 digest = PasskeyAccount(payable(account))
            .initializeDigest(bytes32(uint256(1)), bytes32(uint256(2)), cfg, deadline);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(EOA_PK, digest);
        PasskeyAccount(payable(account))
            .initialize(bytes32(uint256(1)), bytes32(uint256(2)), cfg, deadline, abi.encodePacked(r, s, v));
    }

    function _sell(bytes4 selector, uint256 amount, uint256 minOut)
        internal
        view
        returns (PasskeyAccount.Call[] memory calls)
    {
        calls = new PasskeyAccount.Call[](2);
        calls[0] =
            PasskeyAccount.Call(address(up), 0, abi.encodeCall(IERC20.approve, (address(spot), amount)));
        calls[1] = PasskeyAccount.Call(
            address(spot), 0, abi.encodeWithSelector(selector, address(up), amount, minOut, account)
        );
    }

    function _signed(PasskeyAccount.Call[] memory calls)
        internal
        view
        returns (uint256 deadline, bytes memory sig)
    {
        deadline = block.timestamp + 10 minutes;
        PasskeyAccount a = PasskeyAccount(payable(account));
        bytes32 digest = a.sessionExecuteDigest(calls, session, a.sessionOf(session).nonce, deadline);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(SESSION_PK, digest);
        sig = abi.encodePacked(r, s, v);
    }

    /// @dev M1: the thief rests a bid at the bottom of the book and signs a sale of everything the
    ///      account holds with a minimum of one unit. The band refuses it, and the session may not
    ///      reach the owner's unbanded entry point at all.
    function test_aStolenSessionCannotDumpTokensIntoTheThiefsBid() public {
        router.setSwap(0.01e18, 10_000);
        PasskeyAccount.Call[] memory calls = _sell(spot.sell.selector, 100 * UNIT, 1);
        (uint256 deadline, bytes memory sig) = _signed(calls);
        vm.expectRevert(
            abi.encodeWithSelector(
                PasskeyAccount.CallFailed.selector, 1, abi.encodeWithSignature("Error(string)", "slippage")
            )
        );
        PasskeyAccount(payable(account)).executeWithSession(calls, session, deadline, sig);

        calls = _sell(spot.sellWithLimit.selector, 100 * UNIT, 1);
        (deadline, sig) = _signed(calls);
        vm.expectRevert(abi.encodeWithSelector(PasskeyAccount.CallNotAllowed.selector, 1));
        PasskeyAccount(payable(account)).executeWithSession(calls, session, deadline, sig);
        assertEq(up.balanceOf(account), 100 * UNIT, "nothing left the account");

        // At a fair price the same session sells as before.
        router.setSwap(0.48e18, 10_000);
        calls = _sell(spot.sell.selector, 100 * UNIT, 1);
        (deadline, sig) = _signed(calls);
        PasskeyAccount(payable(account)).executeWithSession(calls, session, deadline, sig);
        assertEq(ausd.balanceOf(account), 48 * UNIT);
    }
}
