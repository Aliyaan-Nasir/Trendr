// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

/// @title ITrendRegistry
/// @notice Read interface of the Trendr trend registry, the single source of trends,
///         attention index values and outcome settlement values.
interface ITrendRegistry {
    enum Status {
        None,
        Active,
        Cooling,
        Retired
    }

    enum AssetClass {
        Crypto,
        Equity,
        Commodity,
        FX,
        Person,
        Politics,
        Topic
    }

    struct Trend {
        AssetClass assetClass;
        Status status;
        uint64 createdAt;
        uint64 updatedAt;
        uint64 index;
        uint64 peakIndex;
        uint64 belowFloorSince;
        uint64 statusSince;
        address surfacer;
    }

    struct TrendView {
        string identifier;
        bytes32 id;
        Trend trend;
    }

    /// @notice Index values carry 6 decimals: 1_000_000 is one index point.
    function INDEX_SCALE() external view returns (uint64);

    function trendOf(bytes32 id) external view returns (Trend memory);

    function statusOf(bytes32 id) external view returns (Status);

    function surfacerOf(bytes32 id) external view returns (address);

    /// @notice Latest index value and the observation time it was recorded for.
    function indexOf(bytes32 id) external view returns (uint64 index, uint64 updatedAt);

    /// @notice True when the latest index observation is younger than the staleness limit.
    function isFresh(bytes32 id) external view returns (bool);

    /// @notice Settlement value recorded for a series of `id` expiring at `expiry`.
    function settlementOf(bytes32 id, uint64 expiry) external view returns (bool finalized, uint64 value);

    /// @notice Time the trend was retired, or zero while it is not retired.
    function retiredAt(bytes32 id) external view returns (uint64);
}
