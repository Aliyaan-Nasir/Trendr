// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

/// @notice Minimal Kuru v1 stand-ins: a router that deploys markets with CREATE2 from their
///         parameters, a market exposing its vault, and a vault whose first deposit sets the price.
contract MockKuruVault is ERC20 {
    address public immutable base;
    address public immutable quote;
    uint256 public price; // quote per base, raw units, 1e18-scaled

    constructor(address base_, address quote_) ERC20("Kuru LP", "KLP") {
        base = base_;
        quote = quote_;
    }

    function deposit(uint256 baseDeposit, uint256 quoteDeposit, uint256, address receiver)
        external
        payable
        returns (uint256 shares)
    {
        IERC20(base).transferFrom(msg.sender, address(this), baseDeposit);
        IERC20(quote).transferFrom(msg.sender, address(this), quoteDeposit);
        if (totalSupply() == 0) price = quoteDeposit * 1e18 / baseDeposit;
        shares = Math.sqrt(baseDeposit * quoteDeposit);
        _mint(receiver, shares);
    }
}

contract MockKuruMarket {
    address public immutable vault;

    constructor(address base, address quote) {
        vault = address(new MockKuruVault(base, quote));
    }

    function getVaultParams()
        external
        view
        returns (address, uint256, uint96, uint256, uint96, uint96, uint96, uint96)
    {
        return (vault, 0, 0, 0, 0, 0, 0, 0);
    }
}

contract MockKuruRouter {
    struct Market {
        address base;
        address quote;
        uint96 sizePrecision;
        uint32 pricePrecision;
        uint32 tickSize;
        uint96 minSize;
        uint96 maxSize;
        uint256 takerFeeBps;
        uint256 makerFeeBps;
    }

    bool public permissioned;
    address public immutable owner;
    mapping(address market => Market) public markets;
    uint256 public deployments;
    /// @notice Swap price, 1e18-scaled quote per base token, and how much of the output to pay.
    uint256 public swapPrice = 0.5e18;
    uint256 public payoutBps = 10_000;

    constructor(bool permissioned_) {
        permissioned = permissioned_;
        owner = msg.sender;
    }

    function deployProxy(
        uint8,
        address base,
        address quote,
        uint96 sizePrecision,
        uint32 pricePrecision,
        uint32 tickSize,
        uint96 minSize,
        uint96 maxSize,
        uint256 takerFeeBps,
        uint256 makerFeeBps,
        uint96 spread
    ) external returns (address proxy) {
        require(!permissioned || msg.sender == owner, "Unauthorized");
        bytes32 salt = keccak256(
            abi.encodePacked(
                base,
                quote,
                sizePrecision,
                pricePrecision,
                tickSize,
                minSize,
                maxSize,
                takerFeeBps,
                makerFeeBps,
                spread
            )
        );
        proxy = address(new MockKuruMarket{salt: salt}(base, quote));
        markets[proxy] = Market(
            base, quote, sizePrecision, pricePrecision, tickSize, minSize, maxSize, takerFeeBps, makerFeeBps
        );
        ++deployments;
    }

    function setSwap(uint256 price, uint256 payout) external {
        swapPrice = price;
        payoutBps = payout;
    }

    /// @notice Single-market swaps at `swapPrice`, paying from the router's own balance.
    function anyToAnySwap(
        address[] calldata marketAddresses,
        bool[] calldata isBuy,
        bool[] calldata,
        address debitToken,
        address creditToken,
        uint256 amount,
        uint256 minAmountOut
    ) external payable returns (uint256 out) {
        Market memory m = markets[marketAddresses[0]];
        require(m.base != address(0), "not a router market");
        require(
            isBuy[0]
                ? (debitToken == m.quote && creditToken == m.base)
                : (debitToken == m.base && creditToken == m.quote),
            "wrong pair"
        );
        IERC20(debitToken).transferFrom(msg.sender, address(this), amount);
        out = isBuy[0] ? amount * 1e18 / swapPrice : amount * swapPrice / 1e18;
        out = out * payoutBps / 10_000;
        require(out >= minAmountOut, "slippage");
        IERC20(creditToken).transfer(msg.sender, out);
    }

    function computeAddress(
        address base,
        address quote,
        uint96 sizePrecision,
        uint32 pricePrecision,
        uint32 tickSize,
        uint96 minSize,
        uint96 maxSize,
        uint256 takerFeeBps,
        uint256 makerFeeBps,
        uint96 spread,
        address,
        bool
    ) external view returns (address) {
        bytes32 salt = keccak256(
            abi.encodePacked(
                base,
                quote,
                sizePrecision,
                pricePrecision,
                tickSize,
                minSize,
                maxSize,
                takerFeeBps,
                makerFeeBps,
                spread
            )
        );
        bytes32 codeHash =
            keccak256(abi.encodePacked(type(MockKuruMarket).creationCode, abi.encode(base, quote)));
        return
            address(
                uint160(uint256(keccak256(abi.encodePacked(bytes1(0xff), address(this), salt, codeHash))))
            );
    }

    function verifiedMarket(address market)
        external
        view
        returns (uint32, uint96, address, uint256, address, uint256, uint32, uint96, uint96, uint256, uint256)
    {
        Market memory m = markets[market];
        return (
            m.pricePrecision,
            m.sizePrecision,
            m.base,
            18,
            m.quote,
            6,
            m.tickSize,
            m.minSize,
            m.maxSize,
            m.takerFeeBps,
            m.makerFeeBps
        );
    }
}
