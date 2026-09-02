// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {ITrendRegistry} from "../../src/interfaces/ITrendRegistry.sol";
import {AttentionPerp} from "../../src/perp/AttentionPerp.sol";
import {Fixture} from "../utils/Fixture.sol";

contract AttentionPerpTest is Fixture {
    address internal alice = address(0xA1);
    address internal bob = address(0xB2);
    address internal keeper = address(0xCE);
    bytes32 internal trend;

    function setUp() public override {
        super.setUp();
        trend = createTrend("hantavirus", ITrendRegistry.AssetClass.Topic, 40 * POINT);
        fund(alice, 100_000 * UNIT);
        fund(bob, 100_000 * UNIT);
        fund(address(this), 1_000_000 * UNIT);
        perp.depositPool(20_000 * UNIT);
    }

    function _open(address who, bool isLong, uint256 margin, uint256 lev) internal returns (uint256 id) {
        vm.prank(who);
        id = perp.open(trend, isLong, margin, lev, isLong ? type(uint64).max : 0, block.timestamp);
    }

    function _assertSolvent() internal view {
        assertEq(ausd.balanceOf(address(perp)), perp.totalMargin() + perp.pool() + perp.protocolFees());
    }

    // --- opening --------------------------------------------------------------------------

    function test_openLongSizesAndFees() public {
        uint256 id = _open(alice, true, 1000 * UNIT, 3e18);
        AttentionPerp.Position memory p = perp.positionOf(id);
        // net = 1000 / (1 + 3 x 0.001) = 997.0089...
        assertApproxEqAbs(p.margin, 997_008_973, 1);
        // notional = 3 x net; qty = notional / index points
        assertApproxEqRel(p.qty, uint256(p.margin) * 3 * 1e18 / (40 * UNIT), 1e12);
        assertEq(p.entryIndex, 40 * POINT);
        (uint256 longQty,,,,,) = perp.markets(trend);
        assertEq(longQty, p.qty);
        // Curation share accrued to the surfacer.
        assertGt(curation.claimable(SURFACER), 0);
        _assertSolvent();
    }

    function test_openGuards() public {
        vm.startPrank(alice);
        vm.expectRevert(AttentionPerp.InvalidLeverage.selector);
        perp.open(trend, true, 100 * UNIT, 3e18 + 1, type(uint64).max, block.timestamp);
        vm.expectRevert(AttentionPerp.Expired.selector);
        perp.open(trend, true, 100 * UNIT, 2e18, type(uint64).max, block.timestamp - 1);
        vm.expectRevert(AttentionPerp.PriceNotAcceptable.selector);
        perp.open(trend, true, 100 * UNIT, 2e18, 39 * POINT, block.timestamp);
        vm.expectRevert(AttentionPerp.PriceNotAcceptable.selector);
        perp.open(trend, false, 100 * UNIT, 2e18, 41 * POINT, block.timestamp);
        vm.expectRevert(AttentionPerp.MarginTooSmall.selector);
        perp.open(trend, true, UNIT / 2, 2e18, type(uint64).max, block.timestamp);
        vm.expectRevert(AttentionPerp.TrendNotActive.selector);
        perp.open(keccak256("nope"), true, 100 * UNIT, 2e18, type(uint64).max, block.timestamp);
        vm.stopPrank();
        advance(11 minutes);
        vm.prank(alice);
        vm.expectRevert(AttentionPerp.IndexStale.selector);
        perp.open(trend, true, 100 * UNIT, 2e18, type(uint64).max, block.timestamp);
    }

    function test_openInterestCapScalesWithPoolAndAttention() public {
        // pool 20k, index 40 >= reference -> cap = 5 x 20k = 100k per side.
        assertEq(perp.openInterestCap(40 * POINT), 100_000 * UNIT);
        // Below the reference index the cap scales down, never below 20%.
        assertEq(perp.openInterestCap(5 * POINT), 20_000 * UNIT);
        assertEq(perp.openInterestCap(1 * POINT), 20_000 * UNIT);
        _open(alice, true, 30_000 * UNIT, 3e18);
        vm.prank(bob);
        vm.expectRevert(AttentionPerp.OpenInterestCap.selector);
        perp.open(trend, true, 5000 * UNIT, 3e18, type(uint64).max, block.timestamp);
        // The other side is independent.
        _open(bob, false, 5000 * UNIT, 3e18);
    }

    // --- closing --------------------------------------------------------------------------

    function test_closeWithProfit() public {
        uint256 id = _open(alice, true, 1000 * UNIT, 2e18);
        AttentionPerp.Position memory p = perp.positionOf(id);
        advance(60);
        pushIndex(trend, 50 * POINT);
        (,, int256 funding,) = perp.positionState(id);
        assertGt(funding, 0); // a lone long pays the crowding tax to the pool
        uint256 before = ausd.balanceOf(alice);
        vm.prank(alice);
        uint256 payout = perp.close(id, 0, block.timestamp);
        // pnl = qty x 10 points = notional x 25%
        uint256 pnl = p.qty * 10 * UNIT / 1e18;
        uint256 exitFee = (p.qty * 50 * UNIT / 1e18) / 1000;
        assertApproxEqAbs(payout, p.margin + pnl - exitFee - uint256(funding), 2);
        assertEq(ausd.balanceOf(alice) - before, payout);
        _assertSolvent();
    }

    function test_closeWithLoss() public {
        uint256 id = _open(alice, false, 1000 * UNIT, 2e18);
        advance(60);
        pushIndex(trend, 44 * POINT);
        vm.prank(alice);
        uint256 payout = perp.close(id, type(uint64).max, block.timestamp);
        assertLt(payout, 997 * UNIT);
        assertGt(perp.pool(), 20_000 * UNIT);
        _assertSolvent();
    }

    function test_closeGuards() public {
        uint256 id = _open(alice, true, 1000 * UNIT, 2e18);
        vm.prank(bob);
        vm.expectRevert(AttentionPerp.NotOwner.selector);
        perp.close(id, 0, block.timestamp);
        vm.prank(alice);
        vm.expectRevert(AttentionPerp.PriceNotAcceptable.selector);
        perp.close(id, 41 * POINT, block.timestamp);
        vm.prank(alice);
        vm.expectRevert(AttentionPerp.UnknownPosition.selector);
        perp.close(999, 0, block.timestamp);
    }

    /// @notice A stale index is never traded against: closing and liquidating wait for a fresh
    ///         observation, and a trend left stale long enough retires and settles instead.
    function test_staleIndexBlocksCloseAndLiquidation() public {
        uint256 id = _open(alice, true, 1000 * UNIT, 3e18);
        advance(11 minutes); // past the 10 minute staleness limit
        vm.prank(alice);
        vm.expectRevert(AttentionPerp.IndexStale.selector);
        perp.close(id, 0, vm.getBlockTimestamp());
        vm.expectRevert(AttentionPerp.IndexStale.selector);
        perp.liquidate(id);

        // The oracle never comes back: after the stale-retire window anyone retires the trend
        // and the position settles at its final index.
        advance(2 hours);
        registry.pokeLifecycle(trend);
        vm.expectRevert(AttentionPerp.TrendRetired.selector);
        perp.liquidate(id);
        uint256 before = ausd.balanceOf(alice);
        uint256 payout = perp.settleRetired(id);
        assertEq(ausd.balanceOf(alice) - before, payout);
        assertGt(payout, 900 * UNIT);
        _assertSolvent();
    }

    function test_openForAnotherOwner() public {
        uint256 before = ausd.balanceOf(bob);
        vm.prank(bob);
        uint256 id = perp.openFor(alice, trend, true, 500 * UNIT, 2e18, type(uint64).max, block.timestamp);
        assertEq(perp.positionOf(id).owner, alice);
        assertEq(before - ausd.balanceOf(bob), 500 * UNIT, "payer charged");
        vm.prank(bob);
        vm.expectRevert(AttentionPerp.NotOwner.selector);
        perp.close(id, 0, block.timestamp);
        uint256 aliceBefore = ausd.balanceOf(alice);
        vm.prank(alice);
        uint256 payout = perp.close(id, 0, block.timestamp);
        assertEq(ausd.balanceOf(alice) - aliceBefore, payout);
        vm.expectRevert(AttentionPerp.ZeroAddress.selector);
        perp.openFor(address(0), trend, true, 500 * UNIT, 2e18, type(uint64).max, block.timestamp);
        _assertSolvent();
    }

    function test_addMargin() public {
        uint256 id = _open(alice, true, 1000 * UNIT, 3e18);
        uint256 m = perp.positionOf(id).margin;
        vm.prank(alice);
        perp.addMargin(id, 100 * UNIT);
        assertEq(perp.positionOf(id).margin, m + 100 * UNIT);
        _assertSolvent();
    }

    /// @dev Only the owner tops up: otherwise a capped session key could move an account's
    ///      collateral into a position someone else owns and closes.
    function test_addMarginOnlyOwner() public {
        uint256 id = _open(alice, true, 1000 * UNIT, 3e18);
        vm.prank(bob);
        vm.expectRevert(AttentionPerp.NotOwner.selector);
        perp.addMargin(id, 100 * UNIT);
    }

    // --- funding --------------------------------------------------------------------------

    function test_fundingOneSidedPaysPool() public {
        uint256 id = _open(alice, true, 1000 * UNIT, 3e18);
        assertEq(perp.fundingRatePerBlock(trend), int256(perp.MAX_FUNDING_RATE_PER_BLOCK()));
        vm.roll(vm.getBlockNumber() + 10_000);
        perp.poke(trend);
        (,, int256 funding,) = perp.positionState(id);
        AttentionPerp.Position memory p = perp.positionOf(id);
        // 10k blocks x 2e-7 x notional(3 x 997 at index 40)
        uint256 notional = p.qty * 40 * UNIT / 1e18;
        assertApproxEqRel(uint256(funding), notional * 2 * 10_000 / 1e7, 1e14);
        _assertSolvent();
    }

    function test_fundingFlowsFromCrowdedSide() public {
        uint256 l = _open(alice, true, 3000 * UNIT, 3e18);
        uint256 s = _open(bob, false, 1000 * UNIT, 3e18);
        assertGt(perp.fundingRatePerBlock(trend), 0);
        vm.roll(vm.getBlockNumber() + 5000);
        (,, int256 longFunding,) = perp.positionState(l);
        (,, int256 shortFunding,) = perp.positionState(s);
        assertGt(longFunding, 0);
        assertLt(shortFunding, 0);
        // Conservation: what shorts receive never exceeds what longs pay.
        assertGe(longFunding, -shortFunding);
        assertApproxEqRel(uint256(longFunding), uint256(-shortFunding), 1e15);
    }

    function test_balancedBookHasNoFunding() public {
        _open(alice, true, 1000 * UNIT, 2e18);
        _open(bob, false, 1000 * UNIT, 2e18);
        assertEq(perp.fundingRatePerBlock(trend), 0);
    }

    // --- liquidation ----------------------------------------------------------------------

    function test_liquidation() public {
        uint256 id = _open(alice, true, 1000 * UNIT, 3e18);
        vm.prank(keeper);
        vm.expectRevert(AttentionPerp.NotLiquidatable.selector);
        perp.liquidate(id);
        advance(60);
        pushIndex(trend, 30 * POINT); // -25% at 3x: equity ~25% < 10%? not yet
        advance(60);
        pushIndex(trend, 28 * POINT); // -30%: equity ~10% of margin, below 10% of notional
        vm.prank(keeper);
        uint256 reward = perp.liquidate(id);
        assertGt(reward, 0);
        assertEq(ausd.balanceOf(keeper), reward);
        assertEq(perp.totalMargin(), 0);
        _assertSolvent();
    }

    function test_badDebtAbsorbedByPool() public {
        uint256 id = _open(alice, true, 1000 * UNIT, 3e18);
        uint256 margin = perp.positionOf(id).margin;
        for (uint256 i; i < 3; ++i) {
            advance(60);
            pushIndex(trend, registry.trendOf(trend).index / 2);
        }
        (int256 equity,,,) = perp.positionState(id);
        assertLt(equity, 0);
        uint256 poolBefore = perp.pool();
        vm.prank(keeper);
        uint256 reward = perp.liquidate(id);
        assertEq(reward, 0);
        // The pool keeps the margin and carries the shortfall: nobody else's margin is touched.
        assertEq(perp.pool(), poolBefore + margin);
        _assertSolvent();
    }

    // --- socialized loss ------------------------------------------------------------------

    function test_socializedLossCapsWinner() public {
        // A fresh perp with a tiny pool: a winner larger than the pool is paid only what the pool holds.
        AttentionPerp small = new AttentionPerp(ausd, registry, curation, TREASURY, 1000 * UNIT);
        ausd.approve(address(small), type(uint256).max);
        small.depositPool(200 * UNIT);
        vm.startPrank(alice);
        ausd.approve(address(small), type(uint256).max);
        uint256 id = small.open(trend, true, 300 * UNIT, 3e18, type(uint64).max, block.timestamp);
        vm.stopPrank();
        for (uint256 i; i < 2; ++i) {
            advance(60);
            pushIndex(trend, registry.trendOf(trend).index * 3 / 2);
        }
        uint256 margin = small.positionOf(id).margin;
        uint256 poolBefore = small.pool();
        vm.prank(alice);
        vm.expectEmit(true, false, false, false);
        emit AttentionPerp.SocializedLoss(id, 0);
        uint256 payout = small.close(id, 0, block.timestamp);
        assertLe(payout, margin + poolBefore);
        assertEq(ausd.balanceOf(address(small)), small.totalMargin() + small.pool() + small.protocolFees());
    }

    /// @notice A winner whose exit fee exceeds the whole pool can still close: the fee is capped
    ///         at what the pool holds and the rest of the payout is socialized.
    function test_closeWhenFeeExceedsPool() public {
        bytes32 moon = createTrend("moonshot", ITrendRegistry.AssetClass.Topic, 10_000); // 0.01 points
        vm.prank(alice);
        uint256 id = perp.open(moon, true, 5000 * UNIT, 3e18, type(uint64).max, block.timestamp);
        for (uint256 i; i < 30; ++i) {
            advance(1);
            (uint64 index,) = registry.indexOf(moon);
            pushIndex(moon, index * 3 / 2 > 1000 * POINT ? 1000 * POINT : index * 3 / 2);
        }
        uint256 available = perp.pool() + perp.positionOf(id).margin;
        uint256 curationBefore = curation.totalAccrued();
        uint256 feesBefore = perp.protocolFees();
        uint256 before = ausd.balanceOf(alice);
        vm.prank(alice);
        uint256 payout = perp.close(id, 0, block.timestamp);
        // The winner takes everything the pool held; no fee is skimmed from a shortfall.
        assertEq(payout, available);
        assertEq(ausd.balanceOf(alice) - before, payout);
        assertEq(perp.pool(), 0);
        assertEq(curation.totalAccrued(), curationBefore);
        assertEq(perp.protocolFees(), feesBefore);
        _assertSolvent();
    }

    // --- retirement -----------------------------------------------------------------------

    function test_retiredTrendSettlesAtFinalIndexWithoutFee() public {
        uint256 id = _open(alice, true, 1000 * UNIT, 2e18);
        uint256 margin = perp.positionOf(id).margin;
        advance(2 hours);
        registry.pokeLifecycle(trend);
        vm.prank(alice);
        vm.expectRevert(AttentionPerp.TrendRetired.selector);
        perp.close(id, 0, block.timestamp);
        uint256 before = ausd.balanceOf(alice);
        vm.prank(keeper);
        uint256 payout = perp.settleRetired(id);
        assertEq(ausd.balanceOf(alice) - before, payout);
        // Final index equals entry: payout is margin minus funding accrued before retirement.
        assertLe(payout, margin);
        assertGt(payout, margin * 99 / 100);
        _assertSolvent();
    }

    function test_settleRetiredRequiresRetired() public {
        uint256 id = _open(alice, true, 1000 * UNIT, 2e18);
        vm.expectRevert(AttentionPerp.TrendNotRetired.selector);
        perp.settleRetired(id);
    }

    // --- fees -----------------------------------------------------------------------------

    function test_sweepProtocolFees() public {
        _open(alice, true, 1000 * UNIT, 3e18);
        uint256 fees = perp.protocolFees();
        assertGt(fees, 0);
        perp.sweepProtocolFees();
        assertEq(ausd.balanceOf(TREASURY), fees);
        assertEq(perp.protocolFees(), 0);
        vm.expectRevert(AttentionPerp.ZeroAmount.selector);
        perp.sweepProtocolFees();
    }

    function testFuzz_openCloseKeepsBalanceIdentity(uint96 margin, uint64 lev, uint64 exitPoints, bool isLong)
        public
    {
        margin = uint96(bound(margin, 2 * UNIT, 20_000 * UNIT));
        lev = uint64(bound(lev, 1e17, 3e18));
        uint64 exitIndex = uint64(bound(exitPoints, 21, 59)) * POINT;
        uint256 id = _open(alice, isLong, margin, lev);
        advance(60);
        pushIndex(trend, exitIndex);
        vm.prank(alice);
        perp.close(id, isLong ? 0 : type(uint64).max, block.timestamp);
        _assertSolvent();
        assertEq(perp.totalMargin(), 0);
    }
}
