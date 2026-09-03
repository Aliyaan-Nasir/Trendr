// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {TrendRegistry} from "../../../src/TrendRegistry.sol";
import {ITrendRegistry} from "../../../src/interfaces/ITrendRegistry.sol";
import {OracleDriver} from "./OracleDriver.sol";

/// @notice Feeds the registry well-formed, malformed and forged CRE reports.
contract RegistryHandler is OracleDriver {
    uint256 internal constant BPS = 10_000;

    struct Settled {
        bytes32 id;
        uint64 expiry;
        uint64 value;
    }

    string[] internal _pool;
    bytes32[] public trends;
    mapping(bytes32 id => bool) public known;
    mapping(bytes32 id => mapping(uint64 expiry => bool)) internal _recorded;
    Settled[] internal _settled;

    uint64 public lastAcceptedRunId;
    /// @notice Writes that did not come through the forwarder with the right workflow; must stay zero.
    uint256 public forgedAccepted;
    /// @notice Index moves larger than the circuit breaker allows; must stay zero.
    uint256 public breakerBreaches;
    /// @notice Retired trends whose status or index changed, or pokes that retired a trend early;
    ///         must stay zero.
    uint256 public lifecycleViolations;
    /// @notice Finalized settlement values that differ from the first observation at or after
    ///         expiry; must stay zero.
    uint256 public settlementMismatches;

    constructor(TrendRegistry registry_) OracleDriver(registry_) {
        _pool.push("alpha");
        _pool.push("beta");
        _pool.push("gamma");
        _pool.push("btc:usd");
        _pool.push("person.jane_doe-2");
        _pool.push("Alpha"); // uppercase: rejected
        _pool.push("has space"); // rejected
        _pool.push(""); // rejected
        _pool.push("an-identifier-that-is-longer-than-sixty-four-bytes-and-so-must-be-rejected");
    }

    function trendCount() external view returns (uint256) {
        return trends.length;
    }

    function settledCount() external view returns (uint256) {
        return _settled.length;
    }

    function settledAt(uint256 i) external view returns (Settled memory) {
        return _settled[i];
    }

    // --- honest reports ---------------------------------------------------------------------

    function report(uint256 seed, uint8 nNew, uint8 nUpdates, uint8 nSettlements, uint256 ageSeed) external {
        TrendRegistry.Report memory r = _emptyReport();
        // Observation times anywhere in the accepted window, including a little in the future.
        r.observedAt = uint64(
            _bound(
                ageSeed,
                vm.getBlockTimestamp() - registry.maxReportAge(),
                vm.getBlockTimestamp() + registry.maxFutureSkew()
            )
        );

        r.newTrends = new TrendRegistry.NewTrend[](nNew % 3);
        for (uint256 i; i < r.newTrends.length; ++i) {
            seed = uint256(keccak256(abi.encode(seed, "new", i)));
            r.newTrends[i] = TrendRegistry.NewTrend({
                identifier: _pool[seed % _pool.length],
                assetClass: uint8(seed >> 8) % 8, // 7 is out of range
                index: _randomIndex(seed >> 16, 40 * POINT),
                surfacer: address(uint160(seed >> 96)),
                smartMoneyConfirmed: (seed >> 200) % 2 == 0
            });
        }

        r.updates = new TrendRegistry.IndexUpdate[](trends.length == 0 ? 0 : nUpdates % 5);
        for (uint256 i; i < r.updates.length; ++i) {
            seed = uint256(keccak256(abi.encode(seed, "update", i)));
            bytes32 id = seed % 7 == 0 ? keccak256("unknown") : trends[seed % trends.length];
            (uint64 index,) = registry.indexOf(id);
            r.updates[i] = TrendRegistry.IndexUpdate({id: id, index: _randomIndex(seed >> 8, index)});
        }

        r.settlements = new TrendRegistry.SettlementRequest[](trends.length == 0 ? 0 : nSettlements % 3);
        for (uint256 i; i < r.settlements.length; ++i) {
            seed = uint256(keccak256(abi.encode(seed, "settle", i)));
            bytes32 id = trends[seed % trends.length];
            uint256 n = registry.checkpointCount(id);
            (uint64 at,) = registry.checkpointAt(id, (seed >> 8) % n);
            // Around a real observation: exactly on it, a little before, or after it.
            uint64 offset = uint64(_bound(seed >> 64, 1, 20 minutes));
            uint256 side = (seed >> 128) % 3;
            uint64 expiry = side == 0 ? at : side == 1 ? at - offset : at + offset;
            r.settlements[i] = TrendRegistry.SettlementRequest({id: id, expiry: expiry});
        }

        _deliverChecked(r);
    }

    // --- adversarial ------------------------------------------------------------------------

    function forgedReport(address caller, uint256 seed) external {
        if (caller == FORWARDER) return;
        TrendRegistry.Report memory r = _forgery(seed);
        vm.prank(caller);
        try registry.onReport(_metadata(), abi.encode(r)) {
            ++forgedAccepted;
        } catch {}
    }

    function wrongWorkflow(uint256 seed, bool wrongOwner) external {
        TrendRegistry.Report memory r = _forgery(seed);
        bytes memory metadata = wrongOwner
            ? abi.encodePacked(
                bytes32(uint256(1)), WF_NAME, address(uint160(WF_OWNER) ^ uint160(seed | 1)), bytes2(0)
            )
            : abi.encodePacked(bytes32(uint256(1)), bytes10(keccak256(abi.encode(seed))), WF_OWNER, bytes2(0));
        vm.prank(FORWARDER);
        try registry.onReport(metadata, abi.encode(r)) {
            ++forgedAccepted;
        } catch {}
    }

    function replayedRun(uint256 back) external {
        if (registry.lastRunId() == 0) return;
        TrendRegistry.Report memory r = _forgery(back);
        r.runId = registry.lastRunId() - uint64(_bound(back, 0, registry.lastRunId() - 1));
        vm.prank(FORWARDER);
        try registry.onReport(_metadata(), abi.encode(r)) {
            ++forgedAccepted;
        } catch {}
    }

    function badObservationTime(uint256 seed, bool future) external {
        TrendRegistry.Report memory r = _forgery(seed);
        r.observedAt = future
            ? uint64(vm.getBlockTimestamp() + registry.maxFutureSkew() + 1 + seed % 1 days)
            : uint64(vm.getBlockTimestamp() - registry.maxReportAge() - 1 - seed % 1 days);
        vm.prank(FORWARDER);
        try registry.onReport(_metadata(), abi.encode(r)) {
            ++forgedAccepted;
        } catch {}
    }

    // --- time -------------------------------------------------------------------------------

    function advance(uint256 secs) external {
        _advance(_bound(secs, 1, 3 hours));
    }

    /// @notice Anyone can retire a trend the oracle stopped updating or that stayed cooling past
    ///         the retire window; the poke must succeed exactly then.
    function poke(uint256 trendSeed) external {
        if (trends.length == 0) return;
        bytes32 id = trends[trendSeed % trends.length];
        ITrendRegistry.Trend memory t = registry.trendOf(id);
        uint256 nowTs = vm.getBlockTimestamp();
        bool due = t.status != ITrendRegistry.Status.Retired
            && (nowTs >= uint256(t.updatedAt) + registry.staleRetireWindow()
                || (t.status == ITrendRegistry.Status.Cooling
                    && nowTs >= uint256(t.statusSince) + registry.retireWindow()));
        try registry.pokeLifecycle(id) {
            if (!due) ++lifecycleViolations;
            _hit("retired by poke");
        } catch (bytes memory reason) {
            if (due) _unexpected(reason);
        }
    }

    // --- helpers ----------------------------------------------------------------------------

    function _deliverChecked(TrendRegistry.Report memory r) internal {
        uint256 n = trends.length;
        uint64[] memory indexBefore = new uint64[](n);
        ITrendRegistry.Status[] memory statusBefore = new ITrendRegistry.Status[](n);
        for (uint256 i; i < n; ++i) {
            (indexBefore[i],) = registry.indexOf(trends[i]);
            statusBefore[i] = registry.statusOf(trends[i]);
        }

        vm.prank(FORWARDER);
        try registry.onReport(_metadata(), abi.encode(r)) {
            lastAcceptedRunId = r.runId;
            _hit("report");
        } catch (bytes memory reason) {
            _unexpected(reason);
            return;
        }

        for (uint256 i; i < n; ++i) {
            (uint64 index,) = registry.indexOf(trends[i]);
            uint256 maxDelta = uint256(indexBefore[i]) * registry.maxMoveBps() / BPS;
            uint256 delta = index > indexBefore[i] ? index - indexBefore[i] : indexBefore[i] - index;
            if (delta > maxDelta) ++breakerBreaches;
            if (delta == maxDelta && delta > 0) _hit("move clamped");
            if (statusBefore[i] == ITrendRegistry.Status.Retired) {
                if (registry.statusOf(trends[i]) != ITrendRegistry.Status.Retired || index != indexBefore[i])
                {
                    ++lifecycleViolations;
                }
            } else if (registry.statusOf(trends[i]) == ITrendRegistry.Status.Retired) {
                _hit("retired by report");
            }
        }
        for (uint256 i; i < r.newTrends.length; ++i) {
            bytes32 id = keccak256(bytes(r.newTrends[i].identifier));
            if (!known[id] && registry.statusOf(id) != ITrendRegistry.Status.None) {
                known[id] = true;
                trends.push(id);
                _hit("trend created");
            }
        }
        for (uint256 i; i < r.settlements.length; ++i) {
            _recordSettlement(r.settlements[i].id, r.settlements[i].expiry);
        }
    }

    function _recordSettlement(bytes32 id, uint64 expiry) internal {
        if (_recorded[id][expiry]) return;
        (bool finalized, uint64 value) = registry.settlementOf(id, expiry);
        if (!finalized) return;
        _recorded[id][expiry] = true;
        _settled.push(Settled({id: id, expiry: expiry, value: value}));
        _hit("settlement finalized");
        if (value != _expectedSettlement(id, expiry)) ++settlementMismatches;
    }

    /// @dev Linear scan, independent of the registry's binary search.
    function _expectedSettlement(bytes32 id, uint64 expiry) internal view returns (uint64) {
        uint64 retired = registry.retiredAt(id);
        if (retired != 0 && retired <= expiry) {
            (uint64 index,) = registry.indexOf(id);
            return index;
        }
        uint256 n = registry.checkpointCount(id);
        for (uint256 i; i < n; ++i) {
            (uint64 at, uint64 value) = registry.checkpointAt(id, i);
            if (at >= expiry) {
                return at <= expiry + registry.settlementTolerance() ? value : type(uint64).max;
            }
        }
        return type(uint64).max;
    }

    /// @dev Mostly moves within the breaker, sometimes huge jumps and out-of-range values.
    function _randomIndex(uint256 seed, uint64 current) internal view returns (uint64) {
        if (current == 0) current = 40 * POINT;
        uint256 mode = seed % 10;
        uint256 v;
        if (mode < 6) v = _bound(seed >> 8, uint256(current) / 2, uint256(current) * 3 / 2);
        else if (mode == 6) v = uint256(current) * 10;
        else if (mode == 7) v = uint256(current) / 10;
        else if (mode == 8) v = 0;
        else v = uint256(registry.MAX_INDEX()) + 1 + seed % 1e9;
        return uint64(v > type(uint64).max ? type(uint64).max : v);
    }

    function _forgery(uint256 seed) internal view returns (TrendRegistry.Report memory r) {
        r = _emptyReport();
        r.newTrends = new TrendRegistry.NewTrend[](1);
        r.newTrends[0] = TrendRegistry.NewTrend({
            identifier: "forged",
            assetClass: 6,
            index: 999 * POINT,
            surfacer: address(0xBAD),
            smartMoneyConfirmed: true
        });
        if (trends.length > 0) {
            r.updates = new TrendRegistry.IndexUpdate[](1);
            r.updates[0] =
                TrendRegistry.IndexUpdate({id: trends[seed % trends.length], index: registry.MAX_INDEX()});
        }
    }
}
