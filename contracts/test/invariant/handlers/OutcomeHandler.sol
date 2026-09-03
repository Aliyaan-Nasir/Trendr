// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {TrendRegistry} from "../../../src/TrendRegistry.sol";
import {ITrendRegistry} from "../../../src/interfaces/ITrendRegistry.sol";
import {OutcomeMarkets} from "../../../src/outcome/OutcomeMarkets.sol";
import {OutcomeToken} from "../../../src/outcome/OutcomeToken.sol";
import {MockStable} from "../../mocks/MockStable.sol";
import {OracleDriver} from "./OracleDriver.sol";

contract OutcomeHandler is OracleDriver {
    OutcomeMarkets internal immutable outcomes;
    MockStable internal immutable ausd;

    string[] internal identifiers;
    bytes32[] public trends;
    bytes32[] public series;
    address[] public actors;

    uint256 public ghostDeposited;
    uint256 public ghostPaid;

    constructor(TrendRegistry registry_, OutcomeMarkets outcomes_, MockStable ausd_) OracleDriver(registry_) {
        outcomes = outcomes_;
        ausd = ausd_;
        actors.push(address(0xA1));
        actors.push(address(0xA2));
        actors.push(address(0xA3));
        for (uint256 i; i < actors.length; ++i) {
            vm.prank(actors[i]);
            ausd.approve(address(outcomes), type(uint256).max);
        }
    }

    // --- views for the invariant contract --------------------------------------------------

    function seriesCount() external view returns (uint256) {
        return series.length;
    }

    function actorCount() external view returns (uint256) {
        return actors.length;
    }

    // --- actions ----------------------------------------------------------------------------

    function createTrend(uint256 seed) external {
        if (trends.length >= 3) return;
        string memory identifier = string.concat("topic-", vm.toString(trends.length));
        identifiers.push(identifier);
        trends.push(_create(identifier, uint64(_bound(seed, 10, 80)) * POINT, address(0x5EED)));
    }

    function openSeries(uint256 trendSeed, bool weekly) external {
        if (trends.length == 0) return;
        uint256 t = trendSeed % trends.length;
        try outcomes.openSeries(identifiers[t], weekly ? 7 days : 1 days) returns (bytes32 id) {
            series.push(id);
        } catch {}
    }

    function mint(uint256 actorSeed, uint256 seriesSeed, uint256 amount) external {
        // Scan from the picked series to the first one still open for minting.
        bytes32 id;
        for (uint256 i; i < series.length; ++i) {
            bytes32 candidate = series[(seriesSeed % series.length + i) % series.length];
            OutcomeMarkets.Series memory s = outcomes.seriesOf(candidate);
            if (
                vm.getBlockTimestamp() < s.expiry
                    && registry.statusOf(s.trendId) == ITrendRegistry.Status.Active
            ) {
                id = candidate;
                break;
            }
        }
        if (id == bytes32(0)) return;
        address a = actors[actorSeed % actors.length];
        amount = _bound(amount, 1, 1000 * UNIT);
        ausd.mint(a, amount);
        vm.prank(a);
        try outcomes.mint(id, amount, a) {
            _hit("mint");
            ghostDeposited += amount;
        } catch (bytes memory reason) {
            _unexpected(reason);
        }
    }

    function redeemSets(uint256 actorSeed, uint256 seriesSeed, uint256 amount) external {
        (bool ok, bytes32 id, OutcomeMarkets.Series memory s) = _pick(seriesSeed);
        if (!ok) return;
        address a = actors[actorSeed % actors.length];
        uint256 pairs = _min(s.up.balanceOf(a), s.down.balanceOf(a));
        if (pairs == 0) return;
        amount = _bound(amount, 1, pairs);
        uint256 before = ausd.balanceOf(a);
        vm.prank(a);
        try outcomes.redeemSets(id, amount, a) {
            _hit("redeem sets");
            ghostPaid += ausd.balanceOf(a) - before;
        } catch (bytes memory reason) {
            _unexpected(reason);
        }
    }

    function redeemWinnings(uint256 actorSeed, uint256 seriesSeed, uint256 upAmount, uint256 downAmount)
        external
    {
        (bool ok, bytes32 id, OutcomeMarkets.Series memory s) = _pick(seriesSeed);
        if (!ok || vm.getBlockTimestamp() < s.expiry) return;
        if (s.outcome == OutcomeMarkets.Outcome.Open && !_settleable(s)) return;
        address a = actors[actorSeed % actors.length];
        upAmount = _bound(upAmount, 0, s.up.balanceOf(a));
        downAmount = _bound(downAmount, 0, s.down.balanceOf(a));
        if (upAmount == 0 && downAmount == 0) return;
        uint256 before = ausd.balanceOf(a);
        vm.prank(a);
        try outcomes.redeemWinnings(id, upAmount, downAmount, a) {
            OutcomeMarkets.Outcome outcome = outcomes.seriesOf(id).outcome;
            _hit(
                outcome == OutcomeMarkets.Outcome.Up
                    ? "redeem up win"
                    : outcome == OutcomeMarkets.Outcome.Down ? "redeem down win" : "redeem void"
            );
            ghostPaid += ausd.balanceOf(a) - before;
        } catch (bytes memory reason) {
            _unexpected(reason);
        }
    }

    /// @notice Splits sets across holders so redemptions see unpaired tokens.
    function transferTokens(uint256 fromSeed, uint256 toSeed, uint256 seriesSeed, uint256 amount, bool up)
        external
    {
        (bool ok,, OutcomeMarkets.Series memory s) = _pick(seriesSeed);
        if (!ok) return;
        address from = actors[fromSeed % actors.length];
        address to = actors[toSeed % actors.length];
        OutcomeToken token = up ? s.up : s.down;
        uint256 balance = token.balanceOf(from);
        if (balance == 0) return;
        amount = _bound(amount, 1, balance);
        vm.prank(from);
        token.transfer(to, amount);
    }

    function moveIndex(uint256 trendSeed, uint256 seed, uint256 secs) external {
        if (trends.length == 0) return;
        bytes32 id = trends[trendSeed % trends.length];
        _advance(_bound(secs, 30, 2 hours));
        if (registry.statusOf(id) == ITrendRegistry.Status.Retired) return;
        _walk(id, seed);
    }

    function idle(uint256 secs) external {
        _advance(_bound(secs, 1 hours, 1 days));
    }

    /// @notice Plays the oracle at expiry: jumps to just after it, observes, and asks for the
    ///         settlement value. Past the tolerance window the request finds nothing and the
    ///         series heads for void, as in an oracle outage.
    function requestSettlement(uint256 seriesSeed, uint256 seed, uint256 offset) external {
        (bool ok,, OutcomeMarkets.Series memory s) = _pick(seriesSeed);
        if (!ok) return;
        if (vm.getBlockTimestamp() < s.expiry) {
            _advance(s.expiry + _bound(offset, 0, 5 minutes) - vm.getBlockTimestamp());
            if (registry.statusOf(s.trendId) != ITrendRegistry.Status.Retired) _walk(s.trendId, seed);
        }
        _requestSettlement(s.trendId, s.expiry);
    }

    function pokeLifecycle(uint256 trendSeed) external {
        if (trends.length == 0) return;
        try registry.pokeLifecycle(trends[trendSeed % trends.length]) {} catch {}
    }

    // --- exit -------------------------------------------------------------------------------

    /// @notice Settles every series and redeems every token. Called once a run ends.
    function exitAll() external {
        _advance(10 days);
        for (uint256 i; i < series.length; ++i) {
            OutcomeMarkets.Series memory s = outcomes.seriesOf(series[i]);
            // Past expiry plus the void grace, settling can never fail.
            if (s.outcome == OutcomeMarkets.Outcome.Open) {
                try outcomes.settle(series[i]) {}
                catch (bytes memory reason) {
                    _unexpected(reason);
                }
            }
            for (uint256 j; j < actors.length; ++j) {
                address a = actors[j];
                uint256 pairs = _min(s.up.balanceOf(a), s.down.balanceOf(a));
                uint256 before = ausd.balanceOf(a);
                if (pairs > 0) {
                    vm.prank(a);
                    try outcomes.redeemSets(series[i], pairs, a) {}
                    catch (bytes memory reason) {
                        _unexpected(reason);
                    }
                }
                uint256 up = s.up.balanceOf(a);
                uint256 down = s.down.balanceOf(a);
                if (up + down > 0) {
                    vm.prank(a);
                    try outcomes.redeemWinnings(series[i], up, down, a) {}
                    catch (bytes memory reason) {
                        _unexpected(reason);
                    }
                }
                ghostPaid += ausd.balanceOf(a) - before;
            }
        }
    }

    // --- helpers ----------------------------------------------------------------------------

    function _pick(uint256 seed) internal view returns (bool, bytes32, OutcomeMarkets.Series memory s) {
        if (series.length == 0) return (false, bytes32(0), s);
        bytes32 id = series[seed % series.length];
        return (true, id, outcomes.seriesOf(id));
    }

    function _settleable(OutcomeMarkets.Series memory s) internal view returns (bool) {
        (bool finalized,) = registry.settlementOf(s.trendId, s.expiry);
        return finalized || vm.getBlockTimestamp() >= uint256(s.expiry) + outcomes.VOID_GRACE();
    }

    function _min(uint256 a, uint256 b) internal pure returns (uint256) {
        return a < b ? a : b;
    }
}
