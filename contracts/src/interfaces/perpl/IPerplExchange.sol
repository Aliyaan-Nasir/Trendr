// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

/// @notice The parts of Perpl's Exchange Trendr uses. Types and signatures match the deployed Monad
///         Mainnet and Testnet Exchanges (packages/perpl/src/exchange-abi.ts); the order entry points'
///         return values, which Trendr never reads, are left out.
interface IPerplExchange {
    /// @dev orderType: 0 OpenLong, 1 OpenShort, 2 CloseLong, 3 CloseShort, 4 Cancel,
    ///      5 IncreasePositionCollateral, 6 Change. Prices are in the perpetual's price units (PNS).
    struct OrderDesc {
        uint256 orderDescId;
        uint256 perpId;
        uint8 orderType;
        uint256 orderId;
        uint256 pricePNS;
        uint256 lotLNS;
        uint256 expiryBlock;
        bool postOnly;
        bool fillOrKill;
        bool immediateOrCancel;
        uint256 maxMatches;
        uint256 leverageHdths;
        uint256 lastExecutionBlock;
        uint256 amountCNS;
        uint256 maxNegPnlCollatBPS;
    }

    struct PerpetualInfo {
        string name;
        string symbol;
        uint256 priceDecimals;
        uint256 lotDecimals;
        bytes32 linkFeedId;
        uint256 priceTolPer100K;
        uint256 marginTol;
        uint256 marginTolDecimals;
        uint256 refPriceMaxAgeSec;
        uint256 positionBalanceCNS;
        uint256 insuranceBalanceCNS;
        uint256 markPNS;
        uint256 markTimestamp;
        uint256 lastPNS;
        uint256 lastTimestamp;
        uint256 oraclePNS;
        uint256 oracleTimestampSec;
        uint256 longOpenInterestLNS;
        uint256 shortOpenInterestLNS;
        uint256 fundingStartBlock;
        int16 fundingRatePct100k;
        uint256 absFundingClampPctPer100K;
        uint8 status;
        uint256 basePricePNS;
        uint256 maxBidPriceONS;
        uint256 minBidPriceONS;
        uint256 maxAskPriceONS;
        uint256 minAskPriceONS;
        uint256 numOrders;
        bool ignOracle;
    }

    function execOrder(OrderDesc calldata orderDesc) external;

    function execOrders(OrderDesc[] calldata orderDescs, bool revertOnFail) external;

    function getPerpetualInfo(uint256 perpId) external view returns (PerpetualInfo memory perpetualInfo);
}
