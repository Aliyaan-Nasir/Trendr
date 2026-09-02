// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {ERC20Permit} from "@openzeppelin/contracts/token/ERC20/extensions/ERC20Permit.sol";

/// @title TrendCoin
/// @notice The launch-layer coin of a trend. Only its BondingCurve can mint and burn, and it does
///         so only while the curve is open and once at graduation to seed the Kuru market.
contract TrendCoin is ERC20, ERC20Permit {
    address public immutable curve;
    bytes32 public immutable trendId;

    error OnlyCurve();

    constructor(string memory name_, string memory symbol_, bytes32 trendId_)
        ERC20(name_, symbol_)
        ERC20Permit(name_)
    {
        curve = msg.sender;
        trendId = trendId_;
    }

    modifier onlyCurve() {
        if (msg.sender != curve) revert OnlyCurve();
        _;
    }

    function mint(address to, uint256 amount) external onlyCurve {
        _mint(to, amount);
    }

    /// @dev Called by the curve only for the seller's own coins during a sell.
    function burn(address from, uint256 amount) external onlyCurve {
        _burn(from, amount);
    }
}
