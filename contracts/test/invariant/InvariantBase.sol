// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {console} from "forge-std/console.sol";

import {Fixture} from "../utils/Fixture.sol";
import {OracleDriver} from "./handlers/OracleDriver.sol";

/// @notice Shared base for invariant suites. With INVARIANT_COVERAGE=true, each run's path hits
///         are summed across the whole campaign and printed, to check the handler reaches the
///         states the invariants are about.
abstract contract InvariantBase is Fixture {
    function _reportCoverage(OracleDriver handler, string[] memory expected) internal {
        if (!vm.envOr("INVARIANT_COVERAGE", false)) return;
        for (uint256 i; i < expected.length; ++i) {
            string memory key = string.concat("COVERAGE_", expected[i]);
            vm.setEnv(key, vm.toString(vm.envOr(key, uint256(0)) + handler.hits(expected[i])));
        }
        vm.setEnv("COVERAGE_runs", vm.toString(vm.envOr("COVERAGE_runs", uint256(0)) + 1));
        console.log("runs", vm.envUint("COVERAGE_runs"));
        for (uint256 i; i < expected.length; ++i) {
            console.log(expected[i], vm.envUint(string.concat("COVERAGE_", expected[i])));
        }
    }
}
