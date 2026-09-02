// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {IPerplExchange} from "../../src/interfaces/perpl/IPerplExchange.sol";

/// @notice Perpl's Exchange as far as session trading reaches it: a settable mark price per
///         perpetual, collateral deposits pulled from the caller, and orders recorded with the mark
///         they executed against.
contract MockPerplExchange {
    struct Executed {
        address account;
        uint256 perpId;
        uint8 orderType;
        uint256 price;
        uint256 mark;
        bool immediateOrCancel;
        bool postOnly;
        uint256 leverageHdths;
    }

    IERC20 public immutable collateral;
    mapping(uint256 perpId => uint256) public markPNS;
    mapping(uint256 perpId => uint256) public markTimestamp;
    mapping(address account => uint256) public deposits;
    Executed[] internal executed;

    constructor(IERC20 collateral_) {
        collateral = collateral_;
    }

    function setMark(uint256 perpId, uint256 mark, uint256 timestamp) external {
        markPNS[perpId] = mark;
        markTimestamp[perpId] = timestamp;
    }

    function getPerpetualInfo(uint256 perpId)
        external
        view
        returns (IPerplExchange.PerpetualInfo memory info)
    {
        info.name = "BTC Perp";
        info.symbol = "BTC";
        info.priceDecimals = 1;
        info.lotDecimals = 5;
        info.refPriceMaxAgeSec = 60;
        info.markPNS = markPNS[perpId];
        info.markTimestamp = markTimestamp[perpId];
        info.oraclePNS = markPNS[perpId];
        info.oracleTimestampSec = markTimestamp[perpId];
        info.status = 4;
    }

    function createAccount(uint256 amount) external returns (uint256) {
        _deposit(amount);
        return 1;
    }

    function depositCollateral(uint256 amount) external {
        _deposit(amount);
    }

    function execOrder(IPerplExchange.OrderDesc calldata o) external {
        _record(o);
    }

    function execOrders(IPerplExchange.OrderDesc[] calldata orders, bool) external {
        for (uint256 i; i < orders.length; ++i) {
            _record(orders[i]);
        }
    }

    /// @notice A V2 entry point sessions are not allowed to reach through the guard.
    function execOrderV2(IPerplExchange.OrderDesc calldata o, bytes calldata) external {
        _record(o);
    }

    function executedCount() external view returns (uint256) {
        return executed.length;
    }

    function executedAt(uint256 i) external view returns (Executed memory) {
        return executed[i];
    }

    function _deposit(uint256 amount) internal {
        deposits[msg.sender] += amount;
        require(collateral.transferFrom(msg.sender, address(this), amount), "transfer failed");
    }

    function _record(IPerplExchange.OrderDesc calldata o) internal {
        executed.push(
            Executed({
                account: msg.sender,
                perpId: o.perpId,
                orderType: o.orderType,
                price: o.pricePNS,
                mark: markPNS[o.perpId],
                immediateOrCancel: o.immediateOrCancel,
                postOnly: o.postOnly,
                leverageHdths: o.leverageHdths
            })
        );
    }
}
