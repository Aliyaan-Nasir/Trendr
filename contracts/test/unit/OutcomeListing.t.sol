// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {ITrendRegistry} from "../../src/interfaces/ITrendRegistry.sol";
import {IKuruRouter} from "../../src/interfaces/kuru/IKuru.sol";
import {OutcomeListing} from "../../src/outcome/OutcomeListing.sol";
import {OutcomeMarkets} from "../../src/outcome/OutcomeMarkets.sol";
import {MockKuruRouter} from "../mocks/MockKuru.sol";
import {Fixture} from "../utils/Fixture.sol";

contract OutcomeListingTest is Fixture {
    MockKuruRouter internal router;
    OutcomeListing internal listing;
    bytes32 internal trend;
    bytes32 internal sid;
    address internal up;
    address internal down;

    function setUp() public override {
        super.setUp();
        router = new MockKuruRouter(false);
        listing = new OutcomeListing(IKuruRouter(address(router)), outcomes, false);
        trend = createTrend("hantavirus", ITrendRegistry.AssetClass.Topic, 40 * POINT);
        sid = outcomes.openSeries("hantavirus", 1 days);
        OutcomeMarkets.Series memory s = outcomes.seriesOf(sid);
        up = address(s.up);
        down = address(s.down);
    }

    function _deployCanonical(MockKuruRouter r, address token) internal returns (address) {
        return r.deployProxy(
            0,
            token,
            address(ausd),
            listing.SIZE_PRECISION(),
            listing.PRICE_PRECISION(),
            listing.TICK_SIZE(),
            listing.MIN_SIZE(),
            listing.MAX_SIZE(),
            listing.TAKER_FEE_BPS(),
            listing.MAKER_FEE_BPS(),
            listing.AMM_SPREAD()
        );
    }

    function test_listDeploysBothCanonicalMarkets() public {
        (address upPredicted, address downPredicted, bool upListed, bool downListed) = listing.marketsOf(sid);
        assertFalse(upListed || downListed);
        assertEq(upPredicted.code.length, 0);

        vm.expectEmit(address(listing));
        emit OutcomeListing.MarketRecorded(sid, up, upPredicted, true);
        vm.expectEmit(address(listing));
        emit OutcomeListing.MarketRecorded(sid, down, downPredicted, true);
        (address upMarket, address downMarket) = listing.list(sid);
        assertEq(upMarket, upPredicted);
        assertEq(downMarket, downPredicted);
        assertEq(router.deployments(), 2);

        (uint32 pricePrecision, uint96 sizePrecision, address base,, address quote,, uint32 tick,,,,) =
            router.verifiedMarket(upMarket);
        assertEq(base, up);
        assertEq(quote, address(ausd));
        assertEq(pricePrecision, 10_000);
        assertEq(sizePrecision, 100);
        assertEq(tick, 10);

        (,, upListed, downListed) = listing.marketsOf(sid);
        assertTrue(upListed && downListed);
        assertEq(listing.marketOf(up), upMarket);
    }

    function test_listIsIdempotent() public {
        listing.list(sid);
        vm.recordLogs();
        listing.list(sid);
        assertEq(vm.getRecordedLogs().length, 0);
        assertEq(router.deployments(), 2);
    }

    function test_listAdoptsAFrontRunCanonicalMarket() public {
        address early = _deployCanonical(router, up);
        vm.expectEmit(address(listing));
        emit OutcomeListing.MarketRecorded(sid, up, early, false);
        (address upMarket,) = listing.list(sid);
        assertEq(upMarket, early);
        assertEq(router.deployments(), 2);
    }

    function test_listNeedsAnOpenSeries() public {
        vm.expectRevert(OutcomeListing.UnknownSeries.selector);
        listing.list(keccak256("nope"));
        vm.expectRevert(OutcomeListing.UnknownSeries.selector);
        listing.marketsOf(keccak256("nope"));

        advance(1 days + 1);
        pushIndex(trend, 41 * POINT);
        outcomes.settle(sid);
        vm.expectRevert(OutcomeListing.SeriesClosed.selector);
        listing.list(sid);
    }

    function test_permissionedRouterWaitsForKuru() public {
        MockKuruRouter kuru = new MockKuruRouter(true);
        OutcomeListing gated = new OutcomeListing(IKuruRouter(address(kuru)), outcomes, true);
        vm.expectRevert(OutcomeListing.NotDeployed.selector);
        gated.list(sid);

        // Kuru deploys the canonical markets; anyone records them.
        address upMarket = kuru.deployProxy(0, up, address(ausd), 100, 10_000, 10, 100, 1e9, 10, 0, 100);
        _deployCanonical(kuru, down);
        (address recorded, address downMarket) = gated.list(sid);
        assertEq(recorded, upMarket);
        assertEq(downMarket, gated.marketOf(down));
    }

    function test_adoptChecksPairAndParameters() public {
        MockKuruRouter kuru = new MockKuruRouter(true);
        OutcomeListing gated = new OutcomeListing(IKuruRouter(address(kuru)), outcomes, true);
        address wrongTick = kuru.deployProxy(0, up, address(ausd), 100, 10_000, 1, 100, 1e9, 10, 0, 100);
        vm.expectRevert(OutcomeListing.MarketMismatch.selector);
        gated.adopt(up, wrongTick);
        address wrongFee = kuru.deployProxy(0, up, address(ausd), 100, 10_000, 10, 100, 1e9, 30, 0, 100);
        vm.expectRevert(OutcomeListing.MarketMismatch.selector);
        gated.adopt(up, wrongFee);

        address downMarket = _deployCanonical(kuru, down);
        vm.expectRevert(OutcomeListing.MarketMismatch.selector);
        gated.adopt(up, downMarket);
        vm.expectRevert(OutcomeListing.NotOutcomeToken.selector);
        gated.adopt(address(ausd), downMarket);
        vm.expectRevert(OutcomeListing.NotOutcomeToken.selector);
        gated.adopt(address(0xBEEF), downMarket);

        // A market from a later Kuru implementation lives elsewhere than predicted; adopt records it.
        vm.expectEmit(address(gated));
        emit OutcomeListing.MarketRecorded(sid, down, downMarket, false);
        gated.adopt(down, downMarket);
        vm.expectRevert(OutcomeListing.AlreadyRecorded.selector);
        gated.adopt(down, downMarket);
        (, address recordedDown,, bool downListed) = gated.marketsOf(sid);
        assertEq(recordedDown, downMarket);
        assertTrue(downListed);
    }
}
