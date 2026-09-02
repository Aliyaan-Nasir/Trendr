// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {CurationFees} from "../../src/CurationFees.sol";
import {ITrendRegistry} from "../../src/interfaces/ITrendRegistry.sol";
import {Fixture} from "../utils/Fixture.sol";

contract CurationFeesTest is Fixture {
    address internal source = address(0x50);
    bytes32 internal trend;

    function setUp() public override {
        super.setUp();
        trend = createTrend("hantavirus", ITrendRegistry.AssetClass.Topic, 40 * POINT);
        ausd.mint(source, 1000 * UNIT);
        vm.prank(source);
        ausd.approve(address(curation), type(uint256).max);
    }

    function _accrue(bytes32 id, uint256 amount) internal {
        vm.prank(source);
        curation.accrue(id, amount);
    }

    function test_constructorRejectsZeroAddresses() public {
        vm.expectRevert(CurationFees.ZeroAddress.selector);
        new CurationFees(IERC20(address(0)), ITrendRegistry(address(registry)), TREASURY);
        vm.expectRevert(CurationFees.ZeroAddress.selector);
        new CurationFees(ausd, ITrendRegistry(address(0)), TREASURY);
        vm.expectRevert(CurationFees.ZeroAddress.selector);
        new CurationFees(ausd, ITrendRegistry(address(registry)), address(0));
    }

    function test_accrueCreditsSurfacer() public {
        vm.expectEmit(address(curation));
        emit CurationFees.Accrued(trend, SURFACER, source, 5 * UNIT);
        _accrue(trend, 5 * UNIT);
        assertEq(curation.claimable(SURFACER), 5 * UNIT);
        assertEq(curation.earnedByTrend(trend), 5 * UNIT);
        assertEq(curation.earnedByAccount(SURFACER), 5 * UNIT);
        assertEq(curation.totalAccrued(), 5 * UNIT);
        assertEq(ausd.balanceOf(address(curation)), 5 * UNIT);
    }

    function test_unknownTrendCreditsTreasury() public {
        _accrue(keccak256("unknown"), 2 * UNIT);
        assertEq(curation.claimable(TREASURY), 2 * UNIT);
        assertEq(curation.claimable(SURFACER), 0);
    }

    function test_zeroAccrueIsNoop() public {
        _accrue(trend, 0);
        assertEq(curation.totalAccrued(), 0);
        assertEq(ausd.balanceOf(source), 1000 * UNIT);
    }

    function test_claim() public {
        _accrue(trend, 7 * UNIT);
        address to = address(0xC0FFEE);
        vm.prank(SURFACER);
        assertEq(curation.claim(to), 7 * UNIT);
        assertEq(ausd.balanceOf(to), 7 * UNIT);
        assertEq(curation.claimable(SURFACER), 0);
        assertEq(curation.totalClaimed(), 7 * UNIT);
        // Lifetime earnings stay after claiming.
        assertEq(curation.earnedByAccount(SURFACER), 7 * UNIT);

        vm.prank(SURFACER);
        vm.expectRevert(CurationFees.NothingToClaim.selector);
        curation.claim(to);
        vm.prank(SURFACER);
        vm.expectRevert(CurationFees.ZeroAddress.selector);
        curation.claim(address(0));
    }

    function test_productsAccrueToSurfacer() public {
        fund(address(this), 10_000 * UNIT);
        curve.createCurve("hantavirus");
        curve.buy(trend, 100 * UNIT, 0, address(this), block.timestamp);
        perp.depositPool(1000 * UNIT);
        perp.open(trend, true, 100 * UNIT, 2e18, type(uint64).max, block.timestamp);
        assertGt(curation.earnedByTrend(trend), 0);
        assertEq(curation.claimable(SURFACER), curation.earnedByTrend(trend));
        assertEq(ausd.balanceOf(address(curation)), curation.totalAccrued());
    }

    function testFuzz_sumsAddUp(uint96[6] memory amounts, uint8 claimMask) public {
        bytes32 other = keccak256("unknown");
        uint256 total;
        for (uint256 i; i < amounts.length; ++i) {
            uint256 amount = bound(amounts[i], 0, 100 * UNIT);
            _accrue(i % 2 == 0 ? trend : other, amount);
            total += amount;
            if (claimMask & (1 << i) != 0) {
                address who = i % 2 == 0 ? SURFACER : TREASURY;
                if (curation.claimable(who) > 0) {
                    vm.prank(who);
                    curation.claim(who);
                }
            }
        }
        assertEq(curation.totalAccrued(), total);
        assertEq(curation.earnedByTrend(trend) + curation.earnedByTrend(other), total);
        assertEq(curation.claimable(SURFACER) + curation.claimable(TREASURY) + curation.totalClaimed(), total);
        assertEq(ausd.balanceOf(address(curation)), total - curation.totalClaimed());
    }
}
