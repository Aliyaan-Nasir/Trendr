// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {ITrendRegistry} from "../../src/interfaces/ITrendRegistry.sol";
import {Fixture} from "../utils/Fixture.sol";

/// @notice A report encoded by the CRE oracle's TypeScript encoder (apps/cre-oracle, regenerate
///         with its fixture script) is decoded and applied by TrendRegistry.
contract CreReportFixtureTest is Fixture {
    function test_oracleEncodedReportIsAccepted() public {
        bytes memory report = vm.parseBytes(vm.trim(vm.readFile("test/fixtures/cre-report.hex")));
        vm.warp(1_800_000_000);
        vm.prank(FORWARDER);
        registry.onReport(metadata(), report);

        assertEq(registry.lastRunId(), 1_800_000_000);
        bytes32 cup = keccak256("topic:world-cup");
        ITrendRegistry.Trend memory t = registry.trendOf(cup);
        assertEq(uint8(t.status), uint8(ITrendRegistry.Status.Active));
        assertEq(uint8(t.assetClass), uint8(ITrendRegistry.AssetClass.Topic));
        assertEq(t.index, 12_340_000);
        assertEq(t.surfacer, address(0xA1));
        assertEq(registry.identifierOf(cup), "topic:world-cup");
        assertEq(uint8(registry.statusOf(keccak256("crypto:mon"))), uint8(ITrendRegistry.Status.Active));
    }
}
