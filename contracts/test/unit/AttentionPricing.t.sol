// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Test} from "forge-std/Test.sol";

import {AttentionPricing} from "../../src/spot/AttentionPricing.sol";

/// @notice The on-chain model must agree with the market maker's (apps/market-maker/src/pricing.ts
///         with DEFAULT_PRIOR). Expected values come from that TypeScript implementation.
contract AttentionPricingTest is Test {
    uint256 internal constant WAD = 1e18;
    /// @dev Agreement to 1e-9 AUSD per token.
    uint256 internal constant TOLERANCE = 1e9;

    function _cdf(int256 z, uint256 expected) internal pure {
        assertApproxEqAbs(AttentionPricing.normCdf(z), expected, TOLERANCE);
    }

    function _up(uint256 index, uint256 opening, uint256 tau, uint256 expected) internal pure {
        assertApproxEqAbs(AttentionPricing.upProbability(index, opening, tau), expected, TOLERANCE);
    }

    function test_normCdfMatchesTheMarketMaker() public pure {
        _cdf(-9_500_000_000_000_000_000, 0);
        _cdf(-4_000_000_000_000_000_000, 31_686_036_064_293);
        _cdf(-2_500_000_000_000_000_000, 6_209_680_111_438_021);
        _cdf(-1_960_000_000_000_000_000, 24_997_826_108_223_876);
        _cdf(-1_000_000_000_000_000_000, 158_655_263_832_363_712);
        _cdf(-500_000_000_000_000_000, 308_537_537_276_006_208);
        _cdf(-100_000_000_000_000_000, 460_172_105_602_830_272);
        _cdf(0, 500_000_000_500_000_064);
        _cdf(100_000_000_000_000_000, 539_827_894_397_169_728);
        _cdf(500_000_000_000_000_000, 691_462_462_723_993_856);
        _cdf(1_000_000_000_000_000_000, 841_344_736_167_636_224);
        _cdf(1_645_000_000_000_000_000, 950_015_108_394_670_592);
        _cdf(2_500_000_000_000_000_000, 993_790_319_888_562_048);
        _cdf(4_000_000_000_000_000_000, 999_968_313_963_935_744);
        _cdf(9_500_000_000_000_000_000, WAD);
    }

    function test_upProbabilityMatchesTheMarketMaker() public pure {
        // At the opening level, a day out: a coin flip.
        _up(40_000_000, 40_000_000, 86_400, 500_000_000_500_000_064);
        _up(41_000_000, 40_000_000, 86_400, 516_413_641_329_945_024);
        _up(39_000_000, 40_000_000, 86_400, 483_171_024_073_350_528);
        _up(80_000_000, 40_000_000, 86_400, 876_004_948_058_724_736);
        _up(20_000_000, 40_000_000, 86_400, 123_995_051_941_275_248);
        // Live Testnet series as the market maker priced them.
        _up(55_800_000, 40_000_000, 45_000, 778_990_099_114_531_968);
        _up(40_900_000, 40_000_000, 47_520, 519_940_676_000_877_888);
        _up(60_700_000, 40_000_000, 44_640, 833_239_123_814_144_384);
        _up(29_440_000, 40_000_000, 48_600, 247_882_838_606_973_920);
        // Close to expiry the index likely stays where it is.
        _up(45_000_000, 40_000_000, 600, 0.98e18);
        _up(35_000_000, 40_000_000, 600, 0.02e18);
        _up(45_000_000, 40_000_000, 60, 0.98e18);
        // A week out.
        _up(40_000_000, 40_000_000, 604_800, 500_000_000_500_000_064);
        _up(70_000_000, 40_000_000, 604_800, 637_777_577_867_537_664);
        _up(12_000_000, 40_000_000, 604_800, 224_096_262_917_875_776);
        // Extremes stay within the bounds.
        _up(100_000_000, 1_000_000, 3600, 0.98e18);
        _up(1_000_000, 100_000_000, 3600, 0.02e18);
        _up(1, 50_000_000, 86_400, 0.02e18);
        _up(50_000_000, 50_000_000, 1, 0.02e18);
    }

    function test_edgeCases() public pure {
        // Expired: decided by where the index stands, within the bounds.
        assertEq(AttentionPricing.upProbability(41e6, 40e6, 0), 0.98e18);
        assertEq(AttentionPricing.upProbability(40e6, 40e6, 0), 0.02e18, "ties go DOWN");
        // A zero index or opening takes the log's limits.
        assertEq(AttentionPricing.upProbability(0, 40e6, 86_400), 0.02e18);
        assertEq(AttentionPricing.upProbability(40e6, 0, 86_400), 0.98e18);
        assertEq(AttentionPricing.upProbability(0, 0, 86_400), 0.02e18);
    }

    function testFuzz_boundedAndMonotonicInTheIndex(uint64 index, uint64 opening, uint32 tau, uint64 step)
        public
        pure
    {
        index = uint64(bound(index, 0, 1000e6));
        opening = uint64(bound(opening, 0, 1000e6));
        tau = uint32(bound(tau, 0, 30 days));
        step = uint64(bound(step, 0, 1000e6));
        uint256 p = AttentionPricing.upProbability(index, opening, tau);
        assertGe(p, AttentionPricing.MIN_PROBABILITY);
        assertLe(p, AttentionPricing.MAX_PROBABILITY);
        // A higher index never makes UP less likely (allowing for rounding).
        assertGe(AttentionPricing.upProbability(uint256(index) + step, opening, tau) + 1e6, p);
    }

    function testFuzz_normCdfIsSymmetric(int256 z) public pure {
        z = bound(z, -12e18, 12e18);
        uint256 sum = AttentionPricing.normCdf(z) + AttentionPricing.normCdf(-z);
        assertApproxEqAbs(sum, WAD, 2e9);
    }
}
