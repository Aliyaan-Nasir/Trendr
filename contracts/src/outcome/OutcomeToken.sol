// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {ERC20Permit} from "@openzeppelin/contracts/token/ERC20/extensions/ERC20Permit.sol";

/// @title OutcomeToken
/// @notice One side (UP or DOWN) of an attention outcome series. Only the deploying
///         OutcomeMarkets contract can mint and burn; everything else is a plain ERC-20 with
///         EIP-2612 permit so it can trade on a spot order book.
contract OutcomeToken is ERC20, ERC20Permit {
    address public immutable markets;
    bytes32 public immutable seriesId;
    bool public immutable isUp;
    uint8 private immutable _decimals;

    error OnlyMarkets();

    constructor(string memory name_, string memory symbol_, uint8 decimals_, bytes32 seriesId_, bool isUp_)
        ERC20(name_, symbol_)
        ERC20Permit(name_)
    {
        markets = msg.sender;
        seriesId = seriesId_;
        isUp = isUp_;
        _decimals = decimals_;
    }

    modifier onlyMarkets() {
        if (msg.sender != markets) revert OnlyMarkets();
        _;
    }

    function decimals() public view override returns (uint8) {
        return _decimals;
    }

    function mint(address to, uint256 amount) external onlyMarkets {
        _mint(to, amount);
    }

    /// @dev Called by OutcomeMarkets only for the caller's own tokens during a redemption.
    function burn(address from, uint256 amount) external onlyMarkets {
        _burn(from, amount);
    }
}
