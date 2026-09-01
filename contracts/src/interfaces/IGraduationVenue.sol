// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

/// @title IGraduationVenue
/// @notice Lists a graduated trend coin on a spot venue and seeds its starting liquidity.
interface IGraduationVenue {
    /// @notice Pulls `baseAmount` of `base` and `quoteAmount` of `quote` from the caller, creates
    ///         or adopts the base/quote market and deposits both as starting liquidity priced at
    ///         quoteAmount / baseAmount.
    /// @return market The spot market the coin now trades on.
    function list(address base, address quote, uint256 baseAmount, uint256 quoteAmount)
        external
        returns (address market);
}
