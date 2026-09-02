// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {ITrendRegistry} from "../../src/interfaces/ITrendRegistry.sol";
import {OutcomeMarkets} from "../../src/outcome/OutcomeMarkets.sol";
import {OutcomeToken} from "../../src/outcome/OutcomeToken.sol";
import {Fixture} from "../utils/Fixture.sol";

contract OutcomeMarketsTest is Fixture {
    address internal alice = address(0xA1);
    address internal bob = address(0xB2);
    bytes32 internal trend;
    uint32 internal constant DAY = 1 days;

    function setUp() public override {
        super.setUp();
        trend = createTrend("hantavirus", ITrendRegistry.AssetClass.Topic, 40 * POINT);
        fund(alice, 10_000 * UNIT);
        fund(bob, 10_000 * UNIT);
    }

    function _open() internal returns (bytes32 sid, OutcomeToken up, OutcomeToken down) {
        sid = outcomes.openSeries("hantavirus", DAY);
        OutcomeMarkets.Series memory s = outcomes.seriesOf(sid);
        up = s.up;
        down = s.down;
    }

    /// @dev Pushes index observations up to expiry and requests settlement at `value`.
    function _settleAt(bytes32 sid, uint64 value) internal {
        OutcomeMarkets.Series memory s = outcomes.seriesOf(sid);
        uint64 current = registry.trendOf(trend).index;
        while (block.timestamp < s.expiry) {
            advance(1 hours);
            current = current < value
                ? (value - current > current / 2 ? current + current / 2 : value)
                : (current - value > current / 2 ? current - current / 2 : value);
            pushIndex(trend, current);
        }
        if (current != value) {
            advance(1);
            pushIndex(trend, value);
        }
        requestSettlement(trend, s.expiry);
    }

    function test_openSeries() public {
        (bytes32 sid, OutcomeToken up, OutcomeToken down) = _open();
        OutcomeMarkets.Series memory s = outcomes.seriesOf(sid);
        assertEq(s.trendId, trend);
        assertEq(s.openingIndex, 40 * POINT);
        assertEq(s.expiry, block.timestamp + DAY);
        assertEq(uint8(s.outcome), uint8(OutcomeMarkets.Outcome.Open));
        assertEq(up.decimals(), 6);
        assertTrue(up.isUp());
        assertFalse(down.isUp());
        assertEq(up.name(), "Trendr UP hantavirus 24h #1");
        assertEq(down.symbol(), "DOWN");
        assertEq(outcomes.latestSeries(trend, DAY), sid);
    }

    function test_openSeriesGuards() public {
        vm.expectRevert(OutcomeMarkets.InvalidWindow.selector);
        outcomes.openSeries("hantavirus", 2 days);
        vm.expectRevert(OutcomeMarkets.TrendNotActive.selector);
        outcomes.openSeries("unknown", DAY);
        _open();
        vm.expectRevert(OutcomeMarkets.SeriesStillOpen.selector);
        outcomes.openSeries("hantavirus", DAY);
        // The 7-day window is independent.
        outcomes.openSeries("hantavirus", 7 days);
        advance(11 minutes);
        vm.expectRevert(OutcomeMarkets.IndexStale.selector);
        outcomes.openSeries("hantavirus", 7 days);
    }

    function test_rollsToNextSeriesAfterExpiry() public {
        (bytes32 first,,) = _open();
        advance(DAY);
        pushIndex(trend, 41 * POINT);
        bytes32 second = outcomes.openSeries("hantavirus", DAY);
        assertTrue(second != first);
        assertEq(outcomes.seriesCount(trend, DAY), 2);
        assertEq(outcomes.seriesOf(second).openingIndex, 41 * POINT);
    }

    function test_mintAndRedeemSets() public {
        (bytes32 sid, OutcomeToken up, OutcomeToken down) = _open();
        vm.prank(alice);
        outcomes.mint(sid, 100 * UNIT, alice);
        assertEq(up.balanceOf(alice), 100 * UNIT);
        assertEq(down.balanceOf(alice), 100 * UNIT);
        assertEq(ausd.balanceOf(address(outcomes)), 100 * UNIT);
        assertEq(outcomes.obligations(sid), 100 * UNIT);

        vm.prank(alice);
        outcomes.redeemSets(sid, 40 * UNIT, bob);
        assertEq(ausd.balanceOf(bob), 10_040 * UNIT);
        assertEq(outcomes.seriesOf(sid).backing, 60 * UNIT);
        assertEq(outcomes.totalBacking(), 60 * UNIT);
    }

    function test_mintWithPermit() public {
        (bytes32 sid, OutcomeToken up,) = _open();
        uint256 pk = 0xC0FFEE;
        address carol = vm.addr(pk);
        ausd.mint(carol, 50 * UNIT);
        uint256 deadline = block.timestamp + 1 hours;
        bytes32 structHash = keccak256(
            abi.encode(
                keccak256(
                    "Permit(address owner,address spender,uint256 value,uint256 nonce,uint256 deadline)"
                ),
                carol,
                address(outcomes),
                50 * UNIT,
                ausd.nonces(carol),
                deadline
            )
        );
        (uint8 v, bytes32 r, bytes32 s) =
            vm.sign(pk, keccak256(abi.encodePacked("\x19\x01", ausd.DOMAIN_SEPARATOR(), structHash)));
        vm.prank(carol);
        outcomes.mintWithPermit(sid, 50 * UNIT, carol, deadline, v, r, s);
        assertEq(up.balanceOf(carol), 50 * UNIT);
    }

    function test_mintGuards() public {
        (bytes32 sid,,) = _open();
        vm.startPrank(alice);
        vm.expectRevert(OutcomeMarkets.ZeroAmount.selector);
        outcomes.mint(sid, 0, alice);
        vm.expectRevert(OutcomeMarkets.UnknownSeries.selector);
        outcomes.mint(bytes32(uint256(1)), 1, alice);
        vm.stopPrank();
        advance(DAY);
        vm.prank(alice);
        vm.expectRevert(OutcomeMarkets.SeriesExpired.selector);
        outcomes.mint(sid, 1, alice);
    }

    function test_upWins() public {
        (bytes32 sid, OutcomeToken up, OutcomeToken down) = _open();
        vm.prank(alice);
        outcomes.mint(sid, 100 * UNIT, alice);
        vm.prank(alice);
        down.transfer(bob, 100 * UNIT);

        _settleAt(sid, 55 * POINT);
        assertEq(uint8(outcomes.settle(sid)), uint8(OutcomeMarkets.Outcome.Up));
        assertEq(outcomes.obligations(sid), 100 * UNIT);

        vm.prank(alice);
        uint256 paid = outcomes.redeemWinnings(sid, 100 * UNIT, 0, alice);
        assertEq(paid, 100 * UNIT);
        vm.prank(bob);
        uint256 lost = outcomes.redeemWinnings(sid, 0, 100 * UNIT, bob);
        assertEq(lost, 0);
        assertEq(up.totalSupply(), 0);
        assertEq(ausd.balanceOf(address(outcomes)), 0);
    }

    function test_downWinsAndTieIsDown() public {
        (bytes32 sid,,) = _open();
        _settleAt(sid, 40 * POINT);
        assertEq(uint8(outcomes.settle(sid)), uint8(OutcomeMarkets.Outcome.Down));

        advance(1 hours);
        pushIndex(trend, 40 * POINT);
        bytes32 sid2 = outcomes.openSeries("hantavirus", DAY);
        _settleAt(sid2, 20 * POINT);
        assertEq(uint8(outcomes.settle(sid2)), uint8(OutcomeMarkets.Outcome.Down));
    }

    function test_settleGuards() public {
        (bytes32 sid,,) = _open();
        vm.expectRevert(OutcomeMarkets.SeriesNotExpired.selector);
        outcomes.settle(sid);
        advance(DAY);
        vm.expectRevert(OutcomeMarkets.NotSettleable.selector);
        outcomes.settle(sid);
    }

    function test_voidAfterGrace() public {
        (bytes32 sid, OutcomeToken up, OutcomeToken down) = _open();
        vm.prank(alice);
        outcomes.mint(sid, 101, alice);
        // The oracle is silent from an hour before expiry until well past the settlement
        // tolerance, then the trend comes back; no observation can settle the series.
        uint256 expiry = outcomes.seriesOf(sid).expiry;
        while (vm.getBlockTimestamp() + 1 hours < expiry) {
            advance(1 hours);
            pushIndex(trend, 40 * POINT);
        }
        advance(2 hours);
        pushIndex(trend, 40 * POINT);
        while (vm.getBlockTimestamp() < expiry + outcomes.VOID_GRACE()) {
            advance(1 hours);
            pushIndex(trend, 40 * POINT);
        }
        assertEq(uint8(outcomes.settle(sid)), uint8(OutcomeMarkets.Outcome.Void));
        vm.prank(alice);
        uint256 paid = outcomes.redeemWinnings(sid, 101, 101, alice);
        assertEq(paid, 100); // 50 + 50, rounding down per side
        assertEq(up.totalSupply(), 0);
        assertEq(down.totalSupply(), 0);
        assertGe(ausd.balanceOf(address(outcomes)), outcomes.obligations(sid));
    }

    function test_retiredTrendSettlesFromFinalIndex() public {
        (bytes32 sid,,) = _open();
        vm.prank(alice);
        outcomes.mint(sid, 10 * UNIT, alice);
        advance(2 hours);
        registry.pokeLifecycle(trend);
        advance(DAY);
        assertEq(uint8(outcomes.settle(sid)), uint8(OutcomeMarkets.Outcome.Down)); // final index 40, not above 40
    }

    function test_redeemSetsAfterSettlement() public {
        (bytes32 sid,,) = _open();
        vm.prank(alice);
        outcomes.mint(sid, 100 * UNIT, alice);
        _settleAt(sid, 60 * POINT);
        outcomes.settle(sid);
        vm.prank(alice);
        outcomes.redeemSets(sid, 100 * UNIT, alice);
        assertEq(ausd.balanceOf(alice), 10_000 * UNIT);
    }

    function test_coolingBlocksMint() public {
        (bytes32 sid,,) = _open();
        advance(60);
        pushIndex(trend, 30 * POINT);
        advance(60);
        pushIndex(trend, 15 * POINT);
        advance(60);
        pushIndex(trend, 8 * POINT);
        advance(60);
        pushIndex(trend, 4 * POINT);
        advance(1 hours);
        pushIndex(trend, 4 * POINT);
        assertEq(uint8(registry.statusOf(trend)), uint8(ITrendRegistry.Status.Cooling));
        vm.prank(alice);
        vm.expectRevert(OutcomeMarkets.TrendNotActive.selector);
        outcomes.mint(sid, 1, alice);
    }

    function testFuzz_setsAlwaysFullyBacked(uint96 a, uint96 b, uint96 r) public {
        (bytes32 sid,,) = _open();
        a = uint96(bound(a, 1, 5000 * UNIT));
        b = uint96(bound(b, 1, 5000 * UNIT));
        vm.prank(alice);
        outcomes.mint(sid, a, alice);
        vm.prank(bob);
        outcomes.mint(sid, b, bob);
        r = uint96(bound(r, 1, a));
        vm.prank(alice);
        outcomes.redeemSets(sid, r, alice);
        assertEq(outcomes.seriesOf(sid).backing, uint256(a) + b - r);
        assertEq(outcomes.obligations(sid), uint256(a) + b - r);
        assertEq(ausd.balanceOf(address(outcomes)), outcomes.totalBacking());
    }

    // --- test window ----------------------------------------------------------------------

    function test_testWindowIsOptionalAndBounded() public {
        assertEq(outcomes.windows().length, 2);
        vm.expectRevert(OutcomeMarkets.InvalidWindow.selector);
        outcomes.openSeries("hantavirus", 15 minutes);
        vm.expectRevert(OutcomeMarkets.InvalidWindow.selector);
        new OutcomeMarkets(ausd, ITrendRegistry(address(registry)), 4 minutes);
        vm.expectRevert(OutcomeMarkets.InvalidWindow.selector);
        new OutcomeMarkets(ausd, ITrendRegistry(address(registry)), 2 hours);
    }

    function test_shortWindowRunsTheFullCycle() public {
        OutcomeMarkets fast = new OutcomeMarkets(ausd, ITrendRegistry(address(registry)), 15 minutes);
        uint32[] memory w = fast.windows();
        assertEq(w.length, 3);
        assertEq(w[2], 15 minutes);
        bytes32 sid = fast.openSeries("hantavirus", 15 minutes);
        OutcomeMarkets.Series memory s = fast.seriesOf(sid);
        assertEq(s.up.name(), "Trendr UP hantavirus 15m #1");
        assertEq(s.expiry, block.timestamp + 15 minutes);

        vm.startPrank(alice);
        ausd.approve(address(fast), type(uint256).max);
        fast.mint(sid, 10 * UNIT, alice);
        vm.stopPrank();

        // The oracle observes a higher index just after expiry; the series settles UP.
        advance(15 minutes + 30);
        pushIndex(trend, 44 * POINT);
        assertEq(uint8(fast.settle(sid)), uint8(OutcomeMarkets.Outcome.Up));
        vm.prank(alice);
        assertEq(fast.redeemWinnings(sid, 10 * UNIT, 10 * UNIT, alice), 10 * UNIT);
    }
}
