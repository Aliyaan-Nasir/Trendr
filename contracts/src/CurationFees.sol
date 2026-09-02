// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

import {ICurationFees} from "./interfaces/ICurationFees.sol";
import {ITrendRegistry} from "./interfaces/ITrendRegistry.sol";

/// @title CurationFees
/// @notice Collects the curation share of outcome, perp and curve fees and credits it to the
///         account that first surfaced each trend. Ownerless; trends without a surfacer credit
///         the immutable treasury.
contract CurationFees is ICurationFees, ReentrancyGuard {
    using SafeERC20 for IERC20;

    IERC20 public immutable collateral;
    ITrendRegistry public immutable registry;
    address public immutable treasury;

    /// @notice Collateral each account can claim.
    mapping(address account => uint256 amount) public claimable;
    /// @notice Lifetime curation fees per trend.
    mapping(bytes32 trendId => uint256 amount) public earnedByTrend;
    /// @notice Lifetime curation fees credited to each account.
    mapping(address account => uint256 amount) public earnedByAccount;

    uint256 public totalAccrued;
    uint256 public totalClaimed;

    event Accrued(bytes32 indexed trendId, address indexed surfacer, address indexed source, uint256 amount);
    event Claimed(address indexed account, address indexed to, uint256 amount);

    error ZeroAddress();
    error NothingToClaim();

    constructor(IERC20 collateral_, ITrendRegistry registry_, address treasury_) {
        if (address(collateral_) == address(0) || address(registry_) == address(0) || treasury_ == address(0))
        {
            revert ZeroAddress();
        }
        collateral = collateral_;
        registry = registry_;
        treasury = treasury_;
    }

    /// @inheritdoc ICurationFees
    function accrue(bytes32 trendId, uint256 amount) external nonReentrant {
        if (amount == 0) return;
        address surfacer = registry.surfacerOf(trendId);
        if (surfacer == address(0)) surfacer = treasury;
        claimable[surfacer] += amount;
        earnedByTrend[trendId] += amount;
        earnedByAccount[surfacer] += amount;
        totalAccrued += amount;
        collateral.safeTransferFrom(msg.sender, address(this), amount);
        emit Accrued(trendId, surfacer, msg.sender, amount);
    }

    /// @notice Sends everything the caller can claim to `to`.
    function claim(address to) external nonReentrant returns (uint256 amount) {
        if (to == address(0)) revert ZeroAddress();
        amount = claimable[msg.sender];
        if (amount == 0) revert NothingToClaim();
        claimable[msg.sender] = 0;
        totalClaimed += amount;
        collateral.safeTransfer(to, amount);
        emit Claimed(msg.sender, to, amount);
    }
}
