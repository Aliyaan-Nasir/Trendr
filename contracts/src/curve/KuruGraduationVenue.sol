// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";

import {IGraduationVenue} from "../interfaces/IGraduationVenue.sol";
import {IKuruOrderBook, IKuruRouter, IKuruVault} from "../interfaces/kuru/IKuru.sol";

/// @title KuruGraduationVenue
/// @notice Lists a graduated TrendCoin on its own Kuru spot market and seeds the market's AMM
///         vault with the curve's reserves, at the curve's final price, in the same transaction.
///
///         Market parameters are derived from the graduation price: price precision gives about
///         five significant digits, ticks are about 0.1%, one size unit is worth at most 0.001
///         quote, and the minimum order is about one quote token so the book cannot be spammed
///         with dust. The vault's LP shares go to a dead address, so graduated liquidity is locked
///         for good.
///
///         Front-running: Kuru market addresses depend only on the parameters, so `maxSize`
///         carries per-call entropy. If a market with the chosen parameters already exists, it is
///         still a genuine Router market and is used as long as its vault is empty; otherwise the
///         next parameter variant is tried.
///
///         Permissioned routers (Kuru Mainnet): `list` refuses with `ListingUnavailable`, so
///         graduation waits in the curve, where holders can still sell back.
///
///         Listings are keyed by the lister, so nobody can pre-empt a curve's listing. Ownerless.
contract KuruGraduationVenue is IGraduationVenue, ReentrancyGuard {
    using SafeERC20 for IERC20;
    using SafeCast for uint256;

    struct MarketParams {
        uint96 sizePrecision;
        uint32 pricePrecision;
        uint32 tickSize;
        uint96 minSize;
        uint96 maxSize;
    }

    struct Listing {
        address quote;
        uint256 baseAmount;
        uint256 quoteAmount;
        address market;
    }

    uint8 internal constant NO_NATIVE = 0;
    uint256 internal constant WAD = 1e18;
    uint256 internal constant MAX_PRICE_PRECISION = 1e9;
    /// @notice Target price in price-precision units (about five significant digits).
    uint256 internal constant TARGET_PRICE_UNITS = 1e5;
    /// @notice Lowest price in price-precision units; below it ticks lose meaning.
    uint256 internal constant MIN_PRICE_UNITS = 100;
    /// @notice Highest value of one size unit, in quote tokens, 1e18-scaled (0.001).
    uint256 internal constant MAX_SIZE_UNIT_VALUE = 1e15;
    /// @notice Spread of the maxSize variants used against front-running.
    uint256 internal constant MAX_SIZE_ENTROPY = 1e9;

    uint256 public constant MAX_ATTEMPTS = 4;
    /// @notice Receives the vault's LP shares, which locks graduated liquidity.
    address public constant LIQUIDITY_SINK = 0x000000000000000000000000000000000000dEaD;

    IKuruRouter public immutable router;
    /// @notice True when the router only lets Kuru deploy markets (Kuru Mainnet).
    bool public immutable routerPermissioned;
    uint256 public immutable takerFeeBps;
    uint256 public immutable makerFeeBps;
    uint96 public immutable ammSpread;

    mapping(address lister => mapping(address base => Listing)) public listings;

    event Listed(
        address indexed lister,
        address indexed base,
        address quote,
        address market,
        address vault,
        uint256 baseAmount,
        uint256 quoteAmount,
        uint256 shares
    );

    error ZeroAddress();
    error InvalidParams();
    error ZeroAmount();
    error AlreadyListed();
    error VaultAlreadySeeded();
    error NoFreshMarket();
    error PriceOutOfRange();
    error ListingUnavailable();

    constructor(
        IKuruRouter router_,
        bool routerPermissioned_,
        uint256 takerFeeBps_,
        uint256 makerFeeBps_,
        uint96 ammSpread_
    ) {
        if (address(router_) == address(0)) revert ZeroAddress();
        if (
            takerFeeBps_ > 100 || makerFeeBps_ > takerFeeBps_ || ammSpread_ < 10 || ammSpread_ > 490
                || ammSpread_ % 10 != 0
        ) {
            revert InvalidParams();
        }
        router = router_;
        routerPermissioned = routerPermissioned_;
        takerFeeBps = takerFeeBps_;
        makerFeeBps = makerFeeBps_;
        ammSpread = ammSpread_;
    }

    // The market address exists only after the trusted Router deploys it; list is nonReentrant.
    // slither-disable-start reentrancy-no-eth
    /// @inheritdoc IGraduationVenue
    function list(address base, address quote, uint256 baseAmount, uint256 quoteAmount)
        external
        nonReentrant
        returns (address market)
    {
        if (base == address(0) || quote == address(0)) revert ZeroAddress();
        if (baseAmount == 0 || quoteAmount == 0) revert ZeroAmount();
        Listing storage l = listings[msg.sender][base];
        if (l.quote != address(0)) revert AlreadyListed();
        l.quote = quote;
        l.baseAmount = baseAmount;
        l.quoteAmount = quoteAmount;
        IERC20(base).safeTransferFrom(msg.sender, address(this), baseAmount);
        IERC20(quote).safeTransferFrom(msg.sender, address(this), quoteAmount);

        // Where only Kuru deploys markets, a listing could wait forever (and Kuru Mainnet vaults
        // refuse deposits), so graduation waits in the curve, where holders can still sell.
        if (routerPermissioned) revert ListingUnavailable();
        market = _freshMarket(base, quote, baseAmount, quoteAmount);
        _seed(msg.sender, base, l, market);
    }

    // slither-disable-end reentrancy-no-eth

    /// @notice Kuru market parameters for listing `baseAmount` of `base` against `quoteAmount`
    ///         of `quote`, before the front-running entropy is added to `maxSize`.
    function marketParamsFor(address base, address quote, uint256 baseAmount, uint256 quoteAmount)
        public
        view
        returns (MarketParams memory p)
    {
        uint256 baseUnit = 10 ** IERC20Metadata(base).decimals();
        uint256 quoteUnit = 10 ** IERC20Metadata(quote).decimals();
        // Quote per whole base token, 1e18-scaled.
        uint256 priceWad = Math.mulDiv(quoteAmount * WAD, baseUnit, baseAmount * quoteUnit);

        uint256 pricePrecision = MAX_PRICE_PRECISION;
        while (pricePrecision > 1 && Math.mulDiv(priceWad, pricePrecision, WAD) > TARGET_PRICE_UNITS) {
            pricePrecision /= 10;
        }
        uint256 priceUnits = Math.mulDiv(priceWad, pricePrecision, WAD);
        // Keep at least 1000x headroom below Kuru's uint32 price limit.
        if (priceUnits < MIN_PRICE_UNITS || priceUnits > type(uint32).max / 1000) revert PriceOutOfRange();

        uint256 sizePrecision = 1;
        while (priceWad / sizePrecision > MAX_SIZE_UNIT_VALUE && sizePrecision < baseUnit) {
            sizePrecision *= 10;
        }

        p.pricePrecision = pricePrecision.toUint32();
        p.sizePrecision = sizePrecision.toUint96();
        p.tickSize = Math.max(priceUnits / 1000, 1).toUint32();
        p.minSize = Math.max(Math.mulDiv(sizePrecision, WAD, priceWad), 1).toUint96();
        // Kuru keeps order quote amounts in uint96, so price x size / sizePrecision must fit at
        // the highest price; 2^63 x sizePrecision leaves room for any uint32 price.
        p.maxSize =
            (Math.min((uint256(1) << 63) * sizePrecision, type(uint96).max) - MAX_SIZE_ENTROPY).toUint96();
    }

    // No code at the predicted address, or an empty vault, is exactly the condition being tested.
    // slither-disable-start incorrect-equality
    function _freshMarket(address base, address quote, uint256 baseAmount, uint256 quoteAmount)
        internal
        returns (address market)
    {
        MarketParams memory p = marketParamsFor(base, quote, baseAmount, quoteAmount);
        uint96 maxSize = p.maxSize;
        // Friction only; the empty-vault check is what stops a hijack.
        // forge-lint: disable-next-line(weak-prng)
        uint256 entropy = uint256(keccak256(abi.encode(block.prevrandao, block.number, msg.sender, base)));
        // The loop is bounded by MAX_ATTEMPTS and only calls the trusted Kuru Router and markets.
        // forge-lint: disable-start(calls-loop)
        for (uint256 i; i < MAX_ATTEMPTS; ++i) {
            p.maxSize = maxSize + (uint256(keccak256(abi.encode(entropy, i))) % MAX_SIZE_ENTROPY).toUint96();
            address predicted = router.computeAddress(
                base,
                quote,
                p.sizePrecision,
                p.pricePrecision,
                p.tickSize,
                p.minSize,
                p.maxSize,
                takerFeeBps,
                makerFeeBps,
                ammSpread,
                address(0),
                false
            );
            if (predicted.code.length == 0) {
                return router.deployProxy(
                    NO_NATIVE,
                    base,
                    quote,
                    p.sizePrecision,
                    p.pricePrecision,
                    p.tickSize,
                    p.minSize,
                    p.maxSize,
                    takerFeeBps,
                    makerFeeBps,
                    ammSpread
                );
            }
            // Someone deployed these exact parameters first. It is still a genuine Router market,
            // and ours to seed as long as nobody set its price.
            if (_vault(predicted).totalSupply() == 0) return predicted;
        }
        // forge-lint: disable-end(calls-loop)
        revert NoFreshMarket();
    }
    // slither-disable-end incorrect-equality

    function _seed(address lister, address base, Listing storage l, address market) internal {
        IKuruVault vault = _vault(market);
        if (vault.totalSupply() != 0) revert VaultAlreadySeeded();
        l.market = market;
        IERC20(base).forceApprove(address(vault), l.baseAmount);
        IERC20(l.quote).forceApprove(address(vault), l.quoteAmount);
        // The first deposit sets the vault price to quoteAmount / baseAmount and consumes both in full.
        uint256 shares = vault.deposit(l.baseAmount, l.quoteAmount, l.quoteAmount, LIQUIDITY_SINK);
        emit Listed(lister, base, l.quote, market, address(vault), l.baseAmount, l.quoteAmount, shares);
    }

    function _vault(address market) internal view returns (IKuruVault vault) {
        // Only the vault address is needed.
        // Also called from the bounded retry loop in _freshMarket.
        // forge-lint: disable-next-line(calls-loop, unused-return)
        (address v,,,,,,,) = IKuruOrderBook(market).getVaultParams();
        return IKuruVault(v);
    }
}
