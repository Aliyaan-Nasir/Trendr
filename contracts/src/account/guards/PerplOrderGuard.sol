// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {IPerplExchange} from "../../interfaces/perpl/IPerplExchange.sol";
import {IPermissionGuard} from "../IPermissionGuard.sol";

/// @title PerplOrderGuard
/// @notice Lets a PasskeyAccount session trade on Perpl only near Perpl's own price. Every order in
///         an `execOrder` or `execOrders` call must:
///         - open, add to, reduce or close a position (no cancels, order changes or collateral
///           moves, which stay with the passkey);
///         - be immediate-or-cancel and not post-only, so it fills at once or not at all and never
///           rests on the book where a later price move could make it stale;
///         - carry a price within `bandBps` of the perpetual's mark price, which the Exchange holds
///           on chain (Perpl keeps it within 0.25% of its Chainlink spot index), no older than
///           `maxMarkAge` seconds;
///         - if it opens or adds to a position, name a leverage of at most `maxLeverageHdths`
///           (Perpl's per-order leverage, in hundredths: 1000 is 10x). Closes are reduce-only and
///           name none, so they are not capped.
///         A stolen session key can then lose at most the band on each fill by trading the account's
///         Perpl collateral against its holder's own orders, instead of Perpl's own price tolerance,
///         and the cap keeps each round trip's loss a small share of the margin it posts. Higher
///         leverage stays a passkey action.
contract PerplOrderGuard is IPermissionGuard {
    uint256 internal constant BPS = 10_000;
    uint8 internal constant OPEN_SHORT = 1;
    uint8 internal constant CLOSE_SHORT = 3;
    /// @dev 1x in Perpl's leverage units (hundredths).
    uint256 internal constant ONE_X = 100;

    IPerplExchange public immutable exchange;
    /// @notice Widest distance from the mark price an order may carry, in basis points.
    uint256 public immutable bandBps;
    /// @notice Oldest mark price, in seconds, an order may be priced against.
    uint256 public immutable maxMarkAge;
    /// @notice Highest leverage an opening order may name, in hundredths (1000 is 10x).
    uint256 public immutable maxLeverageHdths;

    error ZeroAddress();
    error BadBand();
    error BadMaxAge();
    error BadMaxLeverage();
    error WrongTarget(address target);
    error UnsupportedCall(bytes4 selector);
    error OrderTypeNotAllowed(uint256 order, uint8 orderType);
    error MustBeImmediate(uint256 order);
    error StaleMark(uint256 perpId, uint256 markTimestamp);
    error PriceOutsideBand(uint256 order, uint256 price, uint256 mark);
    error LeverageNotAllowed(uint256 order, uint256 leverageHdths, uint256 maxLeverageHdths);

    constructor(IPerplExchange exchange_, uint256 bandBps_, uint256 maxMarkAge_, uint256 maxLeverageHdths_) {
        if (address(exchange_) == address(0)) revert ZeroAddress();
        if (bandBps_ == 0 || bandBps_ >= BPS) revert BadBand();
        if (maxMarkAge_ == 0) revert BadMaxAge();
        if (maxLeverageHdths_ < ONE_X) revert BadMaxLeverage();
        exchange = exchange_;
        bandBps = bandBps_;
        maxMarkAge = maxMarkAge_;
        maxLeverageHdths = maxLeverageHdths_;
    }

    /// @inheritdoc IPermissionGuard
    function check(address, address target, bytes calldata data) external view returns (bytes4) {
        if (target != address(exchange)) revert WrongTarget(target);
        bytes4 selector = data.length >= 4 ? bytes4(data[:4]) : bytes4(0);
        if (selector == IPerplExchange.execOrder.selector) {
            _checkOrder(0, abi.decode(data[4:], (IPerplExchange.OrderDesc)));
        } else if (selector == IPerplExchange.execOrders.selector) {
            (IPerplExchange.OrderDesc[] memory orders,) =
                abi.decode(data[4:], (IPerplExchange.OrderDesc[], bool));
            for (uint256 i; i < orders.length; ++i) {
                _checkOrder(i, orders[i]);
            }
        } else {
            revert UnsupportedCall(selector);
        }
        return IPermissionGuard.check.selector;
    }

    function _checkOrder(uint256 index, IPerplExchange.OrderDesc memory o) internal view {
        // forge-lint: disable-next-line(require-revert-in-loop)
        if (o.orderType > CLOSE_SHORT) revert OrderTypeNotAllowed(index, o.orderType);
        // forge-lint: disable-next-line(require-revert-in-loop)
        if (!o.immediateOrCancel || o.postOnly) revert MustBeImmediate(index);
        // An opening names its leverage; zero is refused too rather than left to Perpl to read.
        if (o.orderType <= OPEN_SHORT && (o.leverageHdths == 0 || o.leverageHdths > maxLeverageHdths)) {
            // forge-lint: disable-next-line(require-revert-in-loop)
            revert LeverageNotAllowed(index, o.leverageHdths, maxLeverageHdths);
        }
        // forge-lint: disable-next-line(calls-loop)
        IPerplExchange.PerpetualInfo memory info = exchange.getPerpetualInfo(o.perpId);
        uint256 mark = info.markPNS;
        // A mark stamped ahead of this block's clock counts as fresh.
        if (mark == 0 || block.timestamp > info.markTimestamp + maxMarkAge) {
            // forge-lint: disable-next-line(require-revert-in-loop)
            revert StaleMark(o.perpId, info.markTimestamp);
        }
        uint256 distance = o.pricePNS > mark ? o.pricePNS - mark : mark - o.pricePNS;
        // The band is under 100%, so a distance above the mark is outside it (and cannot overflow below).
        if (distance > mark || distance * BPS > mark * bandBps) {
            // forge-lint: disable-next-line(require-revert-in-loop)
            revert PriceOutsideBand(index, o.pricePNS, mark);
        }
    }
}
