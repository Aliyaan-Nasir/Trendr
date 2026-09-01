// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {IERC165} from "@openzeppelin/contracts/utils/introspection/IERC165.sol";

import {TrendRegistry} from "../../src/TrendRegistry.sol";
import {IReceiver} from "../../src/interfaces/IReceiver.sol";
import {ITrendRegistry} from "../../src/interfaces/ITrendRegistry.sol";
import {Fixture} from "../utils/Fixture.sol";

contract TrendRegistryTest is Fixture {
    TrendRegistry.NewTrend[] internal noTrends;
    TrendRegistry.IndexUpdate[] internal noUpdates;
    TrendRegistry.SettlementRequest[] internal noSettlements;

    function _report(uint64 id, uint64 observedAt) internal view returns (bytes memory) {
        return abi.encode(
            TrendRegistry.Report({
                runId: id,
                observedAt: observedAt,
                newTrends: noTrends,
                updates: noUpdates,
                settlements: noSettlements
            })
        );
    }

    // --- access ---------------------------------------------------------------------------

    function test_onlyForwarderCanReport() public {
        vm.expectRevert(TrendRegistry.NotForwarder.selector);
        registry.onReport(metadata(), _report(1, uint64(block.timestamp)));
    }

    function test_rejectsWrongWorkflowOwner() public {
        bytes memory meta = abi.encodePacked(bytes32(uint256(1)), WF_NAME, address(0xBAD), bytes2(0));
        vm.prank(FORWARDER);
        vm.expectRevert(TrendRegistry.WrongWorkflow.selector);
        registry.onReport(meta, _report(1, uint64(block.timestamp)));
    }

    function test_rejectsWrongWorkflowName() public {
        bytes memory meta = abi.encodePacked(bytes32(uint256(1)), bytes10("other"), WF_OWNER, bytes2(0));
        vm.prank(FORWARDER);
        vm.expectRevert(TrendRegistry.WrongWorkflow.selector);
        registry.onReport(meta, _report(1, uint64(block.timestamp)));
    }

    function test_rejectsShortMetadata() public {
        vm.prank(FORWARDER);
        vm.expectRevert(TrendRegistry.WrongWorkflow.selector);
        registry.onReport(hex"01", _report(1, uint64(block.timestamp)));
    }

    function test_acceptsSixtyTwoByteMetadata() public {
        bytes memory meta = abi.encodePacked(bytes32(uint256(1)), WF_NAME, WF_OWNER);
        vm.prank(FORWARDER);
        registry.onReport(meta, _report(1, uint64(block.timestamp)));
        assertEq(registry.lastRunId(), 1);
    }

    function test_mockModePinsOrigin() public {
        address broadcaster = address(0xB0B);
        TrendRegistry sim = new TrendRegistry(FORWARDER, broadcaster, address(0), bytes10(0), defaultParams());
        vm.prank(FORWARDER, address(0xEEE));
        vm.expectRevert(TrendRegistry.UntrustedOrigin.selector);
        sim.onReport("", _report(1, uint64(block.timestamp)));

        vm.prank(FORWARDER, broadcaster);
        sim.onReport("", _report(1, uint64(block.timestamp)));
        assertEq(sim.lastRunId(), 1);
    }

    function test_constructorRejectsMixedModes() public {
        vm.expectRevert(TrendRegistry.InvalidMode.selector);
        new TrendRegistry(FORWARDER, address(0), address(0), WF_NAME, defaultParams());
        vm.expectRevert(TrendRegistry.InvalidMode.selector);
        new TrendRegistry(FORWARDER, address(0xB0B), WF_OWNER, WF_NAME, defaultParams());
        vm.expectRevert(TrendRegistry.ZeroAddress.selector);
        new TrendRegistry(address(0), address(0), WF_OWNER, WF_NAME, defaultParams());
    }

    function test_constructorBoundsParams() public {
        TrendRegistry.Params memory p = defaultParams();
        p.maxMoveBps = 9500;
        vm.expectRevert(TrendRegistry.InvalidParams.selector);
        new TrendRegistry(FORWARDER, address(0), WF_OWNER, WF_NAME, p);
        p = defaultParams();
        p.stalenessLimit = 5;
        vm.expectRevert(TrendRegistry.InvalidParams.selector);
        new TrendRegistry(FORWARDER, address(0), WF_OWNER, WF_NAME, p);
        p = defaultParams();
        p.staleRetireWindow = p.stalenessLimit - 1;
        vm.expectRevert(TrendRegistry.InvalidParams.selector);
        new TrendRegistry(FORWARDER, address(0), WF_OWNER, WF_NAME, p);
    }

    function test_supportsReceiverInterface() public view {
        assertTrue(registry.supportsInterface(type(IReceiver).interfaceId));
        assertTrue(registry.supportsInterface(type(IERC165).interfaceId));
        assertFalse(registry.supportsInterface(0xdeadbeef));
    }

    // --- replay and timing ----------------------------------------------------------------

    function test_replayedRunReverts() public {
        vm.startPrank(FORWARDER);
        registry.onReport(metadata(), _report(5, uint64(block.timestamp)));
        vm.expectRevert(TrendRegistry.StaleRun.selector);
        registry.onReport(metadata(), _report(5, uint64(block.timestamp)));
        vm.expectRevert(TrendRegistry.StaleRun.selector);
        registry.onReport(metadata(), _report(4, uint64(block.timestamp)));
        vm.stopPrank();
    }

    function test_oldReportReverts() public {
        vm.prank(FORWARDER);
        vm.expectRevert(TrendRegistry.BadObservationTime.selector);
        registry.onReport(metadata(), _report(1, uint64(block.timestamp - 11 minutes)));
    }

    function test_futureReportReverts() public {
        vm.prank(FORWARDER);
        vm.expectRevert(TrendRegistry.BadObservationTime.selector);
        registry.onReport(metadata(), _report(1, uint64(block.timestamp + 2 minutes)));
    }

    // --- trends ---------------------------------------------------------------------------

    function test_createTrend() public {
        bytes32 id = createTrend("hantavirus", ITrendRegistry.AssetClass.Topic, 40 * POINT);
        ITrendRegistry.Trend memory t = registry.trendOf(id);
        assertEq(uint8(t.status), uint8(ITrendRegistry.Status.Active));
        assertEq(t.index, 40 * POINT);
        assertEq(t.peakIndex, 40 * POINT);
        assertEq(t.surfacer, SURFACER);
        assertEq(registry.trendCount(), 1);
        assertTrue(registry.isFresh(id));
        assertEq(registry.checkpointCount(id), 1);
    }

    function test_duplicateTrendRejected() public {
        bytes32 id = createTrend("btc", ITrendRegistry.AssetClass.Crypto, 40 * POINT);
        vm.expectEmit(true, false, false, true);
        emit TrendRegistry.ItemRejected(id, 0, TrendRegistry.Rejection.Duplicate);
        createTrend("btc", ITrendRegistry.AssetClass.Crypto, 50 * POINT);
        assertEq(registry.trendOf(id).index, 40 * POINT);
        assertEq(registry.trendCount(), 1);
    }

    function test_nonNormalizedIdentifierRejected() public {
        assertFalse(registry.isNormalized("BTC"));
        assertFalse(registry.isNormalized(" btc"));
        assertFalse(registry.isNormalized(""));
        assertTrue(registry.isNormalized("xyz:nvda"));
        assertTrue(registry.isNormalized("us-crypto_capital.2026"));
        createTrend("BTC", ITrendRegistry.AssetClass.Crypto, 40 * POINT);
        assertEq(registry.trendCount(), 0);
    }

    function test_cryptoNeedsSmartMoneyConfirmation() public {
        TrendRegistry.NewTrend[] memory created = new TrendRegistry.NewTrend[](1);
        created[0] = TrendRegistry.NewTrend(
            "pepe", uint8(ITrendRegistry.AssetClass.Crypto), 30 * POINT, SURFACER, false
        );
        deliver(created, noUpdates, noSettlements);
        assertEq(uint8(registry.statusOf(keccak256("pepe"))), uint8(ITrendRegistry.Status.None));

        created[0] = TrendRegistry.NewTrend(
            "taylor", uint8(ITrendRegistry.AssetClass.Person), 30 * POINT, SURFACER, false
        );
        deliver(created, noUpdates, noSettlements);
        assertEq(uint8(registry.statusOf(keccak256("taylor"))), uint8(ITrendRegistry.Status.Active));
    }

    function test_indexBoundsOnCreate() public {
        createTrend("tiny", ITrendRegistry.AssetClass.Topic, 1);
        createTrend("huge", ITrendRegistry.AssetClass.Topic, 2000 * POINT);
        assertEq(registry.trendCount(), 0);
    }

    function test_badItemDoesNotBlockReport() public {
        TrendRegistry.NewTrend[] memory created = new TrendRegistry.NewTrend[](2);
        created[0] = TrendRegistry.NewTrend("Bad Id", 6, 30 * POINT, SURFACER, true);
        created[1] = TrendRegistry.NewTrend("good", 6, 30 * POINT, SURFACER, true);
        deliver(created, noUpdates, noSettlements);
        assertEq(registry.trendCount(), 1);
        assertEq(uint8(registry.statusOf(keccak256("good"))), uint8(ITrendRegistry.Status.Active));
    }

    // --- index updates --------------------------------------------------------------------

    function test_updateTracksPeakAndCheckpoints() public {
        bytes32 id = createTrend("ai", ITrendRegistry.AssetClass.Topic, 40 * POINT);
        advance(60);
        pushIndex(id, 50 * POINT);
        advance(60);
        pushIndex(id, 45 * POINT);
        ITrendRegistry.Trend memory t = registry.trendOf(id);
        assertEq(t.index, 45 * POINT);
        assertEq(t.peakIndex, 50 * POINT);
        assertEq(registry.checkpointCount(id), 3);
    }

    function test_updateNotNewerRejected() public {
        bytes32 id = createTrend("ai", ITrendRegistry.AssetClass.Topic, 40 * POINT);
        pushIndex(id, 50 * POINT); // same observedAt as creation
        assertEq(registry.trendOf(id).index, 40 * POINT);
    }

    function test_maxMoveIsClamped() public {
        bytes32 id = createTrend("ai", ITrendRegistry.AssetClass.Topic, 40 * POINT);
        advance(60);
        vm.expectEmit(true, false, false, true);
        emit TrendRegistry.IndexClamped(id, 100 * POINT, 60 * POINT);
        pushIndex(id, 100 * POINT);
        assertEq(registry.trendOf(id).index, 60 * POINT);
        advance(60);
        pushIndex(id, 1 * POINT);
        assertEq(registry.trendOf(id).index, 30 * POINT);
    }

    function test_unknownTrendUpdateRejected() public {
        pushIndex(keccak256("nope"), 10 * POINT);
        assertEq(registry.checkpointCount(keccak256("nope")), 0);
    }

    function test_staleness() public {
        bytes32 id = createTrend("ai", ITrendRegistry.AssetClass.Topic, 40 * POINT);
        advance(10 minutes);
        assertTrue(registry.isFresh(id));
        advance(1);
        assertFalse(registry.isFresh(id));
    }

    // --- lifecycle ------------------------------------------------------------------------

    function test_coolingThenRecovery() public {
        bytes32 id = createTrend("fad", ITrendRegistry.AssetClass.Topic, 6 * POINT);
        advance(60);
        pushIndex(id, 4 * POINT);
        advance(30 minutes);
        pushIndex(id, 4 * POINT);
        assertEq(uint8(registry.statusOf(id)), uint8(ITrendRegistry.Status.Active));
        advance(31 minutes);
        pushIndex(id, 4 * POINT);
        assertEq(uint8(registry.statusOf(id)), uint8(ITrendRegistry.Status.Cooling));
        advance(60);
        pushIndex(id, 5 * POINT);
        assertEq(uint8(registry.statusOf(id)), uint8(ITrendRegistry.Status.Active));
    }

    function test_coolingThenRetired() public {
        bytes32 id = _cool("fad");
        advance(1 hours);
        pushIndex(id, 4 * POINT);
        assertEq(uint8(registry.statusOf(id)), uint8(ITrendRegistry.Status.Retired));
        assertEq(registry.retiredAt(id), uint64(block.timestamp));
        // Retired is final.
        advance(60);
        pushIndex(id, 50 * POINT);
        assertEq(registry.trendOf(id).index, 4 * POINT);
    }

    function test_pokeRetiresStaleTrend() public {
        bytes32 id = createTrend("quiet", ITrendRegistry.AssetClass.Topic, 40 * POINT);
        advance(1 hours);
        vm.expectRevert(TrendRegistry.NothingToPoke.selector);
        registry.pokeLifecycle(id);
        advance(1 hours);
        registry.pokeLifecycle(id);
        assertEq(uint8(registry.statusOf(id)), uint8(ITrendRegistry.Status.Retired));
        vm.expectRevert(TrendRegistry.NothingToPoke.selector);
        registry.pokeLifecycle(id);
    }

    function test_pokeRetiresLongCooling() public {
        bytes32 id = _cool("fad");
        advance(30 minutes);
        pushIndex(id, 4 * POINT);
        advance(31 minutes);
        registry.pokeLifecycle(id);
        assertEq(uint8(registry.statusOf(id)), uint8(ITrendRegistry.Status.Retired));
    }

    function test_pokeUnknownReverts() public {
        vm.expectRevert(TrendRegistry.UnknownTrend.selector);
        registry.pokeLifecycle(keccak256("nope"));
    }

    // --- settlement -----------------------------------------------------------------------

    function test_settlementUsesFirstObservationAtOrAfterExpiry() public {
        bytes32 id = createTrend("ai", ITrendRegistry.AssetClass.Topic, 40 * POINT);
        uint64 expiry = uint64(block.timestamp + 1 hours);
        advance(59 minutes);
        pushIndex(id, 41 * POINT);
        advance(2 minutes); // 1 minute after expiry
        pushIndex(id, 42 * POINT);
        advance(2 minutes);
        pushIndex(id, 43 * POINT);
        requestSettlement(id, expiry);
        (bool finalized, uint64 value) = registry.settlementOf(id, expiry);
        assertTrue(finalized);
        assertEq(value, 42 * POINT);
    }

    function test_settlementRejectsObservationBeyondTolerance() public {
        bytes32 id = createTrend("ai", ITrendRegistry.AssetClass.Topic, 40 * POINT);
        uint64 expiry = uint64(block.timestamp + 1 hours);
        advance(1 hours + 11 minutes);
        pushIndex(id, 42 * POINT);
        requestSettlement(id, expiry);
        (bool finalized,) = registry.settlementOf(id, expiry);
        assertFalse(finalized);
    }

    function test_settlementRejectsUnexpiredAndDuplicate() public {
        bytes32 id = createTrend("ai", ITrendRegistry.AssetClass.Topic, 40 * POINT);
        uint64 expiry = uint64(block.timestamp + 1 hours);
        requestSettlement(id, expiry);
        (bool finalized,) = registry.settlementOf(id, expiry);
        assertFalse(finalized);

        advance(1 hours);
        pushIndex(id, 44 * POINT);
        requestSettlement(id, expiry);
        advance(60);
        pushIndex(id, 60 * POINT);
        vm.expectEmit(true, false, false, true);
        emit TrendRegistry.ItemRejected(id, 2, TrendRegistry.Rejection.AlreadySettled);
        requestSettlement(id, expiry);
        (, uint64 value) = registry.settlementOf(id, expiry);
        assertEq(value, 44 * POINT);
    }

    function test_retiredTrendSettlesAtFinalIndex() public {
        bytes32 id = createTrend("quiet", ITrendRegistry.AssetClass.Topic, 40 * POINT);
        uint64 expiry = uint64(block.timestamp + 24 hours);
        advance(2 hours);
        registry.pokeLifecycle(id);
        (bool finalized, uint64 value) = registry.settlementOf(id, expiry);
        assertTrue(finalized);
        assertEq(value, 40 * POINT);
    }

    function _cool(string memory identifier) internal returns (bytes32 id) {
        id = createTrend(identifier, ITrendRegistry.AssetClass.Topic, 6 * POINT);
        advance(60);
        pushIndex(id, 4 * POINT);
        advance(1 hours);
        pushIndex(id, 4 * POINT);
        assertEq(uint8(registry.statusOf(id)), uint8(ITrendRegistry.Status.Cooling));
    }

    // --- lazy settlement and enumeration ---------------------------------------------------

    function test_settlementFinalizesFromTheFirstObservationAfterExpiry() public {
        bytes32 id = createTrend("lazy", ITrendRegistry.AssetClass.Topic, 40 * POINT);
        uint64 expiry = uint64(vm.getBlockTimestamp() + 1 hours);
        advance(30 minutes);
        pushIndex(id, 44 * POINT);
        (bool finalized,) = registry.settlementOf(id, expiry);
        assertFalse(finalized, "nothing observed after expiry yet");

        advance(35 minutes); // 5 minutes after expiry, inside the 10 minute tolerance
        pushIndex(id, 48 * POINT);
        uint64 value;
        (finalized, value) = registry.settlementOf(id, expiry);
        assertTrue(finalized);
        assertEq(value, 48 * POINT);

        // Later observations never change it, and an explicit request records the same value.
        advance(1 minutes);
        pushIndex(id, 30 * POINT);
        requestSettlement(id, expiry);
        (finalized, value) = registry.settlementOf(id, expiry);
        assertEq(value, 48 * POINT);
    }

    function test_settlementNeedsAnObservationWithinTolerance() public {
        bytes32 id = createTrend("late", ITrendRegistry.AssetClass.Topic, 40 * POINT);
        uint64 expiry = uint64(vm.getBlockTimestamp() + 1 hours);
        advance(1 hours + 11 minutes); // first observation lands past the tolerance
        pushIndex(id, 44 * POINT);
        (bool finalized,) = registry.settlementOf(id, expiry);
        assertFalse(finalized);
    }

    function test_trendsEnumeratesInCreationOrder() public {
        createTrend("first", ITrendRegistry.AssetClass.Topic, 10 * POINT);
        createTrend("second", ITrendRegistry.AssetClass.Person, 20 * POINT);
        createTrend("third", ITrendRegistry.AssetClass.Topic, 30 * POINT);
        uint256 n = registry.trendCount();
        ITrendRegistry.TrendView[] memory page = registry.trends(n - 3, 10);
        assertEq(page.length, 3);
        assertEq(page[0].identifier, "first");
        assertEq(page[1].id, keccak256("second"));
        assertEq(uint8(page[1].trend.assetClass), uint8(ITrendRegistry.AssetClass.Person));
        assertEq(page[2].trend.index, 30 * POINT);
        assertEq(registry.trends(n - 3, 2).length, 2);
        assertEq(registry.trends(n, 5).length, 0);
    }
}
