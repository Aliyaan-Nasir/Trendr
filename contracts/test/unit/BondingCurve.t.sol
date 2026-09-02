// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {BondingCurve} from "../../src/curve/BondingCurve.sol";
import {TrendCoin} from "../../src/curve/TrendCoin.sol";
import {ITrendRegistry} from "../../src/interfaces/ITrendRegistry.sol";
import {Fixture} from "../utils/Fixture.sol";

contract BondingCurveTest is Fixture {
    address internal alice = address(0xA1);
    address internal bob = address(0xB2);
    bytes32 internal trend;
    TrendCoin internal coin;
    uint256 internal constant T = 1_000_000_000e18;

    function setUp() public override {
        super.setUp();
        trend = createTrend("hantavirus", ITrendRegistry.AssetClass.Topic, 40 * POINT);
        coin = TrendCoin(curve.createCurve("hantavirus"));
        fund(alice, 1_000_000 * UNIT);
        fund(bob, 1_000_000 * UNIT);
    }

    function _buy(address who, uint256 amount) internal returns (uint256 out) {
        vm.prank(who);
        out = curve.buy(trend, amount, 0, who, block.timestamp);
    }

    function _sell(address who, uint256 amount) internal returns (uint256 out) {
        vm.prank(who);
        out = curve.sell(trend, amount, 0, who, block.timestamp);
    }

    function _assertSolvent() internal view {
        BondingCurve.Curve memory c = curve.curveOf(trend);
        // Selling every outstanding coin back never pays more than the reserve.
        assertGe(c.reserve * (T - c.sold), c.virtualQuote * c.sold);
        assertGe(
            ausd.balanceOf(address(curve)),
            c.reserve + c.floorReserve + c.graduationLiquidity + curve.protocolFees()
        );
    }

    function test_createCurve() public view {
        assertEq(coin.name(), "Trendr hantavirus");
        assertEq(coin.symbol(), "TRND-HANTAVIRUS");
        assertEq(coin.curve(), address(curve));
        BondingCurve.Curve memory c = curve.curveOf(trend);
        assertEq(uint8(c.state), uint8(BondingCurve.State.Open));
        assertEq(c.virtualQuote, 2000 * UNIT);
        assertEq(c.peakAtCreation, 40 * POINT);
    }

    function test_createCurveGuards() public {
        vm.expectRevert(BondingCurve.CurveExists.selector);
        curve.createCurve("hantavirus");
        vm.expectRevert(BondingCurve.TrendNotActive.selector);
        curve.createCurve("nope");
    }

    function test_buyFollowsConstantProduct() public {
        uint256 out = _buy(alice, 100 * UNIT);
        uint256 net = 99 * UNIT;
        uint256 expected = T - (2000 * UNIT * T + 2000 * UNIT + net - 1) / (2000 * UNIT + net);
        assertEq(out, expected);
        assertEq(coin.balanceOf(alice), out);
        BondingCurve.Curve memory c = curve.curveOf(trend);
        assertEq(c.reserve, net);
        assertEq(c.floorReserve, UNIT * 30 / 100);
        assertEq(c.graduationLiquidity, UNIT * 30 / 100);
        assertEq(curation.claimable(SURFACER), UNIT / 10);
        assertEq(curve.protocolFees(), UNIT * 30 / 100);
        _assertSolvent();
    }

    function test_sellReturnsAtMostReserve() public {
        uint256 out = _buy(alice, 100 * UNIT);
        uint256 quoteOut = _sell(alice, out);
        BondingCurve.Curve memory c = curve.curveOf(trend);
        assertEq(c.sold, 0);
        assertLe(quoteOut, 99 * UNIT);
        assertGt(quoteOut, 97 * UNIT); // two 1% fees
        _assertSolvent();
    }

    function test_guards() public {
        vm.startPrank(alice);
        vm.expectRevert(BondingCurve.Expired.selector);
        curve.buy(trend, 100 * UNIT, 0, alice, block.timestamp - 1);
        vm.expectRevert(BondingCurve.Slippage.selector);
        curve.buy(trend, 100 * UNIT, type(uint256).max, alice, block.timestamp);
        vm.expectRevert(BondingCurve.PriceImpact.selector);
        curve.buy(trend, 300 * UNIT, 0, alice, block.timestamp);
        vm.expectRevert(BondingCurve.ZeroAmount.selector);
        curve.buy(trend, 0, 0, alice, block.timestamp);
        vm.expectRevert(BondingCurve.UnknownCurve.selector);
        curve.buy(keccak256("nope"), 1, 0, alice, block.timestamp);
        vm.stopPrank();
    }

    function test_quotesMatchExecution() public {
        (uint256 coinsOut,) = curve.quoteBuy(trend, 50 * UNIT);
        assertEq(_buy(alice, 50 * UNIT), coinsOut);
        (uint256 quoteOut,) = curve.quoteSell(trend, coinsOut / 2);
        assertEq(_sell(alice, coinsOut / 2), quoteOut);
    }

    // --- attention floor ------------------------------------------------------------------

    function test_floorRisesWithPeakAttentionAndStaysSolvent() public {
        for (uint256 i; i < 10; ++i) {
            _buy(alice, 150 * UNIT);
        }
        uint256 priceBefore = curve.spotPrice(trend);
        uint256 vqBefore = curve.curveOf(trend).virtualQuote;
        advance(60);
        pushIndex(trend, 50 * POINT); // +10 points of peak: target ratchet 1.5x
        assertEq(curve.ratchetBps(trend), 15_000);
        curve.syncFloor(trend);
        BondingCurve.Curve memory c = curve.curveOf(trend);
        assertGt(c.virtualQuote, vqBefore);
        assertGt(curve.spotPrice(trend), priceBefore);
        _assertSolvent();

        // Attention falling never lowers the floor.
        advance(60);
        pushIndex(trend, 30 * POINT);
        curve.syncFloor(trend);
        assertEq(curve.curveOf(trend).virtualQuote, c.virtualQuote);
    }

    function test_floorRaiseLimitedByFloorReserve() public {
        _buy(alice, 100 * UNIT);
        advance(60);
        pushIndex(trend, 60 * POINT);
        BondingCurve.Curve memory before = curve.curveOf(trend);
        curve.syncFloor(trend);
        BondingCurve.Curve memory c = curve.curveOf(trend);
        // Target is 2x, but the tiny floor reserve pays for only a small raise.
        assertLt(c.virtualQuote, 4000 * UNIT);
        assertGt(c.virtualQuote, before.virtualQuote);
        assertEq(c.reserve - before.reserve, before.floorReserve - c.floorReserve);
        _assertSolvent();
    }

    function test_floorRaiseIsFreeWithNoHolders() public {
        advance(60);
        pushIndex(trend, 60 * POINT);
        curve.syncFloor(trend);
        assertEq(curve.curveOf(trend).virtualQuote, 4000 * UNIT);
    }

    function test_ratchetCapsAtFiveX() public {
        for (uint256 i; i < 6; ++i) {
            advance(60);
            pushIndex(trend, registry.trendOf(trend).index * 3 / 2);
        }
        assertEq(curve.ratchetBps(trend), 50_000);
    }

    // --- graduation -----------------------------------------------------------------------

    function _fill() internal {
        while (curve.curveOf(trend).state == BondingCurve.State.Open) {
            BondingCurve.Curve memory c = curve.curveOf(trend);
            _buy(alice, (c.virtualQuote + c.reserve) / 12);
        }
    }

    function test_graduationMovesExactlyTheReserves() public {
        _fill();
        BondingCurve.Curve memory c = curve.curveOf(trend);
        assertEq(uint8(c.state), uint8(BondingCurve.State.Ready));
        vm.prank(alice);
        vm.expectRevert(BondingCurve.CurveClosed.selector);
        curve.buy(trend, UNIT, 0, alice, block.timestamp);

        uint256 quoteAmount = c.reserve + c.floorReserve + c.graduationLiquidity;
        uint256 curveBalance = ausd.balanceOf(address(curve));
        uint256 spot = curve.spotPrice(trend);
        address market = curve.graduate(trend);

        assertEq(venue.listings(), 1);
        assertEq(venue.lastQuoteAmount(), quoteAmount);
        assertEq(ausd.balanceOf(address(venue)), quoteAmount);
        assertEq(curveBalance - ausd.balanceOf(address(curve)), quoteAmount);
        assertEq(ausd.balanceOf(address(curve)), curve.protocolFees());
        // Seeded at the curve's final spot price.
        assertApproxEqRel(venue.lastQuoteAmount() * 1e36 / venue.lastBaseAmount(), spot, 1e12);

        BondingCurve.Curve memory g = curve.curveOf(trend);
        assertEq(uint8(g.state), uint8(BondingCurve.State.Graduated));
        assertEq(g.market, market);
        assertEq(g.reserve + g.floorReserve + g.graduationLiquidity, 0);

        // Idempotent: a second call changes nothing.
        assertEq(curve.graduate(trend), market);
        assertEq(venue.listings(), 1);
    }

    function test_readyCurveStillSellsAndReopensBelowTheReserve() public {
        _fill();
        uint256 chunk = coin.balanceOf(alice) / 50;
        for (uint256 i; i < 10 && curve.curveOf(trend).state == BondingCurve.State.Ready; ++i) {
            vm.prank(alice);
            curve.sell(trend, chunk, 0, alice, block.timestamp);
        }
        BondingCurve.Curve memory c = curve.curveOf(trend);
        assertEq(uint8(c.state), uint8(BondingCurve.State.Open), "a sale below the reserve reopens the curve");
        assertLt(c.reserve, curve.graduationReserve());
    }

    function test_graduateRequiresReady() public {
        vm.expectRevert(BondingCurve.NotReady.selector);
        curve.graduate(trend);
    }

    function testFuzz_tradesStaySolvent(uint256 seed) public {
        for (uint256 i; i < 12; ++i) {
            seed = uint256(keccak256(abi.encode(seed, i)));
            BondingCurve.Curve memory c = curve.curveOf(trend);
            if (c.state != BondingCurve.State.Open) break;
            if (seed % 3 == 0 && coin.balanceOf(alice) > 0) {
                uint256 chunk = bound(seed, 1, coin.balanceOf(alice));
                uint256 maxChunk = (T - c.sold) / 12;
                if (chunk > maxChunk) chunk = maxChunk;
                (uint256 q,) = curve.quoteSell(trend, chunk);
                if (q > 0) _sell(alice, chunk);
            } else {
                _buy(alice, bound(seed, UNIT, (c.virtualQuote + c.reserve) / 12));
            }
            if (seed % 5 == 0) {
                advance(60);
                pushIndex(trend, uint64(bound(seed, 20, 60)) * POINT);
            }
            _assertSolvent();
        }
        // Everyone can always exit: selling all coins succeeds while the curve is open.
        if (curve.curveOf(trend).state == BondingCurve.State.Open && coin.balanceOf(alice) > 0) {
            uint256 bal = coin.balanceOf(alice);
            while (bal > 0) {
                BondingCurve.Curve memory c = curve.curveOf(trend);
                uint256 chunk = bal;
                // Respect the price-impact limit by selling in slices.
                uint256 maxChunk = (T - c.sold) / 12;
                if (chunk > maxChunk) chunk = maxChunk;
                (uint256 q,) = curve.quoteSell(trend, chunk);
                if (q == 0) break; // dust worth nothing
                _sell(alice, chunk);
                bal -= chunk;
            }
            assertLe(curve.curveOf(trend).sold, 1e12);
            _assertSolvent();
        }
    }
}
