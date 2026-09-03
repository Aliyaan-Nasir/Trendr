// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";
import {FixedPointMathLib} from "solady/utils/FixedPointMathLib.sol";

/// @title AttentionPricing
/// @notice The attention-implied value of an UP token: the probability that a trend's index ends
///         above its series' opening index (UP pays 1 AUSD then, DOWN otherwise; ties go DOWN).
///         It is the market maker's model (apps/market-maker/src/pricing.ts) with its prior
///         dynamics fixed, so it needs nothing but the oracle's latest index:
///
///         With probability q = exp(-lambda * tau) the index does not change again before expiry,
///         and UP wins exactly when it is already above the opening. Otherwise it diffuses in log
///         terms with variance rate sigma^2, and UP wins with probability
///         N(ln(I / I0) / (sigma * sqrt(tau))). The result is bounded to [0.02, 0.98].
///
///         All values are 1e18-scaled (WAD) unless noted.
library AttentionPricing {
    using SafeCast for uint256;
    using SafeCast for int256;

    uint256 internal constant WAD = 1e18;
    /// @notice Log-variance per second while the index moves: about 60% daily volatility.
    uint256 internal constant VARIANCE_PER_SEC = uint256(0.36e18) / 86_400;
    /// @notice Index changes per second: one every ten minutes.
    uint256 internal constant CHANGES_PER_SEC = WAD / 600;
    uint256 internal constant MIN_PROBABILITY = 0.02e18;
    uint256 internal constant MAX_PROBABILITY = 0.98e18;

    int256 private constant IWAD = 1e18;
    int256 private constant SQRT2 = 1_414_213_562_373_095_049;
    // Abramowitz and Stegun 7.1.26 (error below 1.5e-7), as the market maker's normCdf uses it.
    int256 private constant P = 327_591_100_000_000_000;
    int256 private constant A1 = 254_829_592_000_000_000;
    int256 private constant A2 = -284_496_736_000_000_000;
    int256 private constant A3 = 1_421_413_741_000_000_000;
    int256 private constant A4 = -1_453_152_027_000_000_000;
    int256 private constant A5 = 1_061_405_429_000_000_000;
    /// @dev Beyond ten standard deviations the normal CDF is 0 or 1 to WAD precision.
    int256 private constant MAX_Z = 10e18;

    /// @notice Probability that UP wins, given the latest index and the opening index (both with
    ///         the registry's 6 decimals) and the seconds left to expiry.
    function upProbability(uint256 index, uint256 opening, uint256 tau) internal pure returns (uint256 p) {
        uint256 above = index > opening ? WAD : 0;
        if (tau == 0) {
            p = above;
        } else {
            uint256 stay = FixedPointMathLib.expWad(-(CHANGES_PER_SEC * tau).toInt256()).toUint256();
            p = (stay * above + (WAD - stay) * _diffuse(index, opening, tau)) / WAD;
        }
        if (p < MIN_PROBABILITY) return MIN_PROBABILITY;
        if (p > MAX_PROBABILITY) return MAX_PROBABILITY;
    }

    /// @notice The standard normal CDF at `z`.
    function normCdf(int256 z) internal pure returns (uint256) {
        if (z >= MAX_Z) return WAD;
        if (z <= -MAX_Z) return 0;
        int256 a = z < 0 ? -z : z;
        // t = 1 / (1 + p |z| / sqrt 2), and erf(|z| / sqrt 2) = 1 - poly(t) exp(-z^2 / 2).
        int256 t = IWAD * IWAD / (IWAD + P * a / SQRT2);
        // Horner's rule in fixed point divides at every step by design.
        // slither-disable-start divide-before-multiply
        // forge-lint: disable-start(divide-before-multiply)
        int256 s = A4 + t * A5 / IWAD;
        s = A3 + t * s / IWAD;
        s = A2 + t * s / IWAD;
        s = A1 + t * s / IWAD;
        int256 poly = t * s / IWAD;
        int256 erf = IWAD - poly * FixedPointMathLib.expWad(-(a * a / IWAD / 2)) / IWAD;
        // forge-lint: disable-end(divide-before-multiply)
        // slither-disable-end divide-before-multiply
        if (erf < 0) erf = 0;
        return (z >= 0 ? (IWAD + erf) / 2 : (IWAD - erf) / 2).toUint256();
    }

    /// @dev N(ln(I / I0) / (sigma sqrt(tau))), with the limits of the log at a zero index.
    function _diffuse(uint256 index, uint256 opening, uint256 tau) private pure returns (uint256) {
        if (opening == 0) return index == 0 ? 0 : WAD;
        uint256 ratio = index * WAD / opening;
        if (ratio == 0) return 0;
        int256 x = FixedPointMathLib.lnWad(ratio.toInt256());
        int256 sd = FixedPointMathLib.sqrt(VARIANCE_PER_SEC * tau * WAD).toInt256();
        return normCdf(x * IWAD / sd);
    }
}
