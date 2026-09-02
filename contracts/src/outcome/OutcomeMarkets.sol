// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {IERC20Permit} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Permit.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Strings} from "@openzeppelin/contracts/utils/Strings.sol";
import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";

import {ITrendRegistry} from "../interfaces/ITrendRegistry.sol";
import {OutcomeToken} from "./OutcomeToken.sol";

/// @title OutcomeMarkets
/// @notice Attention outcome contracts. For each trend and window (24 hours or 7 days) a series
///         issues an UP and a DOWN token answering "will this trend's attention index be above its
///         opening level at expiry?". A Testnet deployment may add one short window (minutes) so
///         the full cycle can be exercised quickly; Mainnet deploys with only 24 hours and 7 days.
///
///         Issuance and settlement rules:
///         - A complete set (one UP plus one DOWN) is minted for exactly one collateral unit and can
///           be redeemed for exactly one collateral unit at any time, before or after settlement.
///         - At expiry the registry's settlement value for (trend, expiry) decides the outcome:
///           UP wins if it is strictly above the opening index, otherwise DOWN wins (a tie is DOWN,
///           because the question asks for "above").
///         - Each winning token redeems for one collateral unit; losing tokens redeem for nothing.
///         - If no settlement value is finalized within VOID_GRACE after expiry, the series is void
///           and every token redeems for half a unit, so funds can never be stuck.
///         Collateral fully backs every outstanding set at all times. The contract is ownerless.
contract OutcomeMarkets is ReentrancyGuard {
    using SafeERC20 for IERC20;
    using SafeCast for uint256;

    enum Outcome {
        Open,
        Up,
        Down,
        Void
    }

    struct Series {
        bytes32 trendId;
        uint64 openedAt;
        uint64 expiry;
        uint64 openingIndex;
        uint64 settlementIndex;
        uint32 window;
        Outcome outcome;
        OutcomeToken up;
        OutcomeToken down;
        uint256 backing;
    }

    uint32 public constant WINDOW_24H = 1 days;
    uint32 public constant WINDOW_7D = 7 days;
    uint32 public constant MIN_TEST_WINDOW = 5 minutes;
    uint32 public constant MAX_TEST_WINDOW = 1 hours;
    /// @notice Time after expiry after which an unsettled series becomes void.
    uint64 public constant VOID_GRACE = 2 days;

    IERC20 public immutable collateral;
    ITrendRegistry public immutable registry;
    uint8 public immutable collateralDecimals;
    /// @notice Extra short window for test deployments, or zero (Mainnet).
    uint32 public immutable testWindow;

    mapping(bytes32 seriesId => Series) internal _series;
    /// @notice Latest series per trend and window.
    mapping(bytes32 trendId => mapping(uint32 window => bytes32 seriesId)) public latestSeries;
    /// @notice Number of series ever opened per trend and window (used in token names).
    mapping(bytes32 trendId => mapping(uint32 window => uint32 count)) public seriesCount;

    uint256 public totalBacking;

    event SeriesOpened(
        bytes32 indexed seriesId,
        bytes32 indexed trendId,
        uint32 window,
        uint64 openedAt,
        uint64 expiry,
        uint64 openingIndex,
        address up,
        address down
    );
    event SetsMinted(bytes32 indexed seriesId, address indexed payer, address indexed to, uint256 amount);
    event SetsRedeemed(bytes32 indexed seriesId, address indexed owner, address indexed to, uint256 amount);
    event SeriesSettled(
        bytes32 indexed seriesId, Outcome outcome, uint64 openingIndex, uint64 settlementIndex
    );
    event WinningsRedeemed(
        bytes32 indexed seriesId,
        address indexed owner,
        address indexed to,
        uint256 upAmount,
        uint256 downAmount,
        uint256 payout
    );

    error ZeroAddress();
    error InvalidWindow();
    error IdentifierMismatch();
    error TrendNotActive();
    error IndexStale();
    error SeriesStillOpen();
    error UnknownSeries();
    error SeriesExpired();
    error SeriesNotExpired();
    error AlreadySettled();
    error NotSettled();
    error NotSettleable();
    error ZeroAmount();

    /// @param testWindow_ Zero, or a short extra window between MIN_TEST_WINDOW and MAX_TEST_WINDOW.
    constructor(IERC20 collateral_, ITrendRegistry registry_, uint32 testWindow_) {
        if (address(collateral_) == address(0) || address(registry_) == address(0)) revert ZeroAddress();
        if (testWindow_ != 0 && (testWindow_ < MIN_TEST_WINDOW || testWindow_ > MAX_TEST_WINDOW)) {
            revert InvalidWindow();
        }
        collateral = collateral_;
        registry = registry_;
        collateralDecimals = IERC20Metadata(address(collateral_)).decimals();
        testWindow = testWindow_;
    }

    /// @notice Every window series can be opened for.
    function windows() public view returns (uint32[] memory out) {
        out = new uint32[](testWindow == 0 ? 2 : 3);
        out[0] = WINDOW_24H;
        out[1] = WINDOW_7D;
        if (testWindow != 0) out[2] = testWindow;
    }

    // ---------------------------------------------------------------------------------------
    // Series lifecycle
    // ---------------------------------------------------------------------------------------

    /// @notice Opens the next series for a trend and window. Permissionless: the keeper calls it
    ///         as soon as a trend appears and again whenever the previous series expires.
    /// @param identifier The trend's normalized identifier; its hash must be the trend id.
    function openSeries(string calldata identifier, uint32 window) external returns (bytes32 seriesId) {
        if (window != WINDOW_24H && window != WINDOW_7D && (window == 0 || window != testWindow)) {
            revert InvalidWindow();
        }
        bytes32 trendId = keccak256(bytes(identifier));
        if (registry.statusOf(trendId) != ITrendRegistry.Status.Active) revert TrendNotActive();
        if (!registry.isFresh(trendId)) revert IndexStale();

        bytes32 previous = latestSeries[trendId][window];
        if (previous != bytes32(0) && block.timestamp < _series[previous].expiry) revert SeriesStillOpen();

        // Freshness was checked above.
        // forge-lint: disable-next-line(unused-return)
        (uint64 index,) = registry.indexOf(trendId);
        uint64 openedAt = block.timestamp.toUint64();
        uint64 expiry = openedAt + window;
        uint32 number = ++seriesCount[trendId][window];
        seriesId = keccak256(abi.encode(trendId, window, openedAt));

        string memory label =
            string.concat(identifier, " ", _windowLabel(window), " #", Strings.toString(number));
        OutcomeToken up = new OutcomeToken{salt: seriesId}(
            string.concat("Trendr UP ", label), "UP", collateralDecimals, seriesId, true
        );
        OutcomeToken down = new OutcomeToken{salt: seriesId}(
            string.concat("Trendr DOWN ", label), "DOWN", collateralDecimals, seriesId, false
        );

        _series[seriesId] = Series({
            trendId: trendId,
            openedAt: openedAt,
            expiry: expiry,
            openingIndex: index,
            settlementIndex: 0,
            window: window,
            outcome: Outcome.Open,
            up: up,
            down: down,
            backing: 0
        });
        latestSeries[trendId][window] = seriesId;
        emit SeriesOpened(seriesId, trendId, window, openedAt, expiry, index, address(up), address(down));
    }

    /// @notice Settles an expired series from the registry. Permissionless.
    function settle(bytes32 seriesId) public returns (Outcome outcome) {
        Series storage s = _getSeries(seriesId);
        if (s.outcome != Outcome.Open) revert AlreadySettled();
        if (block.timestamp < s.expiry) revert SeriesNotExpired();

        (bool finalized, uint64 value) = registry.settlementOf(s.trendId, s.expiry);
        if (finalized) {
            outcome = value > s.openingIndex ? Outcome.Up : Outcome.Down;
            s.settlementIndex = value;
        } else if (block.timestamp >= uint256(s.expiry) + VOID_GRACE) {
            outcome = Outcome.Void;
        } else {
            revert NotSettleable();
        }
        s.outcome = outcome;
        emit SeriesSettled(seriesId, outcome, s.openingIndex, s.settlementIndex);
    }

    // ---------------------------------------------------------------------------------------
    // Complete sets
    // ---------------------------------------------------------------------------------------

    /// @notice Mints `amount` complete sets to `to` for exactly `amount` collateral.
    ///         Only while the series is open and the trend is Active.
    function mint(bytes32 seriesId, uint256 amount, address to) public nonReentrant {
        if (amount == 0) revert ZeroAmount();
        if (to == address(0)) revert ZeroAddress();
        Series storage s = _getSeries(seriesId);
        if (block.timestamp >= s.expiry) revert SeriesExpired();
        if (registry.statusOf(s.trendId) != ITrendRegistry.Status.Active) revert TrendNotActive();

        s.backing += amount;
        totalBacking += amount;
        collateral.safeTransferFrom(msg.sender, address(this), amount);
        s.up.mint(to, amount);
        s.down.mint(to, amount);
        emit SetsMinted(seriesId, msg.sender, to, amount);
    }

    /// @notice `mint` preceded by an EIP-2612 permit on the collateral. A failing permit (for
    ///         example one already used by a front-runner) is ignored so the mint still succeeds
    ///         when the allowance is in place.
    function mintWithPermit(
        bytes32 seriesId,
        uint256 amount,
        address to,
        uint256 deadline,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external {
        try IERC20Permit(address(collateral)).permit(msg.sender, address(this), amount, deadline, v, r, s) {}
            catch {}
        mint(seriesId, amount, to);
    }

    /// @notice Burns `amount` UP and `amount` DOWN from the caller and pays `amount` collateral.
    ///         Always available, before and after settlement.
    function redeemSets(bytes32 seriesId, uint256 amount, address to) external nonReentrant {
        if (amount == 0) revert ZeroAmount();
        if (to == address(0)) revert ZeroAddress();
        Series storage s = _getSeries(seriesId);
        s.backing -= amount;
        totalBacking -= amount;
        s.up.burn(msg.sender, amount);
        s.down.burn(msg.sender, amount);
        collateral.safeTransfer(to, amount);
        emit SetsRedeemed(seriesId, msg.sender, to, amount);
    }

    /// @notice Redeems settled tokens: each winning token pays one unit, each token of a void
    ///         series pays half a unit, losing tokens pay nothing. Settles first if needed.
    function redeemWinnings(bytes32 seriesId, uint256 upAmount, uint256 downAmount, address to)
        external
        nonReentrant
        returns (uint256 payout)
    {
        if (upAmount == 0 && downAmount == 0) revert ZeroAmount();
        if (to == address(0)) revert ZeroAddress();
        Series storage s = _getSeries(seriesId);
        Outcome outcome = s.outcome;
        if (outcome == Outcome.Open) outcome = settle(seriesId);

        if (outcome == Outcome.Up) payout = upAmount;
        else if (outcome == Outcome.Down) payout = downAmount;
        else payout = upAmount / 2 + downAmount / 2;
        s.backing -= payout;
        totalBacking -= payout;

        if (upAmount > 0) s.up.burn(msg.sender, upAmount);
        if (downAmount > 0) s.down.burn(msg.sender, downAmount);
        if (payout > 0) collateral.safeTransfer(to, payout);
        emit WinningsRedeemed(seriesId, msg.sender, to, upAmount, downAmount, payout);
    }

    // ---------------------------------------------------------------------------------------
    // Views
    // ---------------------------------------------------------------------------------------

    function seriesOf(bytes32 seriesId) external view returns (Series memory) {
        return _series[seriesId];
    }

    /// @notice Collateral the series still owes to token holders under its current state.
    function obligations(bytes32 seriesId) public view returns (uint256) {
        Series storage s = _series[seriesId];
        if (address(s.up) == address(0)) return 0;
        uint256 upSupply = s.up.totalSupply();
        uint256 downSupply = s.down.totalSupply();
        if (s.outcome == Outcome.Up) return upSupply;
        if (s.outcome == Outcome.Down) return downSupply;
        if (s.outcome == Outcome.Void) return upSupply / 2 + downSupply / 2;
        // Open: every UP is paired with a DOWN, so either supply equals the sets outstanding.
        return upSupply > downSupply ? upSupply : downSupply;
    }

    function _windowLabel(uint32 window) internal pure returns (string memory) {
        if (window == WINDOW_24H) return "24h";
        if (window == WINDOW_7D) return "7d";
        return string.concat(Strings.toString(window / 1 minutes), "m");
    }

    function _getSeries(bytes32 seriesId) internal view returns (Series storage s) {
        s = _series[seriesId];
        if (address(s.up) == address(0)) revert UnknownSeries();
    }
}
