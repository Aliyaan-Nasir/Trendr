// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {IERC20Permit} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Permit.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";
import {SignedMath} from "@openzeppelin/contracts/utils/math/SignedMath.sol";

import {ICurationFees} from "../interfaces/ICurationFees.sol";
import {ITrendRegistry} from "../interfaces/ITrendRegistry.sol";

/// @title AttentionPerp
/// @notice Perpetual long/short exposure to a trend's attention index, settled in collateral (AUSD).
///
///         Mechanics:
///         - The mark is the registry's attention index. One contract (1e18 units of `qty`) is worth
///           one collateral unit per index point, so PnL = qty x (exit - entry) for a long.
///         - Isolated margin per position, up to 3x leverage at open, 10% maintenance margin.
///         - Funding is a per-block crowding tax: the larger side pays the smaller side a rate
///           proportional to the long/short skew, capped per block. It accrues lazily from the
///           block delta since the last touch; the keeper pokes every block to keep the mark current.
///         - Open interest per side is capped by the insurance pool scaled to the trend's attention.
///         - Liquidation is permissionless once equity falls below maintenance; the liquidator earns
///           up to 1% of notional out of the remaining equity.
///         - Nothing trades against a stale index: opening, closing and liquidating need a fresh
///           observation. A trend the oracle stops updating retires after the stale-retire window,
///           and its positions then settle at the final index, so funds are never stuck.
///
///         Counterparty and loss order: traders settle against the pool (the insurance fund), which
///         also takes trade fees and liquidated margin. A position's losses are covered first by its
///         own margin, then by the pool. When the pool cannot pay a winning position in full, the
///         winner is paid what the pool holds, no fee is taken, and the shortfall is socialized
///         (emitted as `SocializedLoss`). Other traders' margins are never used. A retired trend settles every
///         position at its final index with no fee. The contract is ownerless.
contract AttentionPerp is ReentrancyGuard {
    using SafeERC20 for IERC20;
    using SafeCast for uint256;
    using SafeCast for int256;

    struct Position {
        address owner;
        bytes32 trendId;
        bool isLong;
        uint64 entryIndex;
        uint256 qty;
        uint256 margin;
        int256 entryFunding;
    }

    struct Market {
        uint256 longQty;
        uint256 shortQty;
        /// @dev Cumulative funding per contract, in collateral units scaled by 1e18; positive is owed.
        int256 cumLong;
        int256 cumShort;
        uint64 lastBlock;
        uint64 lastMark;
    }

    uint256 internal constant WAD = 1e18;
    uint256 internal constant BPS = 10_000;
    uint64 internal constant INDEX_SCALE = 1e6;

    uint256 public constant MAX_LEVERAGE = 3e18;
    uint256 public constant MAINTENANCE_MARGIN_BPS = 1000;
    uint256 public constant TRADE_FEE_BPS = 10;
    uint256 public constant LIQUIDATION_REWARD_BPS = 100;
    uint256 public constant INSURANCE_FEE_SHARE_BPS = 6000;
    uint256 public constant CURATION_FEE_SHARE_BPS = 1500;
    /// @notice Funding rate per block at 100% skew (2e-7 of notional), also the per-block cap.
    uint256 public constant FUNDING_RATE_PER_BLOCK_AT_FULL_SKEW = 2e11;
    uint256 public constant MAX_FUNDING_RATE_PER_BLOCK = 2e11;
    /// @notice Each side's notional may reach this multiple of the pool, scaled by attention.
    uint256 public constant OI_POOL_MULTIPLE = 5;
    /// @notice Attention index at which the open interest cap is no longer scaled down (25 points).
    uint64 public constant ATTENTION_REFERENCE_INDEX = 25e6;
    /// @notice Smallest attention scaling of the cap (20%).
    uint256 public constant MIN_ATTENTION_FACTOR = 0.2e18;

    IERC20 public immutable collateral;
    ITrendRegistry public immutable registry;
    ICurationFees public immutable curation;
    address public immutable treasury;
    uint256 public immutable unit;
    uint256 public immutable minMargin;
    /// @notice Absolute cap on each side's notional per trend, in collateral units.
    uint256 public immutable maxOpenInterestPerSide;

    mapping(bytes32 trendId => Market) public markets;
    mapping(uint256 id => Position) internal _positions;
    uint256 public nextPositionId = 1;

    /// @notice The pool: insurance fund and counterparty to every position.
    uint256 public pool;
    /// @notice Sum of open positions' margins.
    uint256 public totalMargin;
    /// @notice Protocol fees waiting to be swept to the treasury.
    uint256 public protocolFees;

    event Poked(bytes32 indexed trendId, uint64 mark, int256 cumLong, int256 cumShort, uint64 blockNumber);
    event PositionOpened(
        uint256 indexed id,
        address indexed owner,
        bytes32 indexed trendId,
        bool isLong,
        uint256 qty,
        uint256 margin,
        uint64 entryIndex,
        uint256 fee,
        address payer
    );
    event MarginAdded(uint256 indexed id, address indexed payer, uint256 amount);
    event PositionClosed(
        uint256 indexed id,
        address indexed owner,
        uint64 exitIndex,
        int256 pnl,
        int256 funding,
        uint256 fee,
        uint256 payout
    );
    event PositionLiquidated(
        uint256 indexed id, address indexed liquidator, uint64 exitIndex, int256 equity, uint256 reward
    );
    event SocializedLoss(uint256 indexed id, uint256 shortfall);
    event PoolDeposit(address indexed from, uint256 amount);
    event ProtocolFeesSwept(address indexed to, uint256 amount);

    error ZeroAddress();
    error InvalidParams();
    error Expired();
    error ZeroAmount();
    error MarginTooSmall();
    error InvalidLeverage();
    error TrendNotActive();
    error IndexStale();
    error PriceNotAcceptable();
    error OpenInterestCap();
    error NotOwner();
    error UnknownPosition();
    error NotLiquidatable();
    error TrendNotRetired();
    error TrendRetired();

    constructor(
        IERC20 collateral_,
        ITrendRegistry registry_,
        ICurationFees curation_,
        address treasury_,
        uint256 maxOpenInterestPerSide_
    ) {
        if (
            address(collateral_) == address(0) || address(registry_) == address(0)
                || address(curation_) == address(0) || treasury_ == address(0)
        ) revert ZeroAddress();
        uint256 unit_ = 10 ** IERC20Metadata(address(collateral_)).decimals();
        if (maxOpenInterestPerSide_ < 1000 * unit_ || maxOpenInterestPerSide_ > 100_000_000 * unit_) {
            revert InvalidParams();
        }
        collateral = collateral_;
        registry = registry_;
        curation = curation_;
        treasury = treasury_;
        unit = unit_;
        minMargin = unit_;
        maxOpenInterestPerSide = maxOpenInterestPerSide_;
    }

    // ---------------------------------------------------------------------------------------
    // Funding
    // ---------------------------------------------------------------------------------------

    /// @notice Accrues funding up to this block and refreshes the mark. Permissionless.
    function poke(bytes32 trendId) public {
        _accrue(trendId);
    }

    // ---------------------------------------------------------------------------------------
    // Trading
    // ---------------------------------------------------------------------------------------

    /// @notice Opens an isolated position owned by the caller.
    /// @param margin Collateral paid in, including the trade fee.
    /// @param leverage Notional over net margin, 1e18-scaled, at most 3e18.
    /// @param acceptableIndex Highest entry for a long, lowest entry for a short.
    function open(
        bytes32 trendId,
        bool isLong,
        uint256 margin,
        uint256 leverage,
        uint64 acceptableIndex,
        uint256 deadline
    ) public returns (uint256 id) {
        return openFor(msg.sender, trendId, isLong, margin, leverage, acceptableIndex, deadline);
    }

    /// @notice Opens a position owned by `owner`, paid for by the caller. Lets a deposit flow
    ///         (for example an any-chain deposit that executes on arrival) open a position
    ///         straight into the user's account. Only `owner` can close it.
    function openFor(
        address owner,
        bytes32 trendId,
        bool isLong,
        uint256 margin,
        uint256 leverage,
        uint64 acceptableIndex,
        uint256 deadline
    ) public nonReentrant returns (uint256 id) {
        if (owner == address(0)) revert ZeroAddress();
        if (block.timestamp > deadline) revert Expired();
        if (leverage == 0 || leverage > MAX_LEVERAGE) revert InvalidLeverage();
        if (registry.statusOf(trendId) != ITrendRegistry.Status.Active) revert TrendNotActive();
        if (!registry.isFresh(trendId)) revert IndexStale();

        uint64 index = _accrue(trendId);
        if (isLong ? index > acceptableIndex : index < acceptableIndex) revert PriceNotAcceptable();

        // margin = net + fee, fee = net x leverage x feeRate, so net = margin / (1 + leverage x feeRate).
        uint256 net = Math.mulDiv(margin, BPS * WAD, BPS * WAD + leverage * TRADE_FEE_BPS);
        if (net < minMargin) revert MarginTooSmall();
        uint256 fee = margin - net;
        uint256 notional = Math.mulDiv(net, leverage, WAD);
        uint256 qty = Math.mulDiv(notional, WAD * INDEX_SCALE, uint256(index) * unit);
        if (qty == 0) revert ZeroAmount();

        Market storage m = markets[trendId];
        uint256 sideQty = (isLong ? m.longQty : m.shortQty) + qty;
        if (_notional(sideQty, index) > openInterestCap(index)) revert OpenInterestCap();
        if (isLong) m.longQty = sideQty;
        else m.shortQty = sideQty;

        id = nextPositionId++;
        _positions[id] = Position({
            owner: owner,
            trendId: trendId,
            isLong: isLong,
            entryIndex: index,
            qty: qty,
            margin: net,
            entryFunding: isLong ? m.cumLong : m.cumShort
        });
        totalMargin += net;
        uint256 toCuration = _bookFee(fee);

        collateral.safeTransferFrom(msg.sender, address(this), margin);
        _payCuration(trendId, toCuration);
        emit PositionOpened(id, owner, trendId, isLong, qty, net, index, fee, msg.sender);
    }

    /// @notice `open` preceded by an EIP-2612 permit on the collateral; a failing permit is ignored.
    function openWithPermit(
        bytes32 trendId,
        bool isLong,
        uint256 margin,
        uint256 leverage,
        uint64 acceptableIndex,
        uint256 deadline,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external returns (uint256) {
        try IERC20Permit(address(collateral)).permit(msg.sender, address(this), margin, deadline, v, r, s) {}
            catch {}
        return open(trendId, isLong, margin, leverage, acceptableIndex, deadline);
    }

    /// @notice Adds margin to the caller's open position. Only the owner may: a top-up of someone
    ///         else's position would let a capped session key move the account's collateral to a
    ///         position its holder controls.
    function addMargin(uint256 id, uint256 amount) external nonReentrant {
        if (amount == 0) revert ZeroAmount();
        Position storage p = _getPosition(id);
        if (p.owner != msg.sender) revert NotOwner();
        p.margin += amount;
        totalMargin += amount;
        collateral.safeTransferFrom(msg.sender, address(this), amount);
        emit MarginAdded(id, msg.sender, amount);
    }

    /// @notice Closes the caller's position at the current mark. Needs a fresh index.
    /// @param acceptableIndex Lowest exit for a long, highest exit for a short.
    function close(uint256 id, uint64 acceptableIndex, uint256 deadline)
        external
        nonReentrant
        returns (uint256 payout)
    {
        if (block.timestamp > deadline) revert Expired();
        Position memory p = _getPosition(id);
        if (p.owner != msg.sender) revert NotOwner();
        if (registry.statusOf(p.trendId) == ITrendRegistry.Status.Retired) revert TrendRetired();
        if (!registry.isFresh(p.trendId)) revert IndexStale();
        uint64 index = _accrue(p.trendId);
        if (p.isLong ? index < acceptableIndex : index > acceptableIndex) revert PriceNotAcceptable();
        uint256 fee = Math.mulDiv(_notional(p.qty, index), TRADE_FEE_BPS, BPS);
        payout = _settle(id, p, index, fee);
    }

    /// @notice Settles any position of a retired trend at the final index, with no fee, paying its
    ///         owner. Permissionless so positions never stay stranded.
    function settleRetired(uint256 id) external nonReentrant returns (uint256 payout) {
        Position memory p = _getPosition(id);
        if (registry.statusOf(p.trendId) != ITrendRegistry.Status.Retired) revert TrendNotRetired();
        uint64 index = _accrue(p.trendId);
        payout = _settle(id, p, index, 0);
    }

    /// @notice Liquidates a position whose equity is below maintenance margin. Permissionless;
    ///         needs a fresh index.
    function liquidate(uint256 id) external nonReentrant returns (uint256 reward) {
        Position memory p = _getPosition(id);
        // Positions of a retired trend settle through settleRetired instead.
        if (registry.statusOf(p.trendId) == ITrendRegistry.Status.Retired) revert TrendRetired();
        if (!registry.isFresh(p.trendId)) revert IndexStale();
        uint64 index = _accrue(p.trendId);
        (int256 equity,,) = _equity(p, index);
        uint256 notional = _notional(p.qty, index);
        if (equity >= Math.mulDiv(notional, MAINTENANCE_MARGIN_BPS, BPS).toInt256()) {
            revert NotLiquidatable();
        }

        _removePosition(id, p);
        pool += p.margin;
        if (equity > 0) {
            reward = Math.min(Math.mulDiv(notional, LIQUIDATION_REWARD_BPS, BPS), equity.toUint256());
            reward = Math.min(reward, pool);
            pool -= reward;
            collateral.safeTransfer(msg.sender, reward);
        }
        emit PositionLiquidated(id, msg.sender, index, equity, reward);
    }

    // ---------------------------------------------------------------------------------------
    // Pool and fees
    // ---------------------------------------------------------------------------------------

    /// @notice Adds collateral to the pool (insurance). Anyone may deposit; deposits cannot be
    ///         withdrawn and only ever back traders.
    function depositPool(uint256 amount) external nonReentrant {
        if (amount == 0) revert ZeroAmount();
        pool += amount;
        collateral.safeTransferFrom(msg.sender, address(this), amount);
        emit PoolDeposit(msg.sender, amount);
    }

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

    function positionOf(uint256 id) external view returns (Position memory) {
        return _positions[id];
    }

    /// @notice Cap on each side's notional at `index`.
    function openInterestCap(uint64 index) public view returns (uint256) {
        uint256 factor = index >= ATTENTION_REFERENCE_INDEX
            ? WAD
            : Math.max(Math.mulDiv(index, WAD, ATTENTION_REFERENCE_INDEX), MIN_ATTENTION_FACTOR);
        return Math.min(Math.mulDiv(pool * OI_POOL_MULTIPLE, factor, WAD), maxOpenInterestPerSide);
    }

    /// @notice Equity, PnL and funding of a position at the current index, including funding
    ///         accrued since the last touch.
    function positionState(uint256 id)
        external
        view
        returns (int256 equity, int256 pnl, int256 funding, uint64 index)
    {
        Position memory p = _positions[id];
        if (p.owner == address(0)) revert UnknownPosition();
        // Only the index is needed.
        // forge-lint: disable-next-line(unused-return)
        (index,) = registry.indexOf(p.trendId);
        (int256 cumLong, int256 cumShort,) = _pendingCumulative(p.trendId);
        int256 delta = (p.isLong ? cumLong : cumShort) - p.entryFunding;
        funding = _fundingOwed(p.qty, delta);
        pnl = _pnl(p, index);
        equity = p.margin.toInt256() + pnl - funding;
    }

    /// @notice Current funding rate per block (1e18-scaled fraction of notional), positive when
    ///         longs pay shorts.
    function fundingRatePerBlock(bytes32 trendId) public view returns (int256) {
        Market storage m = markets[trendId];
        return _rate(m.longQty, m.shortQty);
    }

    // ---------------------------------------------------------------------------------------
    // Internals
    // ---------------------------------------------------------------------------------------

    function _accrue(bytes32 trendId) internal returns (uint64 index) {
        Market storage m = markets[trendId];
        // Freshness is checked by callers that need it.
        // forge-lint: disable-next-line(unused-return)
        (index,) = registry.indexOf(trendId);
        if (m.lastBlock != 0 && block.number > m.lastBlock) {
            (int256 cumLong, int256 cumShort,) = _pendingCumulative(trendId);
            m.cumLong = cumLong;
            m.cumShort = cumShort;
        }
        m.lastBlock = block.number.toUint64();
        m.lastMark = index;
        emit Poked(trendId, index, m.cumLong, m.cumShort, m.lastBlock);
    }

    /// @dev Funding accrued since the last touch at the last stored mark. The paying side's index
    ///      rounds up and the receiving side's rounds down, so receivers never get more than payers
    ///      pay; when the receiving side is empty the payment stays with the pool.
    function _pendingCumulative(bytes32 trendId)
        internal
        view
        returns (int256 cumLong, int256 cumShort, int256 rate)
    {
        Market storage m = markets[trendId];
        cumLong = m.cumLong;
        cumShort = m.cumShort;
        if (m.lastBlock == 0 || block.number <= m.lastBlock) return (cumLong, cumShort, 0);
        if (registry.statusOf(trendId) == ITrendRegistry.Status.Retired) return (cumLong, cumShort, 0);
        rate = _rate(m.longQty, m.shortQty);
        if (rate == 0) return (cumLong, cumShort, 0);

        uint256 blocks = block.number - m.lastBlock;
        uint256 absRate = SignedMath.abs(rate);
        // Collateral units x 1e18 per contract owed by the paying side over the elapsed blocks.
        uint256 perContract =
            Math.mulDiv(absRate * blocks, uint256(m.lastMark) * unit, INDEX_SCALE, Math.Rounding.Ceil);
        if (rate > 0) {
            cumLong += perContract.toInt256();
            if (m.shortQty > 0) cumShort -= Math.mulDiv(perContract, m.longQty, m.shortQty).toInt256();
        } else {
            cumShort += perContract.toInt256();
            if (m.longQty > 0) cumLong -= Math.mulDiv(perContract, m.shortQty, m.longQty).toInt256();
        }
    }

    function _rate(uint256 longQty, uint256 shortQty) internal pure returns (int256) {
        uint256 total = longQty + shortQty;
        if (total == 0 || longQty == shortQty) return 0;
        uint256 diff = longQty > shortQty ? longQty - shortQty : shortQty - longQty;
        uint256 r = Math.min(
            Math.mulDiv(diff, FUNDING_RATE_PER_BLOCK_AT_FULL_SKEW, total), MAX_FUNDING_RATE_PER_BLOCK
        );
        return longQty > shortQty ? r.toInt256() : -r.toInt256();
    }

    function _settle(uint256 id, Position memory p, uint64 index, uint256 fee)
        internal
        returns (uint256 payout)
    {
        (int256 equity, int256 pnl, int256 funding) = _equity(p, index);
        _removePosition(id, p);
        pool += p.margin;

        uint256 feeCharged;
        if (equity > 0) {
            feeCharged = Math.min(fee, equity.toUint256());
            payout = equity.toUint256() - feeCharged;
            if (payout > pool) {
                emit SocializedLoss(id, payout - pool);
                payout = pool;
            }
            // The trader is paid first and the fee takes only what the pool has left, so a fee
            // never deepens a shortfall and settling never reverts.
            feeCharged = Math.min(feeCharged, pool - payout);
            pool -= payout + feeCharged;
        }
        uint256 toCuration = _bookFee(feeCharged);
        _payCuration(p.trendId, toCuration);
        if (payout > 0) collateral.safeTransfer(p.owner, payout);
        emit PositionClosed(id, p.owner, index, pnl, funding, feeCharged, payout);
    }

    function _equity(Position memory p, uint64 index)
        internal
        view
        returns (int256 equity, int256 pnl, int256 funding)
    {
        Market storage m = markets[p.trendId];
        int256 delta = (p.isLong ? m.cumLong : m.cumShort) - p.entryFunding;
        funding = _fundingOwed(p.qty, delta);
        pnl = _pnl(p, index);
        equity = p.margin.toInt256() + pnl - funding;
    }

    /// @dev Gains round down and losses round up, in the pool's favour.
    function _pnl(Position memory p, uint64 index) internal view returns (int256) {
        bool up = index >= p.entryIndex;
        uint256 move = up ? index - p.entryIndex : p.entryIndex - index;
        bool gain = up == p.isLong;
        uint256 amount = Math.mulDiv(
            p.qty * move, unit, WAD * INDEX_SCALE, gain ? Math.Rounding.Floor : Math.Rounding.Ceil
        );
        return gain ? amount.toInt256() : -amount.toInt256();
    }

    /// @dev Positive delta is owed (rounded up), negative is credited (rounded down).
    function _fundingOwed(uint256 qty, int256 delta) internal pure returns (int256) {
        if (delta >= 0) return Math.mulDiv(qty, delta.toUint256(), WAD * WAD, Math.Rounding.Ceil).toInt256();
        return -Math.mulDiv(qty, SignedMath.abs(delta), WAD * WAD).toInt256();
    }

    function _notional(uint256 qty, uint64 index) internal view returns (uint256) {
        return Math.mulDiv(qty, uint256(index) * unit, WAD * INDEX_SCALE);
    }

    // Zero-amount early returns, not balance checks.
    // slither-disable-start incorrect-equality
    /// @dev Books a fee's pool and protocol shares and returns the curation share, which
    ///      `_payCuration` sends once the trade's own transfers are done.
    function _bookFee(uint256 fee) internal returns (uint256 toCuration) {
        if (fee == 0) return 0;
        uint256 toPool = Math.mulDiv(fee, INSURANCE_FEE_SHARE_BPS, BPS);
        toCuration = Math.mulDiv(fee, CURATION_FEE_SHARE_BPS, BPS);
        pool += toPool;
        protocolFees += fee - toPool - toCuration;
    }

    function _payCuration(bytes32 trendId, uint256 amount) internal {
        if (amount == 0) return;
        collateral.forceApprove(address(curation), amount);
        curation.accrue(trendId, amount);
    }
    // slither-disable-end incorrect-equality

    function _removePosition(uint256 id, Position memory p) internal {
        Market storage m = markets[p.trendId];
        if (p.isLong) m.longQty -= p.qty;
        else m.shortQty -= p.qty;
        totalMargin -= p.margin;
        delete _positions[id];
    }

    function _getPosition(uint256 id) internal view returns (Position storage p) {
        p = _positions[id];
        if (p.owner == address(0)) revert UnknownPosition();
    }
}
