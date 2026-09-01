// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

import {IGraduationVenue} from "../../src/interfaces/IGraduationVenue.sol";

/// @notice Graduation venue that records what it received and parks the tokens in itself.
contract MockVenue is IGraduationVenue {
    using SafeERC20 for IERC20;

    uint256 public listings;
    address public lastBase;
    address public lastQuote;
    uint256 public lastBaseAmount;
    uint256 public lastQuoteAmount;

    function list(address base, address quote, uint256 baseAmount, uint256 quoteAmount)
        external
        returns (address market)
    {
        IERC20(base).safeTransferFrom(msg.sender, address(this), baseAmount);
        IERC20(quote).safeTransferFrom(msg.sender, address(this), quoteAmount);
        ++listings;
        lastBase = base;
        lastQuote = quote;
        lastBaseAmount = baseAmount;
        lastQuoteAmount = quoteAmount;
        market = address(uint160(uint256(keccak256(abi.encode(base, quote)))));
    }
}
