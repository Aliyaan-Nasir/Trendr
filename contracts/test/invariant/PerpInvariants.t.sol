// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {AttentionPerp} from "../../src/perp/AttentionPerp.sol";
import {InvariantBase} from "./InvariantBase.sol";
import {PerpHandler} from "./handlers/PerpHandler.sol";

/// @notice Attention perps: the contract always holds exactly margins plus pool plus fees,
///         funding never creates money, curation sums add up, and every position can exit.
contract PerpInvariants is InvariantBase {
    PerpHandler internal handler;

    function setUp() public override {
        super.setUp();
        handler = new PerpHandler(registry, perp, ausd, curation);
        handler.createTrend(40);
        handler.depositPool(20_000 * UNIT);

        bytes4[] memory selectors = new bytes4[](15);
        selectors[0] = PerpHandler.createTrend.selector;
        selectors[1] = PerpHandler.open.selector;
        selectors[2] = PerpHandler.open.selector; // weighted: opening drives everything else
        selectors[3] = PerpHandler.close.selector;
        selectors[4] = PerpHandler.settleRetired.selector;
        selectors[5] = PerpHandler.liquidate.selector;
        selectors[6] = PerpHandler.addMargin.selector;
        selectors[7] = PerpHandler.moveIndex.selector;
        selectors[8] = PerpHandler.rollBlocks.selector;
        selectors[9] = PerpHandler.poke.selector;
        selectors[10] = PerpHandler.depositPool.selector;
        selectors[11] = PerpHandler.sweepFees.selector;
        selectors[12] = PerpHandler.claimCuration.selector;
        selectors[13] = PerpHandler.retire.selector;
        selectors[14] = PerpHandler.shock.selector;
        targetSelector(FuzzSelector({addr: address(handler), selectors: selectors}));
        targetContract(address(handler));
    }

    function invariant_balanceIdentity() public view {
        assertEq(ausd.balanceOf(address(perp)), perp.totalMargin() + perp.pool() + perp.protocolFees());
    }

    function invariant_bookMatchesPositions() public view {
        uint256 margins;
        for (uint256 t; t < handler.trendCount(); ++t) {
            bytes32 trend = handler.trends(t);
            uint256 longs;
            uint256 shorts;
            for (uint256 i; i < handler.openCount(); ++i) {
                AttentionPerp.Position memory p = perp.positionOf(handler.openIds(i));
                if (p.trendId != trend) continue;
                if (p.isLong) longs += p.qty;
                else shorts += p.qty;
            }
            (uint256 longQty, uint256 shortQty,,,,) = perp.markets(trend);
            assertEq(longQty, longs, "long open interest");
            assertEq(shortQty, shorts, "short open interest");
        }
        for (uint256 i; i < handler.openCount(); ++i) {
            margins += perp.positionOf(handler.openIds(i)).margin;
        }
        assertEq(perp.totalMargin(), margins, "total margin");
    }

    /// @notice Funding moves value between traders through the pool; payers round up and
    ///         receivers round down, so traders as a whole never receive more than they pay.
    function invariant_fundingConserved() public view {
        int256 total = handler.realizedFunding();
        for (uint256 i; i < handler.openCount(); ++i) {
            (,, int256 funding,) = perp.positionState(handler.openIds(i));
            total += funding;
        }
        assertGe(total, 0);
    }

    function invariant_curationSumsAddUp() public view {
        uint256 held = ausd.balanceOf(address(curation));
        assertEq(curation.totalAccrued(), held + curation.totalClaimed(), "accrued");
        assertEq(curation.claimable(SURFACER) + curation.claimable(TREASURY), held, "claimable");
        uint256 byTrend;
        for (uint256 t; t < handler.trendCount(); ++t) {
            byTrend += curation.earnedByTrend(handler.trends(t));
        }
        assertEq(byTrend, curation.totalAccrued(), "by trend");
    }

    function invariant_positionsBelongToTheirOwner() public view {
        assertEq(handler.ownerMismatches(), 0);
    }

    function invariant_positionsCanAlwaysExit() public view {
        assertEq(handler.unexpectedReverts(), 0, vm.toString(handler.lastUnexpectedRevert()));
    }

    function afterInvariant() public {
        string[] memory paths = new string[](10);
        paths[0] = "open long";
        paths[1] = "open short";
        paths[2] = "close";
        paths[3] = "close with shortfall";
        paths[4] = "close paying funding";
        paths[5] = "close receiving funding";
        paths[6] = "close without funding";
        paths[7] = "liquidate";
        paths[8] = "settle retired";
        paths[9] = "open for another owner";
        _reportCoverage(handler, paths);
        handler.exitAll();
        assertEq(handler.unexpectedReverts(), 0, vm.toString(handler.lastUnexpectedRevert()));
        assertEq(perp.totalMargin(), 0);
        assertEq(ausd.balanceOf(address(perp)), perp.pool() + perp.protocolFees());
        assertGe(handler.realizedFunding(), 0);
    }
}
