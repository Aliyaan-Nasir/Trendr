// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {ITrendRegistry} from "../../src/interfaces/ITrendRegistry.sol";
import {InvariantBase} from "./InvariantBase.sol";
import {RegistryHandler} from "./handlers/RegistryHandler.sol";

/// @notice Trend registry: only the forwarder with the right workflow writes, the circuit
///         breaker bounds every move, the index stays in range, freshness follows the clock,
///         settlement values are correct and final, and retirement is permanent.
contract RegistryInvariants is InvariantBase {
    RegistryHandler internal handler;

    function setUp() public override {
        super.setUp();
        handler = new RegistryHandler(registry);
        handler.report(0, 2, 0, 0, block.timestamp);

        bytes4[] memory selectors = new bytes4[](10);
        selectors[0] = RegistryHandler.report.selector;
        selectors[1] = RegistryHandler.report.selector;
        selectors[2] = RegistryHandler.report.selector; // weighted: honest reports drive state
        selectors[3] = RegistryHandler.forgedReport.selector;
        selectors[4] = RegistryHandler.wrongWorkflow.selector;
        selectors[5] = RegistryHandler.replayedRun.selector;
        selectors[6] = RegistryHandler.badObservationTime.selector;
        selectors[7] = RegistryHandler.advance.selector;
        selectors[8] = RegistryHandler.advance.selector;
        selectors[9] = RegistryHandler.poke.selector;
        targetSelector(FuzzSelector({addr: address(handler), selectors: selectors}));
        targetContract(address(handler));
    }

    function invariant_onlyTheWorkflowWrites() public view {
        assertEq(handler.forgedAccepted(), 0, "forged report accepted");
        assertEq(registry.lastRunId(), handler.lastAcceptedRunId(), "run id moved without an accepted report");
        assertEq(registry.statusOf(keccak256("forged")) == ITrendRegistry.Status.None, true);
    }

    function invariant_circuitBreakerBoundsEveryMove() public view {
        assertEq(handler.breakerBreaches(), 0);
        for (uint256 t; t < handler.trendCount(); ++t) {
            bytes32 id = handler.trends(t);
            uint256 n = registry.checkpointCount(id);
            (uint64 prevAt, uint64 prev) = registry.checkpointAt(id, 0);
            for (uint256 i = 1; i < n; ++i) {
                (uint64 at, uint64 value) = registry.checkpointAt(id, i);
                assertGt(at, prevAt, "checkpoints out of order");
                uint256 delta = value > prev ? value - prev : prev - value;
                assertLe(delta, uint256(prev) * registry.maxMoveBps() / 10_000, "move too large");
                (prevAt, prev) = (at, value);
            }
            (uint64 index, uint64 updatedAt) = registry.indexOf(id);
            assertEq(index, prev, "index is not the latest checkpoint");
            assertEq(updatedAt, prevAt, "updatedAt is not the latest checkpoint");
            assertGe(index, registry.MIN_INDEX());
            assertLe(index, registry.MAX_INDEX());
            assertGe(registry.trendOf(id).peakIndex, index);
        }
    }

    function invariant_freshnessFollowsTheClock() public view {
        for (uint256 t; t < handler.trendCount(); ++t) {
            bytes32 id = handler.trends(t);
            (, uint64 updatedAt) = registry.indexOf(id);
            uint256 age = block.timestamp > updatedAt ? block.timestamp - updatedAt : 0;
            assertEq(registry.isFresh(id), age <= registry.stalenessLimit());
        }
    }

    function invariant_settlementsAreCorrectAndFinal() public view {
        assertEq(handler.settlementMismatches(), 0, "settlement differs from first observation after expiry");
        for (uint256 i; i < handler.settledCount(); ++i) {
            RegistryHandler.Settled memory s = handler.settledAt(i);
            (bool finalized, uint64 value) = registry.settlementOf(s.id, s.expiry);
            assertTrue(finalized);
            assertEq(value, s.value, "settlement changed");
        }
    }

    /// @notice Lazy finalization agrees with an independent linear scan at, just before and just
    ///         after every observation.
    function invariant_lazySettlementMatchesObservations() public view {
        uint64 tolerance = registry.settlementTolerance();
        for (uint256 t; t < handler.trendCount(); ++t) {
            bytes32 id = handler.trends(t);
            uint256 n = registry.checkpointCount(id);
            for (uint256 i; i < n; ++i) {
                (uint64 at,) = registry.checkpointAt(id, i);
                uint64[4] memory expiries = [at, at - 1, at - tolerance, at + 1];
                for (uint256 k; k < expiries.length; ++k) {
                    (bool finalized, uint64 value) = registry.settlementOf(id, expiries[k]);
                    (bool expectedFinal, uint64 expected) = _expected(id, expiries[k], tolerance);
                    assertEq(finalized, expectedFinal, "finalized flag");
                    assertEq(value, expected, "settlement value");
                }
            }
        }
    }

    function _expected(bytes32 id, uint64 expiry, uint64 tolerance) internal view returns (bool, uint64) {
        uint64 retired = registry.retiredAt(id);
        if (retired != 0 && retired <= expiry) {
            (uint64 index,) = registry.indexOf(id);
            return (true, index);
        }
        uint256 n = registry.checkpointCount(id);
        for (uint256 i; i < n; ++i) {
            (uint64 at, uint64 value) = registry.checkpointAt(id, i);
            if (at >= expiry) return at <= uint256(expiry) + tolerance ? (true, value) : (false, uint64(0));
        }
        return (false, 0);
    }

    function invariant_retirementIsPermanent() public view {
        assertEq(handler.lifecycleViolations(), 0);
    }

    function invariant_reportsNeverRevert() public view {
        assertEq(handler.unexpectedReverts(), 0, vm.toString(handler.lastUnexpectedRevert()));
    }

    function afterInvariant() public {
        string[] memory paths = new string[](6);
        paths[0] = "report";
        paths[1] = "trend created";
        paths[2] = "move clamped";
        paths[3] = "settlement finalized";
        paths[4] = "retired by report";
        paths[5] = "retired by poke";
        _reportCoverage(handler, paths);
    }
}
