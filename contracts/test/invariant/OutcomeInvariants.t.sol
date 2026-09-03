// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {OutcomeMarkets} from "../../src/outcome/OutcomeMarkets.sol";
import {InvariantBase} from "./InvariantBase.sol";
import {OutcomeHandler} from "./handlers/OutcomeHandler.sol";

/// @notice Outcome markets: every complete set is fully backed, payouts never exceed deposits,
///         and every holder can always exit.
contract OutcomeInvariants is InvariantBase {
    OutcomeHandler internal handler;

    function setUp() public override {
        super.setUp();
        handler = new OutcomeHandler(registry, outcomes, ausd);
        handler.createTrend(40);
        handler.openSeries(0, false);
        handler.openSeries(0, true);

        bytes4[] memory selectors = new bytes4[](10);
        selectors[0] = OutcomeHandler.createTrend.selector;
        selectors[1] = OutcomeHandler.openSeries.selector;
        selectors[2] = OutcomeHandler.mint.selector;
        selectors[3] = OutcomeHandler.redeemSets.selector;
        selectors[4] = OutcomeHandler.redeemWinnings.selector;
        selectors[5] = OutcomeHandler.transferTokens.selector;
        selectors[6] = OutcomeHandler.moveIndex.selector;
        selectors[7] = OutcomeHandler.idle.selector;
        selectors[8] = OutcomeHandler.requestSettlement.selector;
        selectors[9] = OutcomeHandler.pokeLifecycle.selector;
        targetSelector(FuzzSelector({addr: address(handler), selectors: selectors}));
        targetContract(address(handler));
    }

    function invariant_balanceMatchesBacking() public view {
        uint256 sum;
        for (uint256 i; i < handler.seriesCount(); ++i) {
            sum += outcomes.seriesOf(handler.series(i)).backing;
        }
        assertEq(outcomes.totalBacking(), sum, "total backing");
        assertEq(ausd.balanceOf(address(outcomes)), sum, "balance");
    }

    function invariant_completeSetsFullyBacked() public view {
        for (uint256 i; i < handler.seriesCount(); ++i) {
            bytes32 id = handler.series(i);
            OutcomeMarkets.Series memory s = outcomes.seriesOf(id);
            assertGe(s.backing, outcomes.obligations(id), "obligations exceed backing");
            if (s.outcome == OutcomeMarkets.Outcome.Open) {
                assertEq(s.up.totalSupply(), s.backing, "open UP supply");
                assertEq(s.down.totalSupply(), s.backing, "open DOWN supply");
            }
        }
    }

    function invariant_payoutsNeverExceedDeposits() public view {
        assertEq(handler.ghostDeposited(), handler.ghostPaid() + ausd.balanceOf(address(outcomes)));
    }

    function invariant_holdersCanAlwaysExit() public view {
        assertEq(handler.unexpectedReverts(), 0, vm.toString(handler.lastUnexpectedRevert()));
    }

    /// @notice After a run, everything settles and every token redeems; what stays behind is
    ///         exactly the forfeited losing side.
    function afterInvariant() public {
        string[] memory paths = new string[](5);
        paths[0] = "mint";
        paths[1] = "redeem sets";
        paths[2] = "redeem up win";
        paths[3] = "redeem down win";
        paths[4] = "redeem void";
        _reportCoverage(handler, paths);
        handler.exitAll();
        assertEq(handler.unexpectedReverts(), 0, vm.toString(handler.lastUnexpectedRevert()));
        uint256 remaining;
        for (uint256 i; i < handler.seriesCount(); ++i) {
            bytes32 id = handler.series(i);
            OutcomeMarkets.Series memory s = outcomes.seriesOf(id);
            assertTrue(s.outcome != OutcomeMarkets.Outcome.Open, "unsettled after exit");
            assertEq(s.up.totalSupply() + s.down.totalSupply(), 0, "tokens left");
            remaining += s.backing;
        }
        assertEq(ausd.balanceOf(address(outcomes)), remaining);
        assertEq(handler.ghostDeposited(), handler.ghostPaid() + remaining);
    }
}
