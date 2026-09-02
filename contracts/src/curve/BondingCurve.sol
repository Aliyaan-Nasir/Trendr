// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {IERC20Permit} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Permit.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

import {ICurationFees} from "../interfaces/ICurationFees.sol";
import {IGraduationVenue} from "../interfaces/IGraduationVenue.sol";
import {ITrendRegistry} from "../interfaces/ITrendRegistry.sol";
import {TrendCoin} from "./TrendCoin.sol";

/// @title BondingCurve
/// @notice Launch layer: one TrendCoin per trend on a constant-product bonding curve priced in
///         collateral (AUSD), graduating to its own Kuru spot market when the curve fills.
///
///         Curve: quote side = virtualQuote + reserve, token side = virtualTokens - sold,
///         k = quote x tokens. The spot price is quote / tokens.
///
///         Fee: 1% on every buy and sell, split between the attention floor reserve, the
///         graduation liquidity, the trend's curator and the protocol.
///
///         Attention ratchet: the curve's floor (its price at zero supply, virtualQuote /
///         virtualTokens) rises one way as the trend's peak attention grows past its peak at
///         curve creation, up to 5x. Raising virtualQuote by d raises every price on the curve,
///         so it is paid for: d x sold / tokens of floor reserve moves into the reserve, which
///         keeps the curve able to buy back every coin it sold. The floor rises only as far as
///         the floor reserve allows.
///
///         Solvency invariant: reserve x (virtualTokens - sold) >= virtualQuote x sold, i.e. selling
///         every outstanding coin back never pays out more than the reserve. Rounding always
///         favours the curve.
///
///         Graduation: once the reserve reaches the threshold, buying and selling stop. Anyone can
///         call `graduate`, which closes the curve, mints coins at the current spot price to pair
///         with the reserve, floor reserve and graduation liquidity, and hands both to the venue,
///         which deploys the Kuru market and deposits them as starting liquidity in the same
///         transaction. `graduate` is idempotent. The contract is ownerless.
contract BondingCurve is ReentrancyGuard {
    using SafeERC20 for IERC20;

    enum State {
        None,
        Open,
        Ready,
        Graduated
    }

    struct Curve {
        TrendCoin coin;
        State state;
        uint64 peakAtCreation;
        uint256 virtualQuote;
        uint256 reserve;
        uint256 sold;
        uint256 floorReserve;
        uint256 graduationLiquidity;
        address market;
    }

    uint256 internal constant WAD = 1e18;
    uint256 internal constant BPS = 10_000;
    uint64 internal constant INDEX_SCALE = 1e6;

    uint256 public constant FEE_BPS = 100;
    uint256 public constant FLOOR_SHARE_BPS = 3000;
    uint256 public constant GRADUATION_SHARE_BPS = 3000;
    uint256 public constant CURATION_SHARE_BPS = 1000;
    /// @notice Largest move of the spot price a single trade may cause (20%).
    uint256 public constant MAX_PRICE_IMPACT_BPS = 2000;
    /// @notice Floor ratchet per index point of peak growth since creation (5%).
    uint256 public constant RATCHET_BPS_PER_POINT = 500;
    /// @notice Highest floor relative to the base (5x).
    uint256 public constant MAX_RATCHET_BPS = 50_000;
    uint256 public constant VIRTUAL_TOKENS = 1_000_000_000e18;

    IERC20 public immutable collateral;
    ITrendRegistry public immutable registry;
    ICurationFees public immutable curation;
    IGraduationVenue public immutable venue;
    address public immutable treasury;
    uint256 public immutable baseVirtualQuote;
    uint256 public immutable graduationReserve;

    mapping(bytes32 trendId => Curve) internal _curves;
    uint256 public protocolFees;

    event CurveCreated(bytes32 indexed trendId, address coin, uint256 virtualQuote, uint64 peakAtCreation);
    event Trade(
        bytes32 indexed trendId,
        address indexed trader,
        bool isBuy,
        uint256 quoteAmount,
        uint256 coinAmount,
        uint256 fee,
        uint256 reserve,
        uint256 sold
    );
    event FloorRaised(bytes32 indexed trendId, uint256 virtualQuote, uint256 cost, uint256 ratchetBps);
    event GraduationReady(bytes32 indexed trendId, uint256 reserve);
    event Graduated(bytes32 indexed trendId, address indexed market, uint256 coinAmount, uint256 quoteAmount);
    event ProtocolFeesSwept(address indexed to, uint256 amount);

    error ZeroAddress();
    error InvalidParams();
    error IdentifierMismatch();
    error TrendNotActive();
    error CurveExists();
    error UnknownCurve();
    error CurveClosed();
    error NotReady();
    error Expired();
    error ZeroAmount();
    error Slippage();
    error PriceImpact();
    error InsufficientReserve();

    /// @param baseVirtualQuote_ Virtual quote reserve at creation, in collateral units.
    /// @param graduationReserve_ Real reserve at which the curve graduates, in collateral units.
    constructor(
        IERC20 collateral_,
        ITrendRegistry registry_,
        ICurationFees curation_,
        IGraduationVenue venue_,
        address treasury_,
        uint256 baseVirtualQuote_,
        uint256 graduationReserve_
    ) {
        if (
            address(collateral_) == address(0) || address(registry_) == address(0)
                || address(curation_) == address(0) || address(venue_) == address(0)
                || treasury_ == address(0)
        ) revert ZeroAddress();
        uint256 unit = 10 ** IERC20Metadata(address(collateral_)).decimals();
        if (
            baseVirtualQuote_ < 100 * unit || baseVirtualQuote_ > 1_000_000 * unit
                || graduationReserve_ < baseVirtualQuote_ / 10 || graduationReserve_ > 10 * baseVirtualQuote_
        ) revert InvalidParams();
        collateral = collateral_;
        registry = registry_;
        curation = curation_;
        venue = venue_;
        treasury = treasury_;
        baseVirtualQuote = baseVirtualQuote_;
        graduationReserve = graduationReserve_;
    }

    // ---------------------------------------------------------------------------------------
    // Creation
    // ---------------------------------------------------------------------------------------

    /// @notice Creates the trend's coin and curve. Permissionless while the trend is Active.
    function createCurve(string calldata identifier) external returns (address coin) {
        bytes32 trendId = keccak256(bytes(identifier));
        if (registry.statusOf(trendId) != ITrendRegistry.Status.Active) revert TrendNotActive();
        Curve storage c = _curves[trendId];
        if (c.state != State.None) revert CurveExists();

        TrendCoin token = new TrendCoin{salt: trendId}(
            string.concat("Trendr ", identifier), string.concat("TRND-", _upper(identifier)), trendId
        );
        c.coin = token;
        c.state = State.Open;
        c.peakAtCreation = registry.trendOf(trendId).peakIndex;
        c.virtualQuote = baseVirtualQuote;
        coin = address(token);
        emit CurveCreated(trendId, coin, baseVirtualQuote, c.peakAtCreation);
    }

    // ---------------------------------------------------------------------------------------
    // Trading
    // ---------------------------------------------------------------------------------------

    /// @notice Buys coins for `quoteIn` collateral (fee included).
    function buy(bytes32 trendId, uint256 quoteIn, uint256 minCoinsOut, address to, uint256 deadline)
        public
        nonReentrant
        returns (uint256 coinsOut)
    {
        if (block.timestamp > deadline) revert Expired();
        if (quoteIn == 0) revert ZeroAmount();
        if (to == address(0)) revert ZeroAddress();
        Curve storage c = _openCurve(trendId);
        if (registry.statusOf(trendId) != ITrendRegistry.Status.Active) revert TrendNotActive();
        _raiseFloor(trendId, c);

        uint256 fee = Math.mulDiv(quoteIn, FEE_BPS, BPS, Math.Rounding.Ceil);
        uint256 net = quoteIn - fee;
        uint256 quoteBefore = c.virtualQuote + c.reserve;
        uint256 tokensBefore = VIRTUAL_TOKENS - c.sold;
        uint256 quoteAfter = quoteBefore + net;
        uint256 tokensAfter = Math.mulDiv(quoteBefore, tokensBefore, quoteAfter, Math.Rounding.Ceil);
        coinsOut = tokensBefore - tokensAfter;
        if (coinsOut == 0) revert ZeroAmount();
        if (coinsOut < minCoinsOut) revert Slippage();
        _checkImpact(quoteBefore, tokensBefore, quoteAfter, tokensAfter);

        c.reserve += net;
        c.sold += coinsOut;
        uint256 toCuration = _bookFee(c, fee);
        bool filled = c.reserve >= graduationReserve;
        if (filled) c.state = State.Ready;

        collateral.safeTransferFrom(msg.sender, address(this), quoteIn);
        _payCuration(trendId, toCuration);
        c.coin.mint(to, coinsOut);
        emit Trade(trendId, msg.sender, true, quoteIn, coinsOut, fee, c.reserve, c.sold);
        if (filled) emit GraduationReady(trendId, c.reserve);
    }

    /// @notice `buy` preceded by an EIP-2612 permit on the collateral; a failing permit is ignored.
    function buyWithPermit(
        bytes32 trendId,
        uint256 quoteIn,
        uint256 minCoinsOut,
        address to,
        uint256 deadline,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external returns (uint256) {
        try IERC20Permit(address(collateral)).permit(msg.sender, address(this), quoteIn, deadline, v, r, s) {}
            catch {}
        return buy(trendId, quoteIn, minCoinsOut, to, deadline);
    }

    /// @notice Sells `coinsIn` of the caller's coins for collateral (fee deducted).
    function sell(bytes32 trendId, uint256 coinsIn, uint256 minQuoteOut, address to, uint256 deadline)
        external
        nonReentrant
        returns (uint256 quoteOut)
    {
        if (block.timestamp > deadline) revert Expired();
        if (coinsIn == 0) revert ZeroAmount();
        if (to == address(0)) revert ZeroAddress();
        Curve storage c = _sellableCurve(trendId);
        _raiseFloor(trendId, c);

        uint256 quoteBefore = c.virtualQuote + c.reserve;
        uint256 tokensBefore = VIRTUAL_TOKENS - c.sold;
        uint256 tokensAfter = tokensBefore + coinsIn;
        uint256 quoteAfter = Math.mulDiv(quoteBefore, tokensBefore, tokensAfter, Math.Rounding.Ceil);
        uint256 gross = quoteBefore - quoteAfter;
        if (gross > c.reserve) revert InsufficientReserve();
        _checkImpact(quoteBefore, tokensBefore, quoteAfter, tokensAfter);
        uint256 fee = Math.mulDiv(gross, FEE_BPS, BPS, Math.Rounding.Ceil);
        quoteOut = gross - fee;
        if (quoteOut == 0) revert ZeroAmount();
        if (quoteOut < minQuoteOut) revert Slippage();

        c.reserve -= gross;
        c.sold -= coinsIn;
        if (c.state == State.Ready && c.reserve < graduationReserve) c.state = State.Open;
        uint256 toCuration = _bookFee(c, fee);

        c.coin.burn(msg.sender, coinsIn);
        _payCuration(trendId, toCuration);
        collateral.safeTransfer(to, quoteOut);
        emit Trade(trendId, msg.sender, false, quoteOut, coinsIn, fee, c.reserve, c.sold);
    }

    /// @notice Raises the trend's floor as far as its peak attention and floor reserve allow.
    ///         Permissionless; trades call it automatically.
    function syncFloor(bytes32 trendId) external {
        Curve storage c = _curves[trendId];
        if (c.state != State.Open) revert CurveClosed();
        _raiseFloor(trendId, c);
    }

    // ---------------------------------------------------------------------------------------
    // Graduation
    // ---------------------------------------------------------------------------------------

    // The market address exists only after listing; graduate is nonReentrant.
    // slither-disable-start reentrancy-no-eth
    /// @notice Closes a filled curve and lists the coin on its spot market, seeded with the
    ///         reserve, floor reserve and graduation liquidity at the current spot price.
    ///         Permissionless and idempotent: once graduated it returns the market and does nothing.
    function graduate(bytes32 trendId) external nonReentrant returns (address market) {
        Curve storage c = _curves[trendId];
        if (c.state == State.Graduated) return c.market;
        if (c.state != State.Ready) revert NotReady();

        uint256 quoteAmount = c.reserve + c.floorReserve + c.graduationLiquidity;
        // Coins priced at the curve's final spot price: quote / tokens.
        uint256 coinAmount = Math.mulDiv(quoteAmount, VIRTUAL_TOKENS - c.sold, c.virtualQuote + c.reserve);

        c.state = State.Graduated;
        c.reserve = 0;
        c.floorReserve = 0;
        c.graduationLiquidity = 0;

        c.coin.mint(address(this), coinAmount);
        IERC20(address(c.coin)).forceApprove(address(venue), coinAmount);
        collateral.forceApprove(address(venue), quoteAmount);
        market = venue.list(address(c.coin), address(collateral), coinAmount, quoteAmount);
        // The market is known only once listed; nonReentrant guards this late write.
        // forge-lint: disable-next-line(reentrancy-no-eth)
        c.market = market;
        emit Graduated(trendId, market, coinAmount, quoteAmount);
    }

    // slither-disable-end reentrancy-no-eth

    /// @notice Sends accrued protocol fees to the treasury. Permissionless.
    function sweepProtocolFees() external nonReentrant {
        uint256 amount = protocolFees;
        if (amount == 0) revert ZeroAmount();
        protocolFees = 0;
        collateral.safeTransfer(treasury, amount);
        emit ProtocolFeesSwept(treasury, amount);
    }

    // ---------------------------------------------------------------------------------------
    // Views
    // ---------------------------------------------------------------------------------------

    function curveOf(bytes32 trendId) external view returns (Curve memory) {
        return _curves[trendId];
    }

    /// @notice Spot price in collateral units per whole coin, 1e18-scaled.
    function spotPrice(bytes32 trendId) public view returns (uint256) {
        Curve storage c = _curves[trendId];
        return Math.mulDiv(c.virtualQuote + c.reserve, WAD * WAD, VIRTUAL_TOKENS - c.sold);
    }

    /// @notice Floor ratchet target for the trend's current peak attention, in basis points.
    function ratchetBps(bytes32 trendId) public view returns (uint256) {
        uint64 peak = registry.trendOf(trendId).peakIndex;
        uint64 base = _curves[trendId].peakAtCreation;
        if (peak <= base) return BPS;
        uint256 boost = Math.mulDiv(peak - base, RATCHET_BPS_PER_POINT, INDEX_SCALE);
        return Math.min(BPS + boost, MAX_RATCHET_BPS);
    }

    /// @notice Coins out for `quoteIn` (fee included) at the current state, ignoring a pending floor raise.
    function quoteBuy(bytes32 trendId, uint256 quoteIn)
        external
        view
        returns (uint256 coinsOut, uint256 fee)
    {
        Curve storage c = _curves[trendId];
        fee = Math.mulDiv(quoteIn, FEE_BPS, BPS, Math.Rounding.Ceil);
        uint256 quoteBefore = c.virtualQuote + c.reserve;
        uint256 tokensBefore = VIRTUAL_TOKENS - c.sold;
        uint256 tokensAfter =
            Math.mulDiv(quoteBefore, tokensBefore, quoteBefore + quoteIn - fee, Math.Rounding.Ceil);
        coinsOut = tokensBefore - tokensAfter;
    }

    /// @notice Collateral out for `coinsIn` (fee deducted) at the current state, ignoring a pending floor raise.
    function quoteSell(bytes32 trendId, uint256 coinsIn)
        external
        view
        returns (uint256 quoteOut, uint256 fee)
    {
        Curve storage c = _curves[trendId];
        uint256 quoteBefore = c.virtualQuote + c.reserve;
        uint256 tokensBefore = VIRTUAL_TOKENS - c.sold;
        uint256 quoteAfter =
            Math.mulDiv(quoteBefore, tokensBefore, tokensBefore + coinsIn, Math.Rounding.Ceil);
        uint256 gross = quoteBefore - quoteAfter;
        fee = Math.mulDiv(gross, FEE_BPS, BPS, Math.Rounding.Ceil);
        quoteOut = gross - fee;
    }

    // ---------------------------------------------------------------------------------------
    // Internals
    // ---------------------------------------------------------------------------------------

    function _openCurve(bytes32 trendId) internal view returns (Curve storage c) {
        c = _curves[trendId];
        if (c.state == State.None) revert UnknownCurve();
        if (c.state != State.Open) revert CurveClosed();
    }

    /// @dev Open, or Ready while graduation waits on the venue: holders can always sell back.
    function _sellableCurve(bytes32 trendId) internal view returns (Curve storage c) {
        c = _curves[trendId];
        if (c.state == State.None) revert UnknownCurve();
        if (c.state != State.Open && c.state != State.Ready) revert CurveClosed();
    }

    function _raiseFloor(bytes32 trendId, Curve storage c) internal {
        uint256 ratchet = ratchetBps(trendId);
        uint256 target = Math.mulDiv(baseVirtualQuote, ratchet, BPS);
        if (target <= c.virtualQuote) return;

        uint256 delta = target - c.virtualQuote;
        uint256 tokens = VIRTUAL_TOKENS - c.sold;
        uint256 cost = Math.mulDiv(delta, c.sold, tokens, Math.Rounding.Ceil);
        if (cost > c.floorReserve) {
            // Raise only as far as the floor reserve pays for.
            delta = Math.mulDiv(c.floorReserve, tokens, c.sold);
            if (delta == 0) return;
            cost = Math.mulDiv(delta, c.sold, tokens, Math.Rounding.Ceil);
            if (cost > c.floorReserve) return;
        }
        c.virtualQuote += delta;
        c.floorReserve -= cost;
        c.reserve += cost;
        emit FloorRaised(trendId, c.virtualQuote, cost, ratchet);
    }

    /// @dev Books a trade fee's floor, graduation and protocol shares and returns the curation
    ///         share, which `_payCuration` sends once the trade's own transfers are done.
    function _bookFee(Curve storage c, uint256 fee) internal returns (uint256 toCuration) {
        if (fee == 0) return 0;
        uint256 toFloor = Math.mulDiv(fee, FLOOR_SHARE_BPS, BPS);
        uint256 toGraduation = Math.mulDiv(fee, GRADUATION_SHARE_BPS, BPS);
        toCuration = Math.mulDiv(fee, CURATION_SHARE_BPS, BPS);
        c.floorReserve += toFloor;
        c.graduationLiquidity += toGraduation;
        protocolFees += fee - toFloor - toGraduation - toCuration;
    }

    function _payCuration(bytes32 trendId, uint256 amount) internal {
        if (amount == 0) return;
        collateral.forceApprove(address(curation), amount);
        curation.accrue(trendId, amount);
    }

    /// @dev Reverts if the spot price moves by more than MAX_PRICE_IMPACT_BPS in either direction.
    function _checkImpact(uint256 quoteBefore, uint256 tokensBefore, uint256 quoteAfter, uint256 tokensAfter)
        internal
        pure
    {
        // Compare quoteAfter / tokensAfter with quoteBefore / tokensBefore by cross-multiplying.
        uint256 before_ = quoteBefore * tokensAfter;
        uint256 after_ = quoteAfter * tokensBefore;
        uint256 limit = Math.mulDiv(before_, MAX_PRICE_IMPACT_BPS, BPS);
        if (after_ > before_ ? after_ - before_ > limit : before_ - after_ > limit) revert PriceImpact();
    }

    function _upper(string calldata s) internal pure returns (string memory) {
        bytes memory b = bytes(s);
        uint256 n = b.length > 12 ? 12 : b.length;
        bytes memory out = new bytes(n);
        for (uint256 i; i < n; ++i) {
            bytes1 ch = b[i];
            out[i] = (ch >= 0x61 && ch <= 0x7a) ? bytes1(uint8(ch) - 32) : ch;
        }
        return string(out);
    }
}
