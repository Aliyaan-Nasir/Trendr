// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

/// @title ICurationFees
/// @notice Fee-generating modules route a share of their fees here; each trend's share
///         accrues to the account that first surfaced the trend.
interface ICurationFees {
    /// @notice Pulls `amount` collateral from the caller and credits it to `trendId`'s surfacer.
    function accrue(bytes32 trendId, uint256 amount) external;
}
