// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {BondingCurve} from "../../src/curve/BondingCurve.sol";
import {ICurationFees} from "../../src/interfaces/ICurationFees.sol";
import {IGraduationVenue} from "../../src/interfaces/IGraduationVenue.sol";
import {ITrendRegistry} from "../../src/interfaces/ITrendRegistry.sol";
import {InvariantBase} from "./InvariantBase.sol";
import {CurveHandler} from "./handlers/CurveHandler.sol";

/// @notice Bonding curves: always able to buy back every coin, balances match the books, the
///         attention floor only rises, and graduation moves exactly the reserves.
contract CurveInvariants is InvariantBase {
    CurveHandler internal handler;
    uint256 internal constant T = 1_000_000_000e18;

    function setUp() public override {
        super.setUp();
        // A low graduation threshold so campaigns fill curves and exercise graduation.
        curve = new BondingCurve(
            ausd,
            ITrendRegistry(address(registry)),
            ICurationFees(address(curation)),
            IGraduationVenue(address(venue)),
            TREASURY,
            2000 * UNIT,
            2000 * UNIT
        );
        handler = new CurveHandler(registry, curve, ausd, venue, curation);
        handler.createCurve(40);

        bytes4[] memory selectors = new bytes4[](11);
        selectors[0] = CurveHandler.createCurve.selector;
        selectors[1] = CurveHandler.buy.selector;
        selectors[2] = CurveHandler.buy.selector; // weighted so curves fill and graduate
        selectors[3] = CurveHandler.buy.selector;
        selectors[4] = CurveHandler.bigBuy.selector;
        selectors[5] = CurveHandler.sell.selector;
        selectors[6] = CurveHandler.syncFloor.selector;
        selectors[7] = CurveHandler.moveIndex.selector;
        selectors[8] = CurveHandler.graduate.selector;
        selectors[9] = CurveHandler.sweepFees.selector;
        selectors[10] = CurveHandler.claimCuration.selector;
        targetSelector(FuzzSelector({addr: address(handler), selectors: selectors}));
        targetContract(address(handler));
    }

    function invariant_curvesCanBuyBackEveryCoin() public view {
        for (uint256 t; t < handler.trendCount(); ++t) {
            BondingCurve.Curve memory c = curve.curveOf(handler.trends(t));
            if (c.state == BondingCurve.State.Graduated) continue;
            assertGe(c.reserve * (T - c.sold), c.virtualQuote * c.sold, "insolvent curve");
        }
    }

    function invariant_balanceMatchesBooks() public view {
        uint256 owed = curve.protocolFees();
        for (uint256 t; t < handler.trendCount(); ++t) {
            BondingCurve.Curve memory c = curve.curveOf(handler.trends(t));
            owed += c.reserve + c.floorReserve + c.graduationLiquidity;
        }
        assertEq(ausd.balanceOf(address(curve)), owed);
    }

    function invariant_supplyMatchesSold() public view {
        for (uint256 t; t < handler.trendCount(); ++t) {
            BondingCurve.Curve memory c = curve.curveOf(handler.trends(t));
            if (c.state == BondingCurve.State.Graduated) {
                assertEq(c.reserve + c.floorReserve + c.graduationLiquidity, 0, "graduated curve kept funds");
                continue;
            }
            assertEq(IERC20(address(c.coin)).totalSupply(), c.sold, "supply");
        }
    }

    function invariant_floorOnlyRises() public view {
        assertEq(handler.floorDecreases(), 0);
    }

    function invariant_graduationMovesExactlyTheReserves() public view {
        assertEq(handler.graduationMismatches(), 0);
    }

    function invariant_curationSumsAddUp() public view {
        uint256 held = ausd.balanceOf(address(curation));
        assertEq(curation.totalAccrued(), held + curation.totalClaimed(), "accrued");
        assertEq(curation.claimable(SURFACER) + curation.claimable(TREASURY), held, "claimable");
    }

    function invariant_tradesWithinLimitsNeverFail() public view {
        assertEq(handler.unexpectedReverts(), 0, vm.toString(handler.lastUnexpectedRevert()));
    }

    function afterInvariant() public {
        string[] memory paths = new string[](6);
        paths[0] = "buy";
        paths[1] = "sell";
        paths[2] = "price impact rejected";
        paths[3] = "floor raised";
        paths[4] = "filled";
        paths[5] = "graduate";
        _reportCoverage(handler, paths);
        handler.exitAll();
        assertEq(handler.unexpectedReverts(), 0, vm.toString(handler.lastUnexpectedRevert()));
        for (uint256 t; t < handler.trendCount(); ++t) {
            BondingCurve.Curve memory c = curve.curveOf(handler.trends(t));
            if (c.state != BondingCurve.State.Open) continue;
            // Only dust worth nothing can remain unsold.
            assertLe(c.sold, 1e14, "coins left unsold");
            assertGe(c.reserve * (T - c.sold), c.virtualQuote * c.sold);
        }
    }
}
