// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {IKuruRouter} from "../interfaces/kuru/IKuru.sol";
import {OutcomeMarkets} from "./OutcomeMarkets.sol";

/// @title OutcomeListing
/// @notice The canonical Kuru spot market of every UP and DOWN token against AUSD. Each token gets
///         exactly one market with fixed parameters suited to a price between 0 and 1 AUSD, so the
///         app, keeper and market makers all trade the same book.
///
///         Where the Kuru Router is open (Testnet), `list` deploys the markets. Where only Kuru may
///         deploy (Mainnet), Kuru deploys them with these parameters and anyone records them with
///         `adopt`. Ownerless and non-upgradeable; a token's market can be recorded only once.
contract OutcomeListing {
    /// @notice Prices in units of 0.0001 AUSD.
    uint32 public constant PRICE_PRECISION = 10_000;
    /// @notice Orders rest on 0.001 AUSD price steps (a tenth of a cent of payout).
    uint32 public constant TICK_SIZE = 10;
    /// @notice Sizes in units of 0.01 token.
    uint96 public constant SIZE_PRECISION = 100;
    /// @notice Smallest order: one token.
    uint96 public constant MIN_SIZE = 100;
    /// @notice Largest order: ten million tokens.
    uint96 public constant MAX_SIZE = 1e9;
    uint256 public constant TAKER_FEE_BPS = 10;
    uint256 public constant MAKER_FEE_BPS = 0;
    /// @notice Spread of the market's AMM vault, which Trendr does not seed for outcome tokens.
    uint96 public constant AMM_SPREAD = 100;

    uint8 internal constant NO_NATIVE = 0;

    IKuruRouter public immutable router;
    OutcomeMarkets public immutable outcomes;
    address public immutable quote;
    /// @notice True when the router only lets Kuru deploy markets (Kuru Mainnet).
    bool public immutable routerPermissioned;

    /// @notice The recorded Kuru market of each outcome token.
    mapping(address token => address market) public marketOf;

    event MarketRecorded(bytes32 indexed seriesId, address indexed token, address market, bool deployed);

    error ZeroAddress();
    error UnknownSeries();
    error NotOutcomeToken();
    error SeriesClosed();
    error AlreadyRecorded();
    error NotDeployed();
    error MarketMismatch();

    constructor(IKuruRouter router_, OutcomeMarkets outcomes_, bool routerPermissioned_) {
        if (address(router_) == address(0) || address(outcomes_) == address(0)) revert ZeroAddress();
        router = router_;
        outcomes = outcomes_;
        quote = address(outcomes_.collateral());
        routerPermissioned = routerPermissioned_;
    }

    /// @notice Records, and where the router allows it deploys, the markets of an open series.
    ///         Permissionless and idempotent.
    function list(bytes32 seriesId) external returns (address upMarket, address downMarket) {
        OutcomeMarkets.Series memory s = _series(seriesId);
        if (s.outcome != OutcomeMarkets.Outcome.Open) revert SeriesClosed();
        bool deployUp;
        bool deployDown;
        (upMarket, deployUp) = _record(seriesId, address(s.up));
        (downMarket, deployDown) = _record(seriesId, address(s.down));
        if (deployUp) _deploy(address(s.up), upMarket);
        if (deployDown) _deploy(address(s.down), downMarket);
    }

    /// @notice Records a market Kuru deployed for an outcome token with the canonical parameters,
    ///         for routers where only Kuru may deploy. Permissionless.
    function adopt(address token, address market) external {
        bytes32 seriesId = _seriesOf(token);
        if (marketOf[token] != address(0)) revert AlreadyRecorded();
        // Decimals follow from the tokens, so only the pair and the parameters are compared.
        // forge-lint: disable-start(unused-return)
        (
            uint32 pricePrecision,
            uint96 sizePrecision,
            address base,,
            address marketQuote,,
            uint32 tickSize,
            uint96 minSize,
            uint96 maxSize,
            uint256 takerFeeBps,
            uint256 makerFeeBps
        ) = router.verifiedMarket(market);
        // forge-lint: disable-end(unused-return)
        if (
            base != token || marketQuote != quote || pricePrecision != PRICE_PRECISION
                || sizePrecision != SIZE_PRECISION || tickSize != TICK_SIZE || minSize != MIN_SIZE
                || maxSize != MAX_SIZE || takerFeeBps != TAKER_FEE_BPS || makerFeeBps != MAKER_FEE_BPS
        ) revert MarketMismatch();
        marketOf[token] = market;
        emit MarketRecorded(seriesId, token, market, false);
    }

    /// @notice The markets of a series: recorded ones, else where the router would deploy them now.
    function marketsOf(bytes32 seriesId)
        external
        view
        returns (address upMarket, address downMarket, bool upListed, bool downListed)
    {
        OutcomeMarkets.Series memory s = _series(seriesId);
        (upMarket, upListed) = _lookup(address(s.up));
        (downMarket, downListed) = _lookup(address(s.down));
    }

    /// @notice Where the router deploys the canonical market of `token` with its current
    ///         implementation.
    function predictMarket(address token) public view returns (address) {
        return router.computeAddress(
            token,
            quote,
            SIZE_PRECISION,
            PRICE_PRECISION,
            TICK_SIZE,
            MIN_SIZE,
            MAX_SIZE,
            TAKER_FEE_BPS,
            MAKER_FEE_BPS,
            AMM_SPREAD,
            address(0),
            false
        );
    }

    function _lookup(address token) internal view returns (address market, bool listed) {
        market = marketOf[token];
        if (market != address(0)) return (market, true);
        return (predictMarket(token), false);
    }

    /// @dev Records the canonical market of `token`, saying whether the router still has to deploy it.
    function _record(bytes32 seriesId, address token) internal returns (address market, bool deploy) {
        market = marketOf[token];
        if (market != address(0)) return (market, false);
        market = predictMarket(token);
        // A canonical market someone else deployed through the router is the same market.
        deploy = market.code.length == 0;
        if (deploy && routerPermissioned) revert NotDeployed();
        marketOf[token] = market;
        emit MarketRecorded(seriesId, token, market, deploy);
    }

    function _deploy(address token, address market) internal {
        address created = router.deployProxy(
            NO_NATIVE,
            token,
            quote,
            SIZE_PRECISION,
            PRICE_PRECISION,
            TICK_SIZE,
            MIN_SIZE,
            MAX_SIZE,
            TAKER_FEE_BPS,
            MAKER_FEE_BPS,
            AMM_SPREAD
        );
        if (created != market) revert MarketMismatch();
    }

    function _series(bytes32 seriesId) internal view returns (OutcomeMarkets.Series memory s) {
        s = outcomes.seriesOf(seriesId);
        if (address(s.up) == address(0)) revert UnknownSeries();
    }

    /// @dev The series an outcome token belongs to, checked against OutcomeMarkets so a contract
    ///      merely claiming a series id is rejected.
    function _seriesOf(address token) internal view returns (bytes32 seriesId) {
        (bool ok, bytes memory ret) = token.staticcall(abi.encodeWithSignature("seriesId()"));
        if (!ok || ret.length != 32) revert NotOutcomeToken();
        seriesId = abi.decode(ret, (bytes32));
        OutcomeMarkets.Series memory s = outcomes.seriesOf(seriesId);
        if (token == address(0) || (address(s.up) != token && address(s.down) != token)) {
            revert NotOutcomeToken();
        }
    }
}
