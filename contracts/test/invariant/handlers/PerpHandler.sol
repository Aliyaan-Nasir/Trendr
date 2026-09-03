// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {CurationFees} from "../../../src/CurationFees.sol";
import {TrendRegistry} from "../../../src/TrendRegistry.sol";
import {ITrendRegistry} from "../../../src/interfaces/ITrendRegistry.sol";
import {AttentionPerp} from "../../../src/perp/AttentionPerp.sol";
import {MockStable} from "../../mocks/MockStable.sol";
import {OracleDriver} from "./OracleDriver.sol";

contract PerpHandler is OracleDriver {
    AttentionPerp internal immutable perp;
    MockStable internal immutable ausd;
    CurationFees internal immutable curation;

    bytes32[] public trends;
    address[] public actors;
    uint256[] public openIds;

    /// @notice Funding settled by closed, liquidated and retired positions (positive is paid in).
    int256 public realizedFunding;
    /// @notice Positions not owned by the account they were opened for; must stay zero.
    uint256 public ownerMismatches;

    constructor(TrendRegistry registry_, AttentionPerp perp_, MockStable ausd_, CurationFees curation_)
        OracleDriver(registry_)
    {
        perp = perp_;
        ausd = ausd_;
        curation = curation_;
        actors.push(address(0xA1));
        actors.push(address(0xA2));
        actors.push(address(0xA3));
        actors.push(address(0xA4));
        for (uint256 i; i < actors.length; ++i) {
            vm.prank(actors[i]);
            ausd.approve(address(perp), type(uint256).max);
        }
        ausd.approve(address(perp), type(uint256).max);
    }

    function trendCount() external view returns (uint256) {
        return trends.length;
    }

    function openCount() external view returns (uint256) {
        return openIds.length;
    }

    // --- actions ----------------------------------------------------------------------------

    /// @notice Keeps up to two live trends, replacing retired ones, six in total.
    function createTrend(uint256 seed) external {
        uint256 live;
        for (uint256 i; i < trends.length; ++i) {
            if (registry.statusOf(trends[i]) != ITrendRegistry.Status.Retired) ++live;
        }
        if (live >= 2 || trends.length >= 6) return;
        string memory identifier = string.concat("perp-", vm.toString(trends.length));
        // Odd trends have no surfacer, so their curation share goes to the treasury.
        trends.push(
            _create(
                identifier,
                uint64(_bound(seed, 6, 80)) * POINT,
                trends.length % 2 == 0 ? address(0x5EED) : address(0)
            )
        );
    }

    function open(uint256 actorSeed, uint256 trendSeed, bool isLong, uint256 margin, uint256 leverage)
        external
    {
        if (trends.length == 0) return;
        bytes32 trend = trends[trendSeed % trends.length];
        if (registry.statusOf(trend) != ITrendRegistry.Status.Active) return;
        _refresh(trend);
        // A fresh observation can move a trend below the floor into cooling.
        if (registry.statusOf(trend) != ITrendRegistry.Status.Active) return;
        address a = actors[actorSeed % actors.length];
        // A third of positions are paid for by another actor through openFor.
        address payer = actorSeed % 3 == 0 ? actors[(actorSeed / 3) % actors.length] : a;
        margin = _bound(margin, 2 * UNIT, 2000 * UNIT);
        leverage = _bound(leverage, 0.5e18, 3e18);
        ausd.mint(payer, margin);
        vm.prank(payer);
        try perp.openFor(
            a, trend, isLong, margin, leverage, isLong ? type(uint64).max : 0, vm.getBlockTimestamp()
        ) returns (
            uint256 id
        ) {
            _hit(isLong ? "open long" : "open short");
            if (payer != a) _hit("open for another owner");
            if (perp.positionOf(id).owner != a) ++ownerMismatches;
            openIds.push(id);
        } catch (bytes memory reason) {
            if (bytes4(reason) != AttentionPerp.OpenInterestCap.selector) _unexpected(reason);
        }
    }

    function close(uint256 idSeed) external {
        (bool ok, uint256 slot, uint256 id, AttentionPerp.Position memory p) = _pick(idSeed);
        if (!ok) return;
        _refresh(p.trendId);
        if (registry.statusOf(p.trendId) == ITrendRegistry.Status.Retired) return;
        (,, int256 funding,) = perp.positionState(id);
        uint256 poolBefore = perp.pool() + p.margin;
        vm.prank(p.owner);
        try perp.close(id, p.isLong ? 0 : type(uint64).max, vm.getBlockTimestamp()) returns (uint256 payout) {
            _hit(payout == poolBefore ? "close with shortfall" : "close");
            _hit(
                funding < 0
                    ? "close receiving funding"
                    : funding > 0 ? "close paying funding" : "close without funding"
            );
            realizedFunding += funding;
            _remove(slot);
        } catch (bytes memory reason) {
            _unexpected(reason);
        }
    }

    function settleRetired(uint256 idSeed) external {
        (bool ok, uint256 slot, uint256 id, AttentionPerp.Position memory p) = _pick(idSeed);
        if (!ok || registry.statusOf(p.trendId) != ITrendRegistry.Status.Retired) return;
        (,, int256 funding,) = perp.positionState(id);
        try perp.settleRetired(id) {
            _hit("settle retired");
            realizedFunding += funding;
            _remove(slot);
        } catch (bytes memory reason) {
            _unexpected(reason);
        }
    }

    function liquidate(uint256 idSeed) external {
        (bool ok, uint256 slot, uint256 id, AttentionPerp.Position memory p) = _pick(idSeed);
        if (!ok) return;
        _refresh(p.trendId);
        (,, int256 funding,) = perp.positionState(id);
        try perp.liquidate(id) {
            _hit("liquidate");
            realizedFunding += funding;
            _remove(slot);
        } catch (bytes memory reason) {
            bytes4 selector = bytes4(reason);
            if (
                selector != AttentionPerp.NotLiquidatable.selector
                    && selector != AttentionPerp.TrendRetired.selector
            ) {
                _unexpected(reason);
            }
        }
    }

    function addMargin(uint256 idSeed, uint256 amount) external {
        (bool ok,, uint256 id, AttentionPerp.Position memory p) = _pick(idSeed);
        if (!ok) return;
        amount = _bound(amount, 1, 500 * UNIT);
        ausd.mint(p.owner, amount);
        vm.prank(p.owner);
        try perp.addMargin(id, amount) {}
        catch (bytes memory reason) {
            _unexpected(reason);
        }
    }

    function moveIndex(uint256 trendSeed, uint256 seed, uint256 secs) external {
        if (trends.length == 0) return;
        bytes32 trend = trends[trendSeed % trends.length];
        _advance(_bound(secs, 1, 10 minutes));
        if (registry.statusOf(trend) == ITrendRegistry.Status.Retired) return;
        _walk(trend, seed);
    }

    /// @notice Two maximal index moves in one direction, which pushes leveraged positions on the
    ///         other side into liquidation.
    function shock(uint256 trendSeed, bool up) external {
        if (trends.length == 0) return;
        bytes32 trend = trends[trendSeed % trends.length];
        for (uint256 i; i < 2; ++i) {
            if (registry.statusOf(trend) == ITrendRegistry.Status.Retired) return;
            (uint64 index,) = registry.indexOf(trend);
            _advance(30);
            uint256 next = up ? uint256(index) * 2 : uint256(index) / 2;
            if (next < registry.MIN_INDEX()) next = registry.MIN_INDEX();
            if (next > registry.MAX_INDEX()) next = registry.MAX_INDEX();
            _push(trend, uint64(next));
        }
    }

    /// @notice Lets blocks pass so funding accrues.
    function rollBlocks(uint256 secs) external {
        _advance(_bound(secs, 1, 5 minutes));
    }

    function poke(uint256 trendSeed) external {
        if (trends.length == 0) return;
        perp.poke(trends[trendSeed % trends.length]);
    }

    function depositPool(uint256 amount) external {
        amount = _bound(amount, 1, 5000 * UNIT);
        ausd.mint(address(this), amount);
        perp.depositPool(amount);
    }

    function sweepFees() external {
        if (perp.protocolFees() == 0) return;
        perp.sweepProtocolFees();
    }

    function claimCuration(bool treasury) external {
        address who = treasury ? address(0x7EA5) : address(0x5EED);
        if (curation.claimable(who) == 0) return;
        vm.prank(who);
        curation.claim(who);
    }

    /// @notice Drives a trend below the attention floor until it retires.
    function retire(uint256 trendSeed) external {
        if (trends.length == 0) return;
        bytes32 trend = trends[trendSeed % trends.length];
        for (uint256 i; i < 16 && registry.statusOf(trend) != ITrendRegistry.Status.Retired; ++i) {
            (uint64 index,) = registry.indexOf(trend);
            _advance(20 minutes);
            _push(trend, index / 2 < registry.MIN_INDEX() ? registry.MIN_INDEX() : index / 2);
        }
    }

    // --- exit -------------------------------------------------------------------------------

    /// @notice Closes or settles every open position. Called once a run ends.
    function exitAll() external {
        while (openIds.length > 0) {
            uint256 id = openIds[openIds.length - 1];
            AttentionPerp.Position memory p = perp.positionOf(id);
            _refresh(p.trendId);
            (,, int256 funding,) = perp.positionState(id);
            bool retired = registry.statusOf(p.trendId) == ITrendRegistry.Status.Retired;
            vm.prank(p.owner);
            (bool ok, bytes memory reason) = address(perp)
                .call(
                    retired
                        ? abi.encodeCall(AttentionPerp.settleRetired, (id))
                        : abi.encodeCall(
                            AttentionPerp.close, (id, p.isLong ? 0 : type(uint64).max, vm.getBlockTimestamp())
                        )
                );
            if (!ok) _unexpected(reason);
            realizedFunding += funding;
            openIds.pop();
        }
    }

    // --- helpers ----------------------------------------------------------------------------

    function _pick(uint256 seed)
        internal
        view
        returns (bool, uint256 slot, uint256 id, AttentionPerp.Position memory p)
    {
        if (openIds.length == 0) return (false, 0, 0, p);
        slot = seed % openIds.length;
        id = openIds[slot];
        p = perp.positionOf(id);
        return (true, slot, id, p);
    }

    /// @notice Plays the oracle keeping a live trend fresh, as the CRE workflow does.
    function _refresh(bytes32 trend) internal {
        if (registry.isFresh(trend) || registry.statusOf(trend) == ITrendRegistry.Status.Retired) return;
        (uint64 index,) = registry.indexOf(trend);
        _advance(1);
        _push(trend, index);
    }

    function _remove(uint256 slot) internal {
        openIds[slot] = openIds[openIds.length - 1];
        openIds.pop();
    }
}
