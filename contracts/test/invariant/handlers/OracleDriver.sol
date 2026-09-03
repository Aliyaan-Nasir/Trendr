// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {CommonBase} from "forge-std/Base.sol";
import {StdCheats} from "forge-std/StdCheats.sol";
import {StdUtils} from "forge-std/StdUtils.sol";

import {TrendRegistry} from "../../../src/TrendRegistry.sol";

/// @notice Base for invariant handlers: plays the CRE forwarder and moves time and blocks.
abstract contract OracleDriver is CommonBase, StdCheats, StdUtils {
    address internal constant FORWARDER = address(0xF0F0);
    address internal constant WF_OWNER = address(0xA11CE);
    bytes10 internal constant WF_NAME = bytes10("trendr-idx");
    uint256 internal constant UNIT = 1e6;
    uint64 internal constant POINT = 1e6;

    TrendRegistry internal immutable registry;

    /// @notice Calls that reverted although the protocol promises they cannot; must stay zero.
    uint256 public unexpectedReverts;
    bytes public lastUnexpectedRevert;

    /// @notice Successful runs of each interesting path, so a campaign can show it reached real
    ///         states instead of passing vacuously (see InvariantBase).
    mapping(string path => uint256 count) public hits;

    constructor(TrendRegistry registry_) {
        registry = registry_;
    }

    function _hit(string memory path) internal {
        ++hits[path];
    }

    function _unexpected(bytes memory reason) internal {
        ++unexpectedReverts;
        lastUnexpectedRevert = reason;
    }

    function _metadata() internal pure returns (bytes memory) {
        return abi.encodePacked(bytes32(uint256(1)), WF_NAME, WF_OWNER, bytes2(0));
    }

    function _emptyReport() internal view returns (TrendRegistry.Report memory r) {
        r.runId = registry.lastRunId() + 1;
        r.observedAt = uint64(vm.getBlockTimestamp());
        r.newTrends = new TrendRegistry.NewTrend[](0);
        r.updates = new TrendRegistry.IndexUpdate[](0);
        r.settlements = new TrendRegistry.SettlementRequest[](0);
    }

    function _deliver(TrendRegistry.Report memory r) internal {
        vm.prank(FORWARDER);
        registry.onReport(_metadata(), abi.encode(r));
    }

    function _create(string memory identifier, uint64 index, address surfacer) internal returns (bytes32) {
        TrendRegistry.Report memory r = _emptyReport();
        r.newTrends = new TrendRegistry.NewTrend[](1);
        r.newTrends[0] = TrendRegistry.NewTrend({
            identifier: identifier,
            assetClass: 6,
            index: index,
            surfacer: surfacer,
            smartMoneyConfirmed: false
        });
        _deliver(r);
        return keccak256(bytes(identifier));
    }

    function _push(bytes32 id, uint64 index) internal {
        TrendRegistry.Report memory r = _emptyReport();
        r.updates = new TrendRegistry.IndexUpdate[](1);
        r.updates[0] = TrendRegistry.IndexUpdate({id: id, index: index});
        _deliver(r);
    }

    function _requestSettlement(bytes32 id, uint64 expiry) internal {
        TrendRegistry.Report memory r = _emptyReport();
        r.settlements = new TrendRegistry.SettlementRequest[](1);
        r.settlements[0] = TrendRegistry.SettlementRequest({id: id, expiry: expiry});
        _deliver(r);
    }

    /// @notice Pushes a random index between 0.5x and 1.5x of the current one.
    function _walk(bytes32 id, uint256 seed) internal {
        (uint64 index,) = registry.indexOf(id);
        uint256 next = _bound(seed, uint256(index) / 2, uint256(index) * 3 / 2);
        if (next < registry.MIN_INDEX()) next = registry.MIN_INDEX();
        if (next > registry.MAX_INDEX()) next = registry.MAX_INDEX();
        _push(id, uint64(next));
    }

    /// @notice Moves time and blocks forward together (about 0.4 s blocks). Reads the clock
    ///         through cheatcodes because via-IR may reuse an earlier `block.timestamp` read.
    function _advance(uint256 secs) internal {
        vm.warp(vm.getBlockTimestamp() + secs);
        vm.roll(vm.getBlockNumber() + secs * 5 / 2 + 1);
    }
}
