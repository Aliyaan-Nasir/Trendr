// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

import {BondingCurve} from "../curve/BondingCurve.sol";
import {ITrendRegistry} from "../interfaces/ITrendRegistry.sol";
import {IKuruRouter} from "../interfaces/kuru/IKuru.sol";
import {OutcomeListing} from "../outcome/OutcomeListing.sol";
import {OutcomeMarkets} from "../outcome/OutcomeMarkets.sol";
import {AttentionPricing} from "./AttentionPricing.sol";

/// @title TrendrSpot
/// @notice Spot trades of Trendr tokens against AUSD through their Kuru markets. It routes only
///         through a token's canonical market (the OutcomeListing market of an UP or DOWN token,
///         the graduation market of a trend coin), insists on a minimum output, and pays the
///         recipient, so no trade routes funds through a market someone else controls.
///
///         Two kinds of entry point:
///         - `buy` and `sell` are the ones a trading session key may call. They trade UP and DOWN
///           tokens only, and only at prices within MAX_DEVIATION of the attention-implied value
///           (AttentionPricing on the registry's latest index), whatever minimum the caller
///           names. Someone holding a stolen session key could otherwise sell the account's
///           tokens into their own bid at the bottom of the book, or buy from their own ask at the
///           top; the oracle anchors the price where a book, which they can clear and refill in
///           one transaction, cannot. Trend coins have no such anchor, so sessions do not trade
///           them.
///         - `buyWithLimit` and `sellWithLimit` trust the caller's minimum alone, for any
///           canonical market. Sessions are never permitted them: they are for batches the account
///           owner signs with the passkey.
///
///         Ownerless and non-upgradeable. It holds nothing between calls and charges no fee;
///         Kuru's taker fee applies.
contract TrendrSpot is ReentrancyGuard {
    using SafeERC20 for IERC20;

    uint256 internal constant WAD = 1e18;
    /// @notice Furthest the average price of a `buy` or `sell` may be from the attention-implied
    ///         value, in AUSD per token (1e18-scaled): 0.10 AUSD.
    uint256 public constant MAX_DEVIATION = 0.1e18;

    IKuruRouter public immutable router;
    OutcomeListing public immutable listing;
    OutcomeMarkets public immutable outcomes;
    ITrendRegistry public immutable registry;
    BondingCurve public immutable curve;
    IERC20 public immutable ausd;

    event Swapped(
        address indexed trader,
        address indexed token,
        address indexed market,
        bool isBuy,
        uint256 amountIn,
        uint256 amountOut,
        address to
    );

    error ZeroAddress();
    error ZeroAmount();
    error NoMinimumOut();
    error NotTradable();
    error InsufficientOutput(uint256 out, uint256 minOut);
    /// @notice The token has no attention-implied price (a trend coin): only the owner trades it.
    error NoReferencePrice(address token);
    /// @notice The token's series has expired or settled.
    error SeriesClosed();
    /// @notice The oracle has not updated the trend's index within the registry's staleness limit.
    error IndexStale();

    constructor(IKuruRouter router_, OutcomeListing listing_, BondingCurve curve_) {
        if (
            address(router_) == address(0) || address(listing_) == address(0) || address(curve_) == address(0)
        ) {
            revert ZeroAddress();
        }
        router = router_;
        listing = listing_;
        curve = curve_;
        outcomes = listing_.outcomes();
        registry = outcomes.registry();
        ausd = IERC20(listing_.quote());
    }

    // ---------------------------------------------------------------------------------------
    // Session trades: UP and DOWN, within the attention-implied band
    // ---------------------------------------------------------------------------------------

    /// @notice Buys UP or DOWN `token` with exactly `ausdIn` AUSD, paid to `to`, for at least
    ///         `minOut` and at an average price no higher than the band's top.
    function buy(address token, uint256 ausdIn, uint256 minOut, address to)
        external
        nonReentrant
        returns (uint256 out)
    {
        address market = _check(token, ausdIn, minOut, to);
        (,, uint256 high) = _band(token);
        // Outcome tokens carry AUSD's decimals, so a price in AUSD per token converts raw units.
        uint256 least = ausdIn * WAD / high;
        out = _buy(token, market, ausdIn, least > minOut ? least : minOut, to);
    }

    /// @notice Sells exactly `amountIn` of UP or DOWN `token` for AUSD, paid to `to`, for at least
    ///         `minOut` and at an average price no lower than the band's bottom.
    function sell(address token, uint256 amountIn, uint256 minOut, address to)
        external
        nonReentrant
        returns (uint256 out)
    {
        address market = _check(token, amountIn, minOut, to);
        (, uint256 low,) = _band(token);
        uint256 least = amountIn * low / WAD;
        out = _sell(token, market, amountIn, least > minOut ? least : minOut, to);
    }

    // ---------------------------------------------------------------------------------------
    // Owner trades: any canonical market, at the caller's own limit
    // ---------------------------------------------------------------------------------------

    /// @notice Buys `token` with exactly `ausdIn` AUSD, for at least `minOut`, paid to `to`.
    function buyWithLimit(address token, uint256 ausdIn, uint256 minOut, address to)
        external
        nonReentrant
        returns (uint256 out)
    {
        out = _buy(token, _check(token, ausdIn, minOut, to), ausdIn, minOut, to);
    }

    /// @notice Sells exactly `amountIn` of `token` for at least `minOut` AUSD, paid to `to`.
    function sellWithLimit(address token, uint256 amountIn, uint256 minOut, address to)
        external
        nonReentrant
        returns (uint256 out)
    {
        out = _sell(token, _check(token, amountIn, minOut, to), amountIn, minOut, to);
    }

    // ---------------------------------------------------------------------------------------
    // Views
    // ---------------------------------------------------------------------------------------

    /// @notice The canonical Kuru market of `token`, or zero when it has none yet.
    function marketOf(address token) public view returns (address market) {
        market = listing.marketOf(token);
        if (market != address(0)) return market;
        // A trend coin: only the curve's own coin, once it graduated.
        (bool ok, bytes memory ret) = token.staticcall(abi.encodeWithSignature("trendId()"));
        if (!ok || ret.length != 32) return address(0);
        BondingCurve.Curve memory c = curve.curveOf(abi.decode(ret, (bytes32)));
        if (address(c.coin) != token || c.state != BondingCurve.State.Graduated) return address(0);
        return c.market;
    }

    /// @notice The attention-implied value of UP or DOWN `token` in AUSD per token (1e18-scaled)
    ///         and the band `buy` and `sell` trade within. Reverts where they would refuse.
    function priceBand(address token) external view returns (uint256 fair, uint256 low, uint256 high) {
        if (listing.marketOf(token) == address(0)) revert NotTradable();
        return _band(token);
    }

    // ---------------------------------------------------------------------------------------
    // Internals
    // ---------------------------------------------------------------------------------------

    function _check(address token, uint256 amountIn, uint256 minOut, address to)
        internal
        view
        returns (address market)
    {
        if (to == address(0)) revert ZeroAddress();
        if (amountIn == 0) revert ZeroAmount();
        if (minOut == 0) revert NoMinimumOut();
        market = marketOf(token);
        if (market == address(0)) revert NotTradable();
    }

    /// @dev The band around an outcome token's attention-implied value, within [0, 1] AUSD. The
    ///      listing records only genuine UP and DOWN tokens of `outcomes`.
    function _band(address token) internal view returns (uint256 fair, uint256 low, uint256 high) {
        if (listing.marketOf(token) == address(0)) revert NoReferencePrice(token);
        (bool ok, bytes memory ret) = token.staticcall(abi.encodeWithSignature("seriesId()"));
        if (!ok || ret.length != 32) revert NoReferencePrice(token);
        OutcomeMarkets.Series memory s = outcomes.seriesOf(abi.decode(ret, (bytes32)));
        if (s.outcome != OutcomeMarkets.Outcome.Open || block.timestamp >= s.expiry) revert SeriesClosed();
        if (!registry.isFresh(s.trendId)) revert IndexStale();
        // Freshness was checked above.
        // forge-lint: disable-next-line(unused-return)
        (uint64 index,) = registry.indexOf(s.trendId);
        uint256 up = AttentionPricing.upProbability(index, s.openingIndex, s.expiry - block.timestamp);
        if (address(s.up) == token) fair = up;
        else if (address(s.down) == token) fair = WAD - up;
        else revert NoReferencePrice(token);
        low = fair > MAX_DEVIATION ? fair - MAX_DEVIATION : 0;
        high = fair + MAX_DEVIATION < WAD ? fair + MAX_DEVIATION : WAD;
    }

    function _buy(address token, address market, uint256 ausdIn, uint256 minOut, address to)
        internal
        returns (uint256 out)
    {
        ausd.safeTransferFrom(msg.sender, address(this), ausdIn);
        out = _swap(market, true, ausd, IERC20(token), ausdIn, minOut);
        IERC20(token).safeTransfer(to, out);
        emit Swapped(msg.sender, token, market, true, ausdIn, out, to);
    }

    function _sell(address token, address market, uint256 amountIn, uint256 minOut, address to)
        internal
        returns (uint256 out)
    {
        IERC20(token).safeTransferFrom(msg.sender, address(this), amountIn);
        out = _swap(market, false, IERC20(token), ausd, amountIn, minOut);
        ausd.safeTransfer(to, out);
        emit Swapped(msg.sender, token, market, false, amountIn, out, to);
    }

    // Measuring the balance around the router call is the point: it counts what actually arrived.
    // Every entry point is nonReentrant and the router is Kuru's immutable Router.
    // slither-disable-start reentrancy-balance
    function _swap(address market, bool isBuy, IERC20 debit, IERC20 credit, uint256 amountIn, uint256 minOut)
        internal
        returns (uint256 out)
    {
        address[] memory markets = new address[](1);
        markets[0] = market;
        bool[] memory buys = new bool[](1);
        buys[0] = isBuy;
        uint256 before = credit.balanceOf(address(this));
        debit.forceApprove(address(router), amountIn);
        // The router enforces minOut; the received balance is what counts.
        // forge-lint: disable-next-line(unused-return)
        router.anyToAnySwap(markets, buys, new bool[](1), address(debit), address(credit), amountIn, minOut);
        out = credit.balanceOf(address(this)) - before;
        if (out < minOut) revert InsufficientOutput(out, minOut);
        // Kuru pulls exactly amountIn; nothing stays approved.
        debit.forceApprove(address(router), 0);
    }
    // slither-disable-end reentrancy-balance
}
