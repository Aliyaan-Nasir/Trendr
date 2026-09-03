// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {BondingCurve} from "../../src/curve/BondingCurve.sol";
import {ITrendRegistry} from "../../src/interfaces/ITrendRegistry.sol";
import {IKuruRouter} from "../../src/interfaces/kuru/IKuru.sol";
import {TrendrLens} from "../../src/lens/TrendrLens.sol";
import {OutcomeListing} from "../../src/outcome/OutcomeListing.sol";
import {OutcomeMarkets} from "../../src/outcome/OutcomeMarkets.sol";
import {AttentionPerp} from "../../src/perp/AttentionPerp.sol";
import {MockKuruRouter} from "../mocks/MockKuru.sol";
import {Fixture} from "../utils/Fixture.sol";

contract TrendrLensTest is Fixture {
    TrendrLens internal lens;
    OutcomeListing internal listing;
    address internal alice = address(0xA1);

    function setUp() public override {
        super.setUp();
        listing = new OutcomeListing(IKuruRouter(address(new MockKuruRouter(false))), outcomes, false);
        lens = _lens(outcomes, listing);
        fund(alice, 1_000_000 * UNIT);
        fund(address(this), 1_000_000 * UNIT);
        perp.depositPool(50_000 * UNIT);
    }

    function _lens(OutcomeMarkets o, OutcomeListing l) internal returns (TrendrLens) {
        return new TrendrLens(registry, o, l, perp, curve);
    }

    function test_snapshotSkipsRetiredAndPaginates() public {
        bytes32 a = createTrend("alpha", ITrendRegistry.AssetClass.Topic, 40 * POINT);
        createTrend("beta", ITrendRegistry.AssetClass.Person, 20 * POINT);
        bytes32 c = createTrend("gamma", ITrendRegistry.AssetClass.Topic, 30 * POINT);
        // beta goes stale and is retired; alpha and gamma stay fresh.
        advance(1 hours);
        pushIndex(a, 41 * POINT);
        pushIndex(c, 31 * POINT);
        advance(1 hours + 1);
        pushIndex(a, 42 * POINT);
        pushIndex(c, 32 * POINT);
        registry.pokeLifecycle(keccak256("beta"));

        (uint64 lastRunId, uint256 total, uint256 next, TrendrLens.OracleTrend[] memory live) =
            lens.oracleSnapshot(0, 10, 10);
        assertEq(lastRunId, registry.lastRunId());
        assertEq(total, 3);
        assertEq(next, 3);
        assertEq(live.length, 2);
        assertEq(live[0].id, a);
        assertEq(live[0].index, 42 * POINT);
        assertEq(live[1].id, c);
        assertEq(live[1].assetClass, uint8(ITrendRegistry.AssetClass.Topic));

        // One result per page: the cursor walks past the retired trend.
        (,, next, live) = lens.oracleSnapshot(0, 10, 1);
        assertEq(next, 1);
        assertEq(live[0].id, a);
        (,, next, live) = lens.oracleSnapshot(next, 10, 1);
        assertEq(next, 3);
        assertEq(live[0].id, c);
        (,, next, live) = lens.oracleSnapshot(0, 2, 10);
        assertEq(next, 2, "scan limit bounds the walk");
        assertEq(live.length, 1);
    }

    function test_expiriesTrackSeriesAndSettlement() public {
        bytes32 id = createTrend("alpha", ITrendRegistry.AssetClass.Topic, 40 * POINT);
        bytes32 sid = outcomes.openSeries("alpha", 1 days);
        uint64 expiry = outcomes.seriesOf(sid).expiry;
        (,,, TrendrLens.OracleTrend[] memory live) = lens.oracleSnapshot(0, 10, 10);
        assertEq(live[0].nextExpiry, expiry);
        assertEq(live[0].pendingExpiry, 0);

        // Past expiry with no observation yet: pending.
        vm.warp(expiry + 1);
        (,,, live) = lens.oracleSnapshot(0, 10, 10);
        assertEq(live[0].pendingExpiry, expiry);
        assertEq(live[0].nextExpiry, 0);

        // An observation within the tolerance finalizes it.
        pushIndex(id, 44 * POINT);
        (,,, live) = lens.oracleSnapshot(0, 10, 10);
        assertEq(live[0].pendingExpiry, 0);
    }

    function test_identifiersAndStatuses() public {
        bytes32 a = createTrend("alpha", ITrendRegistry.AssetClass.Topic, 40 * POINT);
        bytes32[] memory ids = new bytes32[](2);
        ids[0] = a;
        ids[1] = keccak256("unknown");
        string[] memory names = lens.identifiers(ids);
        assertEq(names[0], "alpha");
        assertEq(names[1], "");
        uint8[] memory st = lens.statuses(ids);
        assertEq(st[0], uint8(ITrendRegistry.Status.Active));
        assertEq(st[1], uint8(ITrendRegistry.Status.None));
        assertEq(registry.identifierOf(a), "alpha");
        assertEq(registry.trendIdAt(0), a);
    }

    function test_constructorRejectsZero() public {
        vm.expectRevert(TrendrLens.ZeroAddress.selector);
        new TrendrLens(registry, OutcomeMarkets(address(0)), listing, perp, curve);
        vm.expectRevert(TrendrLens.ZeroAddress.selector);
        new TrendrLens(registry, outcomes, OutcomeListing(address(0)), perp, curve);
    }

    function test_expiriesIncludeTheTestWindow() public {
        OutcomeMarkets fast = new OutcomeMarkets(ausd, ITrendRegistry(address(registry)), 15 minutes);
        TrendrLens fastLens =
            _lens(fast, new OutcomeListing(IKuruRouter(address(new MockKuruRouter(false))), fast, false));
        createTrend("alpha", ITrendRegistry.AssetClass.Topic, 40 * POINT);
        fast.openSeries("alpha", 1 days);
        bytes32 short = fast.openSeries("alpha", 15 minutes);
        (,,, TrendrLens.OracleTrend[] memory live) = fastLens.oracleSnapshot(0, 10, 10);
        assertEq(live[0].nextExpiry, fast.seriesOf(short).expiry, "the 15 minute series expires first");
    }

    // --- keeper views ---------------------------------------------------------------------

    function test_seriesViewFollowsTheSeriesAndItsMarkets() public {
        bytes32 t = createTrend("alpha", ITrendRegistry.AssetClass.Topic, 40 * POINT);
        bytes32[] memory ids = new bytes32[](1);
        ids[0] = t;
        TrendrLens.SeriesView[] memory v = lens.series(ids);
        assertEq(v.length, 2, "one entry per window");
        assertEq(v[0].seriesId, bytes32(0));

        bytes32 sid = outcomes.openSeries("alpha", 1 days);
        v = lens.series(ids);
        assertEq(v[0].seriesId, sid);
        assertEq(v[0].window, 1 days);
        assertEq(v[0].openingIndex, 40 * POINT);
        assertFalse(v[0].listed);
        assertFalse(v[0].settleable);
        assertEq(v[1].window, 7 days);
        assertEq(v[1].seriesId, bytes32(0));

        (address upMarket, address downMarket) = listing.list(sid);
        v = lens.series(ids);
        assertTrue(v[0].listed);
        assertEq(v[0].upMarket, upMarket);
        assertEq(v[0].downMarket, downMarket);

        // Expired but not yet observed, then observed: settleable.
        advance(1 days);
        assertFalse(lens.series(ids)[0].settleable);
        pushIndex(t, 44 * POINT);
        assertTrue(lens.series(ids)[0].settleable);
        outcomes.settle(sid);
        v = lens.series(ids);
        assertFalse(v[0].settleable);
        assertEq(v[0].outcome, uint8(OutcomeMarkets.Outcome.Up));
    }

    function test_seriesViewTurnsSettleableAtTheVoidGrace() public {
        bytes32 t = createTrend("alpha", ITrendRegistry.AssetClass.Topic, 40 * POINT);
        outcomes.openSeries("alpha", 1 days);
        bytes32[] memory ids = new bytes32[](1);
        ids[0] = t;
        // No observation lands within the tolerance after expiry.
        advance(1 days + 1 hours);
        pushIndex(t, 41 * POINT);
        assertFalse(lens.series(ids)[0].settleable);
        advance(outcomes.VOID_GRACE());
        assertTrue(lens.series(ids)[0].settleable);
    }

    function _open(bytes32 t, bool isLong, uint256 lev) internal returns (uint256) {
        vm.prank(alice);
        return perp.open(t, isLong, 1000 * UNIT, lev, isLong ? type(uint64).max : 0, block.timestamp);
    }

    function test_positionsPaginateOverOpenPositions() public {
        bytes32 t = createTrend("alpha", ITrendRegistry.AssetClass.Topic, 40 * POINT);
        uint256 a = _open(t, true, 2e18);
        uint256 b = _open(t, false, 2e18);
        uint256 c = _open(t, true, 1e18);
        vm.prank(alice);
        perp.close(b, type(uint64).max, block.timestamp);

        (TrendrLens.PositionView[] memory open, uint256 next) = lens.positions(0, 2);
        assertEq(open.length, 1);
        assertEq(open[0].id, a);
        assertEq(next, 2);
        (open, next) = lens.positions(next, 10);
        assertEq(open.length, 1);
        assertEq(open[0].id, c);
        assertEq(next, perp.nextPositionId());
        assertEq(open[0].owner, alice);
        assertEq(open[0].index, 40 * POINT);
        assertFalse(open[0].liquidatable);
        (open,) = lens.positions(next, 10);
        assertEq(open.length, 0);
    }

    /// @dev The lens flags a position exactly when `liquidate` succeeds.
    function testFuzz_liquidatableMatchesLiquidate(uint64 to, bool isLong, uint256 blocks) public {
        bytes32 t = createTrend("alpha", ITrendRegistry.AssetClass.Topic, 40 * POINT);
        uint256 id = _open(t, isLong, 3e18);
        // A crowded side pays funding as blocks pass.
        _open(t, isLong, 3e18);
        blocks = bound(blocks, 0, 200_000);
        to = uint64(bound(to, 20 * POINT, 60 * POINT));
        vm.roll(vm.getBlockNumber() + blocks);
        advance(30);
        pushIndex(t, to);

        (TrendrLens.PositionView[] memory open,) = lens.positions(id, 1);
        bool flagged = open[0].liquidatable;
        uint256 snap = vm.snapshotState();
        bool liquidated;
        try perp.liquidate(id) {
            liquidated = true;
        } catch {}
        vm.revertToState(snap);
        assertEq(flagged, liquidated);
    }

    function test_retiredPositionsAreSettleableNotLiquidatable() public {
        bytes32 t = createTrend("alpha", ITrendRegistry.AssetClass.Topic, 40 * POINT);
        uint256 id = _open(t, true, 3e18);
        advance(registry.staleRetireWindow());
        registry.pokeLifecycle(t);
        (TrendrLens.PositionView[] memory open,) = lens.positions(id, 1);
        assertTrue(open[0].retired);
        assertFalse(open[0].liquidatable);
    }

    function test_readyCurves() public {
        bytes32 t = createTrend("alpha", ITrendRegistry.AssetClass.Topic, 40 * POINT);
        bytes32 u = createTrend("beta", ITrendRegistry.AssetClass.Topic, 40 * POINT);
        curve.createCurve("alpha");
        curve.createCurve("beta");
        bytes32[] memory ids = new bytes32[](3);
        ids[0] = t;
        ids[1] = u;
        ids[2] = keccak256("no curve");
        assertEq(lens.readyCurves(ids).length, 0);
        while (curve.curveOf(u).state == BondingCurve.State.Open) {
            BondingCurve.Curve memory c = curve.curveOf(u);
            vm.prank(alice);
            curve.buy(u, (c.virtualQuote + c.reserve) / 12, 0, alice, block.timestamp);
        }
        bytes32[] memory ready = lens.readyCurves(ids);
        assertEq(ready.length, 1);
        assertEq(ready[0], u);
        curve.graduate(u);
        assertEq(lens.readyCurves(ids).length, 0);
    }
}
