// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";

import {TrendRegistry} from "../TrendRegistry.sol";
import {BondingCurve} from "../curve/BondingCurve.sol";
import {ITrendRegistry} from "../interfaces/ITrendRegistry.sol";
import {OutcomeListing} from "../outcome/OutcomeListing.sol";
import {OutcomeMarkets} from "../outcome/OutcomeMarkets.sol";
import {AttentionPerp} from "../perp/AttentionPerp.sol";

/// @title TrendrLens
/// @notice Batched, compact read-only views for off-chain clients: the CRE oracle (whose chain
///         reads are limited in number and size), the keeper and the app. It holds no state and
///         no funds, and everything it returns can also be read from the core contracts.
// Every external call here is a view into the trusted core contracts, bounded by caller-supplied
// limits, so calls in loops are intended.
// forge-lint: disable-start(calls-loop)
contract TrendrLens {
    struct OracleTrend {
        bytes32 id;
        uint64 index;
        uint64 updatedAt;
        uint8 status;
        uint8 assetClass;
        /// @dev Latest-series expiry at or before now whose settlement is not final yet, or 0.
        uint64 pendingExpiry;
        /// @dev Soonest latest-series expiry after now, or 0.
        uint64 nextExpiry;
    }

    /// @notice The latest series of a trend in one window, with its Kuru markets.
    struct SeriesView {
        bytes32 trendId;
        uint32 window;
        /// @dev Zero when the trend never had a series in this window.
        bytes32 seriesId;
        uint64 openedAt;
        uint64 expiry;
        uint64 openingIndex;
        uint8 outcome;
        /// @dev True when `settle` would succeed now.
        bool settleable;
        address up;
        address down;
        address upMarket;
        address downMarket;
        /// @dev True once both markets are recorded in OutcomeListing.
        bool listed;
    }

    /// @notice An open perp position with its health at the current index, as `liquidate` sees it.
    struct PositionView {
        uint256 id;
        address owner;
        bytes32 trendId;
        bool isLong;
        uint64 entryIndex;
        uint64 index;
        uint256 qty;
        uint256 margin;
        int256 equity;
        uint256 maintenance;
        /// @dev `liquidate` would succeed now.
        bool liquidatable;
        /// @dev The trend is retired, so `settleRetired` applies.
        bool retired;
    }

    uint256 internal constant WAD = 1e18;
    uint256 internal constant BPS = 10_000;
    uint256 internal constant INDEX_SCALE = 1e6;

    TrendRegistry public immutable registry;
    OutcomeMarkets public immutable outcomes;
    OutcomeListing public immutable listing;
    AttentionPerp public immutable perp;
    BondingCurve public immutable curve;

    error ZeroAddress();

    constructor(
        TrendRegistry registry_,
        OutcomeMarkets outcomes_,
        OutcomeListing listing_,
        AttentionPerp perp_,
        BondingCurve curve_
    ) {
        if (
            address(registry_) == address(0) || address(outcomes_) == address(0)
                || address(listing_) == address(0) || address(perp_) == address(0)
                || address(curve_) == address(0)
        ) revert ZeroAddress();
        registry = registry_;
        outcomes = outcomes_;
        listing = listing_;
        perp = perp_;
        curve = curve_;
    }

    /// @notice Live (not retired) trends in creation order, scanning at most `scanLimit` ids from
    ///         `cursor` and returning at most `maxResults`. Continue from `nextCursor` until it
    ///         equals `total`.
    function oracleSnapshot(uint256 cursor, uint256 scanLimit, uint256 maxResults)
        external
        view
        returns (uint64 lastRunId, uint256 total, uint256 nextCursor, OracleTrend[] memory live)
    {
        lastRunId = registry.lastRunId();
        total = registry.trendCount();
        OracleTrend[] memory found = new OracleTrend[](maxResults);
        uint256 n;
        uint256 end = cursor + scanLimit < total ? cursor + scanLimit : total;
        nextCursor = cursor;
        while (nextCursor < end && n < maxResults) {
            bytes32 id = registry.trendIdAt(nextCursor);
            ++nextCursor;
            ITrendRegistry.Trend memory t = registry.trendOf(id);
            if (t.status == ITrendRegistry.Status.Retired) continue;
            (uint64 pending, uint64 upcoming) = _expiries(id);
            found[n++] = OracleTrend({
                id: id,
                index: t.index,
                updatedAt: t.updatedAt,
                status: uint8(t.status),
                assetClass: uint8(t.assetClass),
                pendingExpiry: pending,
                nextExpiry: upcoming
            });
        }
        live = new OracleTrend[](n);
        for (uint256 i; i < n; ++i) {
            live[i] = found[i];
        }
    }

    /// @notice Identifiers for `ids` (empty strings for unknown ids).
    function identifiers(bytes32[] calldata ids) external view returns (string[] memory out) {
        out = new string[](ids.length);
        for (uint256 i; i < ids.length; ++i) {
            out[i] = registry.identifierOf(ids[i]);
        }
    }

    /// @notice Registry status for each of `ids`, so a client can check candidate identifiers
    ///         (and their versioned successors) in one call.
    function statuses(bytes32[] calldata ids) external view returns (uint8[] memory out) {
        out = new uint8[](ids.length);
        for (uint256 i; i < ids.length; ++i) {
            out[i] = uint8(registry.statusOf(ids[i]));
        }
    }

    /// @notice The latest series of each of `trendIds` in every window, trend by trend.
    function series(bytes32[] calldata trendIds) external view returns (SeriesView[] memory out) {
        uint32[] memory windows = outcomes.windows();
        out = new SeriesView[](trendIds.length * windows.length);
        for (uint256 t; t < trendIds.length; ++t) {
            for (uint256 w; w < windows.length; ++w) {
                out[t * windows.length + w] = _seriesView(trendIds[t], windows[w]);
            }
        }
    }

    /// @notice Open positions with ids from `fromId`, checking at most `count` ids. Continue from
    ///         `nextId` until it equals the perp's `nextPositionId`.
    function positions(uint256 fromId, uint256 count)
        external
        view
        returns (PositionView[] memory open, uint256 nextId)
    {
        uint256 end = Math.min(fromId + count, perp.nextPositionId());
        PositionView[] memory found = new PositionView[](end > fromId ? end - fromId : 0);
        uint256 n;
        for (nextId = fromId; nextId < end; ++nextId) {
            AttentionPerp.Position memory p = perp.positionOf(nextId);
            if (p.owner == address(0)) continue;
            found[n++] = _positionView(nextId, p);
        }
        open = new PositionView[](n);
        for (uint256 i; i < n; ++i) {
            open[i] = found[i];
        }
    }

    /// @notice Those of `trendIds` whose curve is full and waiting to graduate.
    function readyCurves(bytes32[] calldata trendIds) external view returns (bytes32[] memory ready) {
        bytes32[] memory found = new bytes32[](trendIds.length);
        uint256 n;
        for (uint256 i; i < trendIds.length; ++i) {
            if (curve.curveOf(trendIds[i]).state == BondingCurve.State.Ready) found[n++] = trendIds[i];
        }
        ready = new bytes32[](n);
        for (uint256 i; i < n; ++i) {
            ready[i] = found[i];
        }
    }

    function _seriesView(bytes32 trendId, uint32 window) internal view returns (SeriesView memory v) {
        v.trendId = trendId;
        v.window = window;
        v.seriesId = outcomes.latestSeries(trendId, window);
        if (v.seriesId == bytes32(0)) return v;
        OutcomeMarkets.Series memory s = outcomes.seriesOf(v.seriesId);
        v.openedAt = s.openedAt;
        v.expiry = s.expiry;
        v.openingIndex = s.openingIndex;
        v.outcome = uint8(s.outcome);
        v.up = address(s.up);
        v.down = address(s.down);
        if (s.outcome == OutcomeMarkets.Outcome.Open && block.timestamp >= s.expiry) {
            // Only finality matters here, not the value.
            // forge-lint: disable-next-line(unused-return)
            (bool finalized,) = registry.settlementOf(trendId, s.expiry);
            v.settleable = finalized || block.timestamp >= uint256(s.expiry) + outcomes.VOID_GRACE();
        }
        bool upListed;
        bool downListed;
        (v.upMarket, v.downMarket, upListed, downListed) = listing.marketsOf(v.seriesId);
        v.listed = upListed && downListed;
    }

    function _positionView(uint256 id, AttentionPerp.Position memory p)
        internal
        view
        returns (PositionView memory v)
    {
        v.id = id;
        v.owner = p.owner;
        v.trendId = p.trendId;
        v.isLong = p.isLong;
        v.entryIndex = p.entryIndex;
        v.qty = p.qty;
        v.margin = p.margin;
        // Equity includes funding accrued since the last touch, exactly as `liquidate` computes it.
        // forge-lint: disable-next-line(unused-return)
        (v.equity,,, v.index) = perp.positionState(id);
        v.maintenance = Math.mulDiv(
            Math.mulDiv(p.qty, uint256(v.index) * perp.unit(), WAD * INDEX_SCALE),
            perp.MAINTENANCE_MARGIN_BPS(),
            BPS
        );
        v.retired = registry.statusOf(p.trendId) == ITrendRegistry.Status.Retired;
        v.liquidatable =
            !v.retired && registry.isFresh(p.trendId) && v.equity < SafeCast.toInt256(v.maintenance);
    }

    function _expiries(bytes32 id) internal view returns (uint64 pending, uint64 upcoming) {
        uint32[] memory windows = outcomes.windows();
        for (uint256 w; w < windows.length; ++w) {
            bytes32 seriesId = outcomes.latestSeries(id, windows[w]);
            if (seriesId == bytes32(0)) continue;
            uint64 expiry = outcomes.seriesOf(seriesId).expiry;
            if (expiry > block.timestamp) {
                if (upcoming == 0 || expiry < upcoming) upcoming = expiry;
            } else {
                // Only finality matters here, not the value.
                // forge-lint: disable-next-line(unused-return)
                (bool finalized,) = registry.settlementOf(id, expiry);
                if (!finalized && (pending == 0 || expiry < pending)) pending = expiry;
            }
        }
    }
}
// forge-lint: disable-end(calls-loop)
