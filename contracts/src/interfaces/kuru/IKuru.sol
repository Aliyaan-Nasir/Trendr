// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

/// @notice The parts of Kuru v1 (Router, OrderBook, KuruAMMVault) Trendr uses. Signatures match
///         the deployed Monad Mainnet and Testnet implementations.
interface IKuruRouter {
    /// @param _type 0 = NO_NATIVE, 1 = NATIVE_IN_BASE, 2 = NATIVE_IN_QUOTE.
    function deployProxy(
        uint8 _type,
        address _baseAssetAddress,
        address _quoteAssetAddress,
        uint96 _sizePrecision,
        uint32 _pricePrecision,
        uint32 _tickSize,
        uint96 _minSize,
        uint96 _maxSize,
        uint256 _takerFeeBps,
        uint256 _makerFeeBps,
        uint96 _kuruAmmSpread
    ) external returns (address proxy);

    /// @notice Address `deployProxy` would deploy to, with `oldImplementation` zero and `old` false.
    function computeAddress(
        address _baseAssetAddress,
        address _quoteAssetAddress,
        uint96 _sizePrecision,
        uint32 _pricePrecision,
        uint32 _tickSize,
        uint96 _minSize,
        uint96 _maxSize,
        uint256 _takerFeeBps,
        uint256 _makerFeeBps,
        uint96 _kuruAmmSpread,
        address oldImplementation,
        bool old
    ) external view returns (address proxy);

    /// @notice Swaps `amount` of `debitToken` (raw units) through `markets` in order, paying the
    ///         output to the caller. Every market must be a router market.
    function anyToAnySwap(
        address[] calldata markets,
        bool[] calldata isBuy,
        bool[] calldata nativeSend,
        address debitToken,
        address creditToken,
        uint256 amount,
        uint256 minAmountOut
    ) external payable returns (uint256 amountOut);

    /// @notice Parameters of a market deployed by this router; zero for anything else.
    function verifiedMarket(address market)
        external
        view
        returns (
            uint32 pricePrecision,
            uint96 sizePrecision,
            address baseAssetAddress,
            uint256 baseAssetDecimals,
            address quoteAssetAddress,
            uint256 quoteAssetDecimals,
            uint32 tickSize,
            uint96 minSize,
            uint96 maxSize,
            uint256 takerFeeBps,
            uint256 makerFeeBps
        );
}

interface IKuruOrderBook {
    function getVaultParams()
        external
        view
        returns (
            address vault,
            uint256 vaultBestBid,
            uint96 bidPartiallyFilledSize,
            uint256 vaultBestAsk,
            uint96 askPartiallyFilledSize,
            uint96 vaultBidOrderSize,
            uint96 vaultAskOrderSize,
            uint96 spread
        );

    /// @notice Best bid and ask, 1e18-scaled quote per base, including vault levels.
    function bestBidAsk() external view returns (uint256 bid, uint256 ask);

    /// @param _quoteSize Quote to spend, in pricePrecision units.
    function placeAndExecuteMarketBuy(
        uint96 _quoteSize,
        uint256 _minAmountOut,
        bool _isMargin,
        bool _isFillOrKill
    ) external payable returns (uint256);

    /// @param _size Base to sell, in sizePrecision units.
    function placeAndExecuteMarketSell(
        uint96 _size,
        uint256 _minAmountOut,
        bool _isMargin,
        bool _isFillOrKill
    ) external payable returns (uint256);

    /// @notice Resting limit orders funded from the maker's MarginAccount balance. Prices are in
    ///         pricePrecision units and sizes in sizePrecision units.
    function addBuyOrder(uint32 price, uint96 size, bool postOnly) external;

    function addSellOrder(uint32 price, uint96 size, bool postOnly) external;

    /// @notice Cancels `cancelIds`, then places the given buys and sells, in one transaction.
    function batchUpdate(
        uint32[] calldata buyPrices,
        uint96[] calldata buySizes,
        uint32[] calldata sellPrices,
        uint96[] calldata sellSizes,
        uint40[] calldata cancelIds,
        bool postOnly
    ) external;

    function batchCancelOrders(uint40[] calldata orderIds) external;

    /// @notice Id of the most recently created order.
    function s_orderIdCounter() external view returns (uint40);

    /// @notice The first and last order resting at a price. Orders fill first come first served, so
    ///         an order is filled once the head at its price is past it or the level is empty.
    function s_buyPricePoints(uint256 price) external view returns (uint40 head, uint40 tail);

    function s_sellPricePoints(uint256 price) external view returns (uint40 head, uint40 tail);

    /// @notice An order's record. A filled order keeps its record, and often its size, until its
    ///         owner cancels it; use the price point's head to tell whether it still rests.
    function s_orders(uint40 orderId)
        external
        view
        returns (
            address ownerAddress,
            uint96 size,
            uint40 prev,
            uint40 next,
            uint40 flippedId,
            uint32 price,
            uint32 flippedPrice,
            bool isBuy
        );

    /// @notice Depth as 32-byte words: block number, then (price, size) bid levels best first,
    ///         a zero word, then ask levels best first, in pricePrecision and sizePrecision units.
    function getL2Book(uint32 bidPricePoints, uint32 askPricePoints) external view returns (bytes memory);
}

/// @notice Kuru's shared balance store; resting orders draw on and settle into it.
interface IKuruMarginAccount {
    function deposit(address user, address token, uint256 amount) external payable;

    function withdraw(uint256 amount, address token) external;

    function getBalance(address user, address token) external view returns (uint256);
}

interface IKuruVault {
    function deposit(uint256 baseDeposit, uint256 quoteDeposit, uint256 minQuoteConsumed, address receiver)
        external
        payable
        returns (uint256 shares);

    function totalSupply() external view returns (uint256);

    function balanceOf(address account) external view returns (uint256);
}
