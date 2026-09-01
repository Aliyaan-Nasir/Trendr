// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {IERC165} from "@openzeppelin/contracts/utils/introspection/IERC165.sol";
import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";

import {IReceiver} from "./interfaces/IReceiver.sol";
import {ITrendRegistry} from "./interfaces/ITrendRegistry.sol";

/// @title TrendRegistry
/// @notice The single source of trends, attention index values and outcome settlement values.
///         The only writer is the Chainlink CRE forwarder, which delivers one signed report per
///         workflow run. The registry is ownerless and every parameter is fixed at deploy within
///         bounds checked in the constructor.
///
///         Report contents (ABI-encoded `Report`):
///         - new trends, each with a normalized identifier whose keccak256 is the trend id,
///         - index values for existing trends, all observed at `observedAt`,
///         - settlement requests for outcome series that have expired.
///
///         Guards: strictly increasing run ids (replay protection), report age and future-skew
///         limits, strictly increasing per-trend observation times, index bounds, a maximum move
///         per update (moves beyond it are clamped and flagged), and a staleness limit consumers
///         check before taking new risk. Items that fail validation are skipped with an event so
///         one bad item never blocks the rest of the report.
///
///         Lifecycle: a trend whose index stays below the attention floor for `coolingWindow`
///         goes Cooling (no new risk). A Cooling trend that recovers above the floor goes back to
///         Active; one that stays Cooling for `retireWindow` is Retired, which is final. A trend
///         whose index is not updated for `staleRetireWindow` can be retired by anyone. Perps
///         settle at the last index of a retired trend.
contract TrendRegistry is ITrendRegistry, IReceiver {
    using SafeCast for uint256;

    struct Params {
        uint64 stalenessLimit;
        uint32 maxMoveBps;
        uint64 attentionFloor;
        uint64 coolingWindow;
        uint64 retireWindow;
        uint64 staleRetireWindow;
        uint64 settlementTolerance;
        uint64 maxReportAge;
        uint64 maxFutureSkew;
    }

    struct NewTrend {
        string identifier;
        uint8 assetClass;
        uint64 index;
        address surfacer;
        bool smartMoneyConfirmed;
    }

    struct IndexUpdate {
        bytes32 id;
        uint64 index;
    }

    struct SettlementRequest {
        bytes32 id;
        uint64 expiry;
    }

    struct Report {
        uint64 runId;
        uint64 observedAt;
        NewTrend[] newTrends;
        IndexUpdate[] updates;
        SettlementRequest[] settlements;
    }

    enum Rejection {
        None,
        BadIdentifier,
        BadAssetClass,
        IndexOutOfBounds,
        Duplicate,
        NoSmartMoneyConfirmation,
        UnknownTrend,
        Retired,
        NotNewer,
        NotExpired,
        AlreadySettled,
        NoObservation
    }

    uint64 public constant INDEX_SCALE = 1e6;
    /// @notice Smallest accepted index (0.01 points); keeps perp sizes and ratios well defined.
    uint64 public constant MIN_INDEX = 1e4;
    /// @notice Largest accepted index (1,000 points).
    uint64 public constant MAX_INDEX = 1000e6;
    uint256 internal constant BPS = 10_000;
    uint256 internal constant MAX_IDENTIFIER_LENGTH = 64;

    /// @notice CRE forwarder allowed to call `onReport`.
    address public immutable forwarder;
    /// @notice Non-zero only for simulation deployments wired to the MockKeystoneForwarder, which
    ///         performs no signature checks. Reports must then originate from this broadcaster.
    address public immutable trustedOrigin;
    /// @notice Workflow owner and name that production reports must carry in their metadata.
    address public immutable workflowOwner;
    bytes10 public immutable workflowName;

    uint64 public immutable stalenessLimit;
    uint32 public immutable maxMoveBps;
    uint64 public immutable attentionFloor;
    uint64 public immutable coolingWindow;
    uint64 public immutable retireWindow;
    uint64 public immutable staleRetireWindow;
    uint64 public immutable settlementTolerance;
    uint64 public immutable maxReportAge;
    uint64 public immutable maxFutureSkew;

    uint64 public lastRunId;
    uint256 public trendCount;

    mapping(bytes32 id => Trend) internal _trends;
    /// @dev Trend ids in creation order and each id's identifier, so the oracle and indexers can
    ///      enumerate trends and map ids back to identifiers.
    bytes32[] internal _ids;
    mapping(bytes32 id => string) internal _identifierOf;
    /// @dev Packed observations per trend: (timestamp << 64) | index, timestamps strictly increasing.
    mapping(bytes32 id => uint128[]) internal _checkpoints;
    /// @dev Packed settlements: (1 << 64) | value once finalized.
    mapping(bytes32 id => mapping(uint64 expiry => uint128)) internal _settlements;

    event ReportProcessed(
        uint64 indexed runId,
        uint64 observedAt,
        uint256 created,
        uint256 updated,
        uint256 settled,
        uint256 rejected
    );
    event TrendCreated(
        bytes32 indexed id,
        string identifier,
        AssetClass assetClass,
        address indexed surfacer,
        uint64 index,
        uint64 observedAt
    );
    event IndexUpdated(bytes32 indexed id, uint64 index, uint64 peakIndex, uint64 observedAt, bool clamped);
    event IndexClamped(bytes32 indexed id, uint64 proposed, uint64 applied);
    event StatusChanged(bytes32 indexed id, Status from, Status to, uint64 at);
    event SettlementFinalized(bytes32 indexed id, uint64 indexed expiry, uint64 value);
    event ItemRejected(bytes32 indexed id, uint8 kind, Rejection reason);

    error ZeroAddress();
    error InvalidMode();
    error InvalidParams();
    error NotForwarder();
    error UntrustedOrigin();
    error WrongWorkflow();
    error StaleRun();
    error BadObservationTime();
    error UnknownTrend();
    error NothingToPoke();

    /// @param forwarder_ KeystoneForwarder (production) or MockKeystoneForwarder (simulation).
    /// @param trustedOrigin_ Zero for production; the simulation broadcaster for mock deployments.
    /// @param workflowOwner_ Required workflow owner in production; must be zero for mock deployments.
    /// @param workflowName_ Required workflow name in production; must be zero for mock deployments.
    constructor(
        address forwarder_,
        // Zero is valid and selects production mode.
        // forge-lint: disable-next-line(missing-zero-check)
        address trustedOrigin_,
        address workflowOwner_,
        bytes10 workflowName_,
        Params memory p
    ) {
        if (forwarder_ == address(0)) revert ZeroAddress();
        bool production = trustedOrigin_ == address(0);
        if (production && (workflowOwner_ == address(0) || workflowName_ == bytes10(0))) {
            revert InvalidMode();
        }
        if (!production && (workflowOwner_ != address(0) || workflowName_ != bytes10(0))) {
            revert InvalidMode();
        }

        if (
            p.stalenessLimit < 30 seconds || p.stalenessLimit > 1 days || p.maxMoveBps < 100
                || p.maxMoveBps > 9000 || p.attentionFloor < MIN_INDEX || p.attentionFloor > MAX_INDEX / 10
                || p.coolingWindow < 1 minutes || p.coolingWindow > 30 days || p.retireWindow < 1 minutes
                || p.retireWindow > 30 days || p.staleRetireWindow < p.stalenessLimit
                || p.staleRetireWindow > 30 days || p.settlementTolerance < 30 seconds
                || p.settlementTolerance > 1 days || p.maxReportAge < 30 seconds || p.maxReportAge > 1 hours
                || p.maxFutureSkew > 5 minutes
        ) revert InvalidParams();

        forwarder = forwarder_;
        trustedOrigin = trustedOrigin_;
        workflowOwner = workflowOwner_;
        workflowName = workflowName_;
        stalenessLimit = p.stalenessLimit;
        maxMoveBps = p.maxMoveBps;
        attentionFloor = p.attentionFloor;
        coolingWindow = p.coolingWindow;
        retireWindow = p.retireWindow;
        staleRetireWindow = p.staleRetireWindow;
        settlementTolerance = p.settlementTolerance;
        maxReportAge = p.maxReportAge;
        maxFutureSkew = p.maxFutureSkew;
    }

    // ---------------------------------------------------------------------------------------
    // CRE entry point
    // ---------------------------------------------------------------------------------------

    /// @inheritdoc IReceiver
    function onReport(bytes calldata metadata, bytes calldata report) external {
        if (msg.sender != forwarder) revert NotForwarder();
        if (trustedOrigin != address(0)) {
            // The mock forwarder verifies nothing, so pin simulation writes to our broadcaster.
            // slither-disable-start tx-origin
            // solhint-disable-next-line avoid-tx-origin
            // forge-lint: disable-next-line(tx-origin)
            if (tx.origin != trustedOrigin) revert UntrustedOrigin();
            // slither-disable-end tx-origin
        } else {
            (address owner, bytes10 name) = _decodeMetadata(metadata);
            if (owner != workflowOwner || name != workflowName) revert WrongWorkflow();
        }

        Report memory r = abi.decode(report, (Report));
        if (r.runId <= lastRunId) revert StaleRun();
        if (r.observedAt + maxReportAge < block.timestamp || r.observedAt > block.timestamp + maxFutureSkew) {
            revert BadObservationTime();
        }
        lastRunId = r.runId;

        uint256 created;
        uint256 updated;
        uint256 settled;
        uint256 rejected;
        for (uint256 i; i < r.newTrends.length; ++i) {
            if (_createTrend(r.newTrends[i], r.observedAt)) ++created;
            else ++rejected;
        }
        for (uint256 i; i < r.updates.length; ++i) {
            if (_updateIndex(r.updates[i], r.observedAt)) ++updated;
            else ++rejected;
        }
        for (uint256 i; i < r.settlements.length; ++i) {
            if (_finalizeSettlement(r.settlements[i])) ++settled;
            else ++rejected;
        }
        emit ReportProcessed(r.runId, r.observedAt, created, updated, settled, rejected);
    }

    /// @inheritdoc IERC165
    function supportsInterface(bytes4 interfaceId) external pure returns (bool) {
        return interfaceId == type(IReceiver).interfaceId || interfaceId == type(IERC165).interfaceId;
    }

    /// @notice Applies time-based lifecycle transitions without a new observation. Permissionless;
    ///         the keeper calls it so a trend the oracle stopped updating can be retired.
    function pokeLifecycle(bytes32 id) external {
        Trend storage t = _trends[id];
        if (t.status == Status.None) revert UnknownTrend();
        uint64 nowTs = block.timestamp.toUint64();
        if (t.status == Status.Retired) revert NothingToPoke();
        if (_since(t.updatedAt) >= staleRetireWindow) {
            _setStatus(id, t, Status.Retired, nowTs);
        } else if (t.status == Status.Cooling && _since(t.statusSince) >= retireWindow) {
            _setStatus(id, t, Status.Retired, nowTs);
        } else {
            revert NothingToPoke();
        }
    }

    // ---------------------------------------------------------------------------------------
    // Views
    // ---------------------------------------------------------------------------------------

    function trendOf(bytes32 id) external view returns (Trend memory) {
        return _trends[id];
    }

    function statusOf(bytes32 id) external view returns (Status) {
        return _trends[id].status;
    }

    function surfacerOf(bytes32 id) external view returns (address) {
        return _trends[id].surfacer;
    }

    function indexOf(bytes32 id) external view returns (uint64 index, uint64 updatedAt) {
        Trend storage t = _trends[id];
        return (t.index, t.updatedAt);
    }

    function isFresh(bytes32 id) external view returns (bool) {
        Trend storage t = _trends[id];
        return t.status != Status.None && _since(t.updatedAt) <= stalenessLimit;
    }

    function retiredAt(bytes32 id) public view returns (uint64) {
        Trend storage t = _trends[id];
        return t.status == Status.Retired ? t.statusSince : 0;
    }

    /// @notice Settlement value for a series of `id` expiring at `expiry`: the first observation
    ///         at or after `expiry`, if it came within `settlementTolerance`. Observations are
    ///         append-only with strictly increasing times, so once one exists at or after
    ///         `expiry` the value can never change; a CRE settlement request only records it
    ///         explicitly. A trend retired at or before `expiry` settles at its final index, since
    ///         no later observation can ever arrive.
    function settlementOf(bytes32 id, uint64 expiry) external view returns (bool finalized, uint64 value) {
        uint128 packed = _settlements[id][expiry];
        if (packed != 0) {
            (, value) = _unpack(packed);
            return (true, value);
        }
        uint64 retired = retiredAt(id);
        if (retired != 0 && retired <= expiry) return (true, _trends[id].index);
        (bool found, uint64 at, uint64 observed) = _firstCheckpointAtOrAfter(id, expiry);
        if (found && at <= uint256(expiry) + settlementTolerance) return (true, observed);
        return (false, 0);
    }

    /// @notice Up to `count` trends in creation order starting at `start`, with their
    ///         identifiers, for the oracle and indexers.
    function trends(uint256 start, uint256 count) external view returns (TrendView[] memory page) {
        uint256 total = _ids.length;
        if (start >= total) return page;
        uint256 n = total - start < count ? total - start : count;
        page = new TrendView[](n);
        for (uint256 i; i < n; ++i) {
            bytes32 id = _ids[start + i];
            page[i] = TrendView({identifier: _identifierOf[id], id: id, trend: _trends[id]});
        }
    }

    /// @notice Trend id at `i` in creation order.
    function trendIdAt(uint256 i) external view returns (bytes32) {
        return _ids[i];
    }

    /// @notice The normalized identifier of a trend, empty for unknown ids.
    function identifierOf(bytes32 id) external view returns (string memory) {
        return _identifierOf[id];
    }

    function checkpointCount(bytes32 id) external view returns (uint256) {
        return _checkpoints[id].length;
    }

    function checkpointAt(bytes32 id, uint256 i) external view returns (uint64 observedAt, uint64 index) {
        return _unpack(_checkpoints[id][i]);
    }

    /// @notice True when `identifier` uses only lowercase letters, digits and `:._-`, 1 to 64 bytes.
    function isNormalized(string memory identifier) public pure returns (bool) {
        bytes memory b = bytes(identifier);
        if (b.length == 0 || b.length > MAX_IDENTIFIER_LENGTH) return false;
        for (uint256 i; i < b.length; ++i) {
            bytes1 c = b[i];
            bool ok = (c >= 0x61 && c <= 0x7a) || (c >= 0x30 && c <= 0x39) || c == 0x3a || c == 0x2e
                || c == 0x5f || c == 0x2d;
            if (!ok) return false;
        }
        return true;
    }

    // ---------------------------------------------------------------------------------------
    // Report items
    // ---------------------------------------------------------------------------------------

    function _createTrend(NewTrend memory n, uint64 observedAt) internal returns (bool) {
        bytes32 id = keccak256(bytes(n.identifier));
        Rejection reason;
        if (!isNormalized(n.identifier)) {
            reason = Rejection.BadIdentifier;
        } else if (n.assetClass > uint8(type(AssetClass).max)) {
            reason = Rejection.BadAssetClass;
        } else if (n.index < MIN_INDEX || n.index > MAX_INDEX) {
            reason = Rejection.IndexOutOfBounds;
        } else if (_trends[id].status != Status.None) {
            reason = Rejection.Duplicate;
        } else if (AssetClass(n.assetClass) == AssetClass.Crypto && !n.smartMoneyConfirmed) {
            reason = Rejection.NoSmartMoneyConfirmation;
        }
        if (reason != Rejection.None) {
            emit ItemRejected(id, 0, reason);
            return false;
        }

        _trends[id] = Trend({
            assetClass: AssetClass(n.assetClass),
            status: Status.Active,
            createdAt: observedAt,
            updatedAt: observedAt,
            index: n.index,
            peakIndex: n.index,
            belowFloorSince: n.index < attentionFloor ? observedAt : 0,
            statusSince: observedAt,
            surfacer: n.surfacer
        });
        _checkpoints[id].push(_pack(observedAt, n.index));
        _ids.push(id);
        _identifierOf[id] = n.identifier;
        ++trendCount;
        emit TrendCreated(id, n.identifier, AssetClass(n.assetClass), n.surfacer, n.index, observedAt);
        emit StatusChanged(id, Status.None, Status.Active, observedAt);
        return true;
    }

    function _updateIndex(IndexUpdate memory u, uint64 observedAt) internal returns (bool) {
        Trend storage t = _trends[u.id];
        Rejection reason;
        if (t.status == Status.None) reason = Rejection.UnknownTrend;
        else if (t.status == Status.Retired) reason = Rejection.Retired;
        else if (observedAt <= t.updatedAt) reason = Rejection.NotNewer;
        else if (u.index < MIN_INDEX || u.index > MAX_INDEX) reason = Rejection.IndexOutOfBounds;
        if (reason != Rejection.None) {
            emit ItemRejected(u.id, 1, reason);
            return false;
        }

        uint64 applied = _clampMove(t.index, u.index);
        bool clamped = applied != u.index;
        if (clamped) emit IndexClamped(u.id, u.index, applied);

        t.index = applied;
        t.updatedAt = observedAt;
        if (applied > t.peakIndex) t.peakIndex = applied;
        _checkpoints[u.id].push(_pack(observedAt, applied));
        emit IndexUpdated(u.id, applied, t.peakIndex, observedAt, clamped);

        _evaluateLifecycle(u.id, t, observedAt);
        return true;
    }

    function _finalizeSettlement(SettlementRequest memory s) internal returns (bool) {
        Trend storage t = _trends[s.id];
        Rejection reason;
        uint64 value;
        if (t.status == Status.None) {
            reason = Rejection.UnknownTrend;
        } else if (s.expiry > block.timestamp) {
            reason = Rejection.NotExpired;
        } else if (_settlements[s.id][s.expiry] != 0) {
            reason = Rejection.AlreadySettled;
        } else {
            uint64 retired = retiredAt(s.id);
            if (retired != 0 && retired <= s.expiry) {
                value = t.index;
            } else {
                (bool found, uint64 at, uint64 v) = _firstCheckpointAtOrAfter(s.id, s.expiry);
                if (!found || at > s.expiry + settlementTolerance) reason = Rejection.NoObservation;
                else value = v;
            }
        }
        if (reason != Rejection.None) {
            emit ItemRejected(s.id, 2, reason);
            return false;
        }
        _settlements[s.id][s.expiry] = (uint128(1) << 64) | value;
        emit SettlementFinalized(s.id, s.expiry, value);
        return true;
    }

    // ---------------------------------------------------------------------------------------
    // Internals
    // ---------------------------------------------------------------------------------------

    function _evaluateLifecycle(bytes32 id, Trend storage t, uint64 at) internal {
        bool below = t.index < attentionFloor;
        if (!below) t.belowFloorSince = 0;
        else if (t.belowFloorSince == 0) t.belowFloorSince = at;

        if (t.status == Status.Active) {
            if (below && at - t.belowFloorSince >= coolingWindow) _setStatus(id, t, Status.Cooling, at);
        } else if (t.status == Status.Cooling) {
            if (!below) _setStatus(id, t, Status.Active, at);
            else if (at - t.statusSince >= retireWindow) _setStatus(id, t, Status.Retired, at);
        }
    }

    function _setStatus(bytes32 id, Trend storage t, Status to, uint64 at) internal {
        Status from = t.status;
        t.status = to;
        t.statusSince = at;
        emit StatusChanged(id, from, to, at);
    }

    function _clampMove(uint64 last, uint64 proposed) internal view returns (uint64) {
        uint256 maxDelta = uint256(last) * maxMoveBps / BPS;
        if (proposed > last && proposed - last > maxDelta) return (uint256(last) + maxDelta).toUint64();
        if (proposed < last && last - proposed > maxDelta) {
            uint256 floorValue = uint256(last) - maxDelta;
            return floorValue < MIN_INDEX ? MIN_INDEX : floorValue.toUint64();
        }
        return proposed;
    }

    function _firstCheckpointAtOrAfter(bytes32 id, uint64 ts)
        internal
        view
        returns (bool found, uint64 at, uint64 value)
    {
        uint128[] storage cps = _checkpoints[id];
        uint256 lo;
        uint256 hi = cps.length;
        while (lo < hi) {
            uint256 mid = (lo + hi) / 2;
            (uint64 at_,) = _unpack(cps[mid]);
            if (at_ < ts) lo = mid + 1;
            else hi = mid;
        }
        if (lo == cps.length) return (false, 0, 0);
        (at, value) = _unpack(cps[lo]);
        return (true, at, value);
    }

    /// @dev Seconds since `ts`, zero when `ts` is in the future (reports may carry a small skew).
    function _since(uint64 ts) internal view returns (uint256) {
        return block.timestamp > ts ? block.timestamp - ts : 0;
    }

    /// @dev Checkpoints and settlements pack a time in the high 64 bits and a value in the low 64.
    function _pack(uint64 at, uint64 value) internal pure returns (uint128) {
        return (uint128(at) << 64) | value;
    }

    function _unpack(uint128 packed) internal pure returns (uint64 at, uint64 value) {
        // forge-lint: disable-next-line(unsafe-typecast)
        at = uint64(packed >> 64);
        // forge-lint: disable-next-line(unsafe-typecast)
        value = uint64(packed);
    }

    /// @dev Metadata layout: workflowId (32) | workflowName (10) | workflowOwner (20) [| reportId (2)].
    function _decodeMetadata(bytes calldata metadata) internal pure returns (address owner, bytes10 name) {
        if (metadata.length < 62) return (address(0), bytes10(0));
        name = bytes10(metadata[32:42]);
        owner = address(bytes20(metadata[42:62]));
    }
}
