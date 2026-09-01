// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Test} from "forge-std/Test.sol";

import {CurationFees} from "../../src/CurationFees.sol";
import {TrendRegistry} from "../../src/TrendRegistry.sol";
import {BondingCurve} from "../../src/curve/BondingCurve.sol";
import {ICurationFees} from "../../src/interfaces/ICurationFees.sol";
import {IGraduationVenue} from "../../src/interfaces/IGraduationVenue.sol";
import {ITrendRegistry} from "../../src/interfaces/ITrendRegistry.sol";
import {OutcomeMarkets} from "../../src/outcome/OutcomeMarkets.sol";
import {AttentionPerp} from "../../src/perp/AttentionPerp.sol";
import {MockStable} from "../mocks/MockStable.sol";
import {MockVenue} from "../mocks/MockVenue.sol";

/// @notice Deploys the full Trendr system against a production-mode registry and offers helpers to
///         deliver CRE reports as the forwarder.
abstract contract Fixture is Test {
    address internal constant FORWARDER = address(0xF0F0);
    address internal constant WF_OWNER = address(0xA11CE);
    bytes10 internal constant WF_NAME = bytes10("trendr-idx");
    address internal constant TREASURY = address(0x7EA5);
    address internal constant SURFACER = address(0x5EED);

    uint256 internal constant UNIT = 1e6;
    uint64 internal constant POINT = 1e6;

    MockStable internal ausd;
    TrendRegistry internal registry;
    CurationFees internal curation;
    OutcomeMarkets internal outcomes;
    AttentionPerp internal perp;
    BondingCurve internal curve;
    MockVenue internal venue;

    uint64 internal runId;

    function setUp() public virtual {
        vm.warp(1_800_000_000);
        vm.roll(100);
        ausd = new MockStable();
        registry = new TrendRegistry(FORWARDER, address(0), WF_OWNER, WF_NAME, defaultParams());
        curation = new CurationFees(ausd, ITrendRegistry(address(registry)), TREASURY);
        outcomes = new OutcomeMarkets(ausd, ITrendRegistry(address(registry)), 0);
        perp = new AttentionPerp(
            ausd,
            ITrendRegistry(address(registry)),
            ICurationFees(address(curation)),
            TREASURY,
            1_000_000 * UNIT
        );
        venue = new MockVenue();
        curve = new BondingCurve(
            ausd,
            ITrendRegistry(address(registry)),
            ICurationFees(address(curation)),
            IGraduationVenue(address(venue)),
            TREASURY,
            2000 * UNIT,
            10_000 * UNIT
        );
    }

    function defaultParams() internal pure returns (TrendRegistry.Params memory) {
        return TrendRegistry.Params({
            stalenessLimit: 10 minutes,
            maxMoveBps: 5000,
            attentionFloor: 5 * POINT,
            coolingWindow: 1 hours,
            retireWindow: 1 hours,
            staleRetireWindow: 2 hours,
            settlementTolerance: 10 minutes,
            maxReportAge: 10 minutes,
            maxFutureSkew: 1 minutes
        });
    }

    function metadata() internal pure returns (bytes memory) {
        return abi.encodePacked(bytes32(uint256(1)), WF_NAME, WF_OWNER, bytes2(0));
    }

    function deliver(
        TrendRegistry.NewTrend[] memory created,
        TrendRegistry.IndexUpdate[] memory updates,
        TrendRegistry.SettlementRequest[] memory settlements
    ) internal {
        TrendRegistry.Report memory r =
            TrendRegistry.Report({
                runId: ++runId,
                observedAt: uint64(vm.getBlockTimestamp()),
                newTrends: created,
                updates: updates,
                settlements: settlements
            });
        vm.prank(FORWARDER);
        registry.onReport(metadata(), abi.encode(r));
    }

    function createTrend(string memory identifier, ITrendRegistry.AssetClass cls, uint64 index)
        internal
        returns (bytes32 id)
    {
        TrendRegistry.NewTrend[] memory created = new TrendRegistry.NewTrend[](1);
        created[0] = TrendRegistry.NewTrend({
            identifier: identifier,
            assetClass: uint8(cls),
            index: index,
            surfacer: SURFACER,
            smartMoneyConfirmed: true
        });
        deliver(created, new TrendRegistry.IndexUpdate[](0), new TrendRegistry.SettlementRequest[](0));
        id = keccak256(bytes(identifier));
    }

    function pushIndex(bytes32 id, uint64 index) internal {
        TrendRegistry.IndexUpdate[] memory updates = new TrendRegistry.IndexUpdate[](1);
        updates[0] = TrendRegistry.IndexUpdate({id: id, index: index});
        deliver(new TrendRegistry.NewTrend[](0), updates, new TrendRegistry.SettlementRequest[](0));
    }

    function requestSettlement(bytes32 id, uint64 expiry) internal {
        TrendRegistry.SettlementRequest[] memory s = new TrendRegistry.SettlementRequest[](1);
        s[0] = TrendRegistry.SettlementRequest({id: id, expiry: expiry});
        deliver(new TrendRegistry.NewTrend[](0), new TrendRegistry.IndexUpdate[](0), s);
    }

    /// @notice Moves time and blocks forward together (about 0.4 s blocks). Reads the clock
    ///         through cheatcodes because via-IR may reuse an earlier `block.timestamp` read.
    function advance(uint256 secs) internal {
        vm.warp(vm.getBlockTimestamp() + secs);
        vm.roll(vm.getBlockNumber() + secs * 5 / 2);
    }

    function fund(address who, uint256 amount) internal {
        ausd.mint(who, amount);
        vm.startPrank(who);
        ausd.approve(address(outcomes), type(uint256).max);
        ausd.approve(address(perp), type(uint256).max);
        ausd.approve(address(curve), type(uint256).max);
        vm.stopPrank();
    }
}
