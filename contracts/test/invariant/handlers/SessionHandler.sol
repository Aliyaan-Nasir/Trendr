// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {WebAuthn} from "solady/utils/WebAuthn.sol";

import {TrendRegistry} from "../../../src/TrendRegistry.sol";
import {PasskeyAccount} from "../../../src/account/PasskeyAccount.sol";
import {PerplOrderGuard} from "../../../src/account/guards/PerplOrderGuard.sol";
import {IPerplExchange} from "../../../src/interfaces/perpl/IPerplExchange.sol";
import {OutcomeMarkets} from "../../../src/outcome/OutcomeMarkets.sol";
import {MockPerplExchange} from "../../mocks/MockPerplExchange.sol";
import {MockStable} from "../../mocks/MockStable.sol";
import {WebAuthnSigner} from "../../utils/WebAuthnSigner.sol";
import {OracleDriver} from "./OracleDriver.sol";

/// @notice Drives a delegated PasskeyAccount with honest and malicious session batches (outcome
///         sets, Perpl deposits and orders), owner limit changes, and Perpl mark moves.
contract SessionHandler is OracleDriver {
    uint256 internal constant PASSKEY_PK = 0x9A55;
    uint256 internal constant SESSION_PK = 0x5E5;
    address public constant ATTACKER = address(0xBAD);
    uint256 public constant PERP = 16;
    uint256 public constant BAND_BPS = 200;
    /// @dev The guard's leverage cap, 10x in Perpl's hundredths.
    uint256 public constant MAX_LEVERAGE_HDTHS = 1000;

    PasskeyAccount internal immutable account;
    OutcomeMarkets internal immutable outcomes;
    MockStable internal immutable ausd;
    MockPerplExchange public immutable exchange;
    PerplOrderGuard public immutable guard;
    address internal immutable session;
    string internal identifier;
    bytes32 internal immutable trend;

    bytes32 public currentSeries;
    bytes32[] public series;
    uint128 public currentLimit;
    bool public sessionActive = true;

    uint256[] public tradeDays;
    /// @notice AUSD the account's calls paid out on each day, summed call by call (gross).
    mapping(uint256 day => uint256 amount) public spentOnDay;
    mapping(uint256 day => uint256 amount) public maxLimitOnDay;
    /// @notice Malicious batches that went through; must stay zero.
    uint256 public attacksSucceeded;

    constructor(
        TrendRegistry registry_,
        PasskeyAccount account_,
        OutcomeMarkets outcomes_,
        MockStable ausd_,
        MockPerplExchange exchange_,
        PerplOrderGuard guard_,
        string memory identifier_,
        uint128 limit
    ) OracleDriver(registry_) {
        account = account_;
        outcomes = outcomes_;
        ausd = ausd_;
        exchange = exchange_;
        guard = guard_;
        session = vm.addr(SESSION_PK);
        identifier = identifier_;
        trend = keccak256(bytes(identifier_));
        currentLimit = limit;
        _ensureSeries();
    }

    function seriesCount() external view returns (uint256) {
        return series.length;
    }

    function dayCount() external view returns (uint256) {
        return tradeDays.length;
    }

    /// @notice The session configuration the owner grants in this suite.
    function sessionConfig(address key, uint128 limit)
        public
        view
        returns (PasskeyAccount.SessionConfig memory cfg)
    {
        PasskeyAccount.Permission[] memory perms = new PasskeyAccount.Permission[](6);
        perms[0] = PasskeyAccount.Permission(address(outcomes), OutcomeMarkets.mint.selector, 3, address(0));
        perms[1] =
            PasskeyAccount.Permission(address(outcomes), OutcomeMarkets.redeemSets.selector, 3, address(0));
        perms[2] = PasskeyAccount.Permission(address(outcomes), bytes4(0), 0, address(0));
        perms[3] = PasskeyAccount.Permission(
            address(exchange), IPerplExchange.execOrder.selector, 0, address(guard)
        );
        perms[4] = PasskeyAccount.Permission(
            address(exchange), MockPerplExchange.depositCollateral.selector, 0, address(0)
        );
        perms[5] = PasskeyAccount.Permission(address(exchange), bytes4(0), 0, address(0));
        cfg = PasskeyAccount.SessionConfig({
            key: key,
            validUntil: uint48(vm.getBlockTimestamp() + 365 days),
            dailyLimit: limit,
            permissions: perms
        });
    }

    // --- actions ----------------------------------------------------------------------------

    function trade(uint256 amount, uint256 mode) external {
        if (!sessionActive) return;
        _ensureSeries();
        // The pricing service keeps the mark fresh while people trade.
        exchange.setMark(PERP, exchange.markPNS(PERP), vm.getBlockTimestamp());
        amount = _bound(amount, 1, uint256(currentLimit) + 50 * UNIT);
        mode = mode % 17;
        (PasskeyAccount.Call[] memory calls, bool malicious, uint256 outflow) = _batch(mode, amount);

        uint256 day = vm.getBlockTimestamp() / 1 days;
        uint256 deadline = vm.getBlockTimestamp() + 10 minutes;
        bytes32 digest =
            account.sessionExecuteDigest(calls, session, account.sessionOf(session).nonce, deadline);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(SESSION_PK, digest);
        try account.executeWithSession(calls, session, deadline, abi.encodePacked(r, s, v)) {
            if (malicious) ++attacksSucceeded;
            if (outflow > 0) {
                if (spentOnDay[day] == 0) tradeDays.push(day);
                spentOnDay[day] += outflow;
            }
            if (currentLimit > maxLimitOnDay[day]) maxLimitOnDay[day] = currentLimit;
            // A recycle with nothing to redeem is a plain mint.
            _hit(mode == 10 && calls.length == 2 ? "honest mint" : _honestPath(mode));
        } catch (bytes memory reason) {
            if (malicious) {
                _hit(mode == 16 ? "leverage enforced" : mode >= 13 ? "band enforced" : "attack blocked");
            } else if (bytes4(reason) == PasskeyAccount.SpendLimitExceeded.selector) {
                _hit("limit enforced");
            } else if (bytes4(reason) != PasskeyAccount.CallFailed.selector) {
                _unexpected(reason);
            }
        }
    }

    function ownerSetsLimit(uint128 limit) external {
        limit = uint128(_bound(limit, 0, 500 * UNIT));
        PasskeyAccount.Call[] memory calls = new PasskeyAccount.Call[](1);
        calls[0] = PasskeyAccount.Call(
            address(account), 0, abi.encodeCall(PasskeyAccount.addSession, (sessionConfig(session, limit)))
        );
        _ownerExecute(calls);
        // Raising the limit mid-day lets today's total reach the higher limit.
        uint256 day = vm.getBlockTimestamp() / 1 days;
        if (limit > maxLimitOnDay[day]) maxLimitOnDay[day] = limit;
        currentLimit = limit;
        sessionActive = true;
        _hit("limit changed");
    }

    function ownerRevokes() external {
        PasskeyAccount.Call[] memory calls = new PasskeyAccount.Call[](1);
        calls[0] =
            PasskeyAccount.Call(address(account), 0, abi.encodeCall(PasskeyAccount.revokeSession, (session)));
        _ownerExecute(calls);
        sessionActive = false;
        _hit("revoked");
    }

    function revokedSessionTries(uint256 amount) external {
        if (sessionActive) return;
        _ensureSeries();
        (PasskeyAccount.Call[] memory calls,,) = _batch(0, _bound(amount, 1, 10 * UNIT));
        uint256 deadline = vm.getBlockTimestamp() + 10 minutes;
        bytes32 digest =
            account.sessionExecuteDigest(calls, session, account.sessionOf(session).nonce, deadline);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(SESSION_PK, digest);
        try account.executeWithSession(calls, session, deadline, abi.encodePacked(r, s, v)) {
            ++attacksSucceeded;
        } catch {
            _hit("revoked session blocked");
        }
    }

    /// @notice Perpl's mark moves up to 5% either way.
    function moveMark(uint256 seed) external {
        uint256 mark = exchange.markPNS(PERP);
        exchange.setMark(PERP, _bound(seed, mark * 95 / 100, mark * 105 / 100), vm.getBlockTimestamp());
    }

    function advance(uint256 secs) external {
        _advance(_bound(secs, 1 minutes, 1 days));
    }

    function topUp(uint256 amount) external {
        ausd.mint(address(account), _bound(amount, 1, 1000 * UNIT));
    }

    // --- helpers ----------------------------------------------------------------------------

    function _honestPath(uint256 mode) internal pure returns (string memory) {
        if (mode == 0) return "honest mint";
        if (mode == 1) return "honest redeem";
        if (mode == 10) return "recycle";
        if (mode == 11) return "perpl order";
        return "perpl deposit";
    }

    /// @dev `outflow` is the AUSD the batch's calls pull from the account, call by call.
    function _batch(uint256 mode, uint256 amount)
        internal
        view
        returns (PasskeyAccount.Call[] memory calls, bool malicious, uint256 outflow)
    {
        address me = address(account);
        OutcomeMarkets.Series memory s = outcomes.seriesOf(currentSeries);
        uint256 sets = s.up.balanceOf(me) < s.down.balanceOf(me) ? s.up.balanceOf(me) : s.down.balanceOf(me);
        uint256 mark = exchange.markPNS(PERP);
        if (mode == 0) return (_approveAndMint(amount, me), false, amount);
        if (mode == 1) {
            // Redeem sets the account holds back to itself.
            calls = new PasskeyAccount.Call[](1);
            calls[0] = PasskeyAccount.Call(
                address(outcomes),
                0,
                abi.encodeCall(OutcomeMarkets.redeemSets, (currentSeries, _bound(amount, 1, sets + 1), me))
            );
            return (calls, false, 0);
        }
        if (mode == 10) {
            // Recycle: redeem everything held, then spend again. Only the spending counts.
            PasskeyAccount.Call[] memory mint = _approveAndMint(amount, me);
            if (sets == 0) return (mint, false, amount);
            calls = new PasskeyAccount.Call[](3);
            calls[0] = PasskeyAccount.Call(
                address(outcomes), 0, abi.encodeCall(OutcomeMarkets.redeemSets, (currentSeries, sets, me))
            );
            calls[1] = mint[0];
            calls[2] = mint[1];
            return (calls, false, amount);
        }
        if (mode == 11) {
            // An order the way Trendr's clients price it: within 1% of the mark, opening at 1x to the
            // cap. Closes name any leverage, which the cap ignores.
            uint256 price = _bound(amount, mark * 99 / 100, mark * 101 / 100);
            uint8 orderType = uint8(amount % 4);
            uint256 leverage = orderType < 2
                ? _bound(amount / 4, 100, MAX_LEVERAGE_HDTHS)
                : _bound(amount / 4, 0, MAX_LEVERAGE_HDTHS * 10);
            calls = new PasskeyAccount.Call[](1);
            calls[0] = PasskeyAccount.Call(address(exchange), 0, _order(orderType, price, true, leverage));
            return (calls, false, 0);
        }
        if (mode == 12) {
            calls = new PasskeyAccount.Call[](2);
            calls[0] = PasskeyAccount.Call(
                address(ausd), 0, abi.encodeCall(IERC20.approve, (address(exchange), amount))
            );
            calls[1] = PasskeyAccount.Call(
                address(exchange), 0, abi.encodeCall(MockPerplExchange.depositCollateral, (amount))
            );
            return (calls, false, amount);
        }
        malicious = true;
        if (mode == 2) return (_approveAndMint(amount, ATTACKER), true, 0);
        calls = new PasskeyAccount.Call[](1);
        if (mode == 3) {
            calls[0] = PasskeyAccount.Call(
                address(outcomes), 0, abi.encodeCall(OutcomeMarkets.redeemSets, (currentSeries, 1, ATTACKER))
            );
        } else if (mode == 4) {
            calls[0] =
                PasskeyAccount.Call(address(ausd), 0, abi.encodeCall(IERC20.transfer, (ATTACKER, amount)));
        } else if (mode == 5) {
            calls[0] =
                PasskeyAccount.Call(address(ausd), 0, abi.encodeCall(IERC20.approve, (ATTACKER, amount)));
        } else if (mode == 6) {
            calls = _approveAndMint(amount, me);
            calls[0].data = abi.encodeCall(IERC20.approve, (address(outcomes), amount + 1)); // leaves an allowance
        } else if (mode == 7) {
            calls = _approveAndMint(amount, me);
            calls[1].value = 1;
        } else if (mode == 8) {
            // Escalation: the session tries to grant itself a bigger limit.
            calls[0] = PasskeyAccount.Call(
                me, 0, abi.encodeCall(PasskeyAccount.addSession, (sessionConfig(session, type(uint128).max)))
            );
        } else if (mode == 9) {
            calls[0] = PasskeyAccount.Call(address(s.up), 0, abi.encodeCall(IERC20.transfer, (ATTACKER, 1)));
        } else if (mode == 13) {
            // Self-dealing: an order priced past the band, into the thief's own resting order.
            uint256 offset = mark * BAND_BPS / 10_000 + 1 + _bound(amount, 0, mark / 10);
            uint256 price = amount % 2 == 0 ? mark + offset : (offset < mark ? mark - offset : 0);
            calls[0] = PasskeyAccount.Call(address(exchange), 0, _order(uint8(amount % 4), price, true, 500));
        } else if (mode == 14) {
            // A resting order, which could go stale on the book.
            calls[0] = PasskeyAccount.Call(address(exchange), 0, _order(uint8(amount % 4), mark, false, 500));
        } else if (mode == 15) {
            // A cancel, change or collateral move through the order entry point.
            calls[0] = PasskeyAccount.Call(address(exchange), 0, _order(uint8(4 + amount % 3), mark, true, 0));
        } else {
            // An opening at the mark above the leverage cap, or naming none, to lose the margin faster.
            uint256 leverage = amount % 5 == 0 ? 0 : MAX_LEVERAGE_HDTHS + 1 + _bound(amount, 0, 1e9);
            calls[0] =
                PasskeyAccount.Call(address(exchange), 0, _order(uint8(amount % 2), mark, true, leverage));
        }
    }

    function _order(uint8 orderType, uint256 price, bool immediate, uint256 leverageHdths)
        internal
        pure
        returns (bytes memory)
    {
        IPerplExchange.OrderDesc memory o;
        o.orderDescId = 1;
        o.perpId = PERP;
        o.orderType = orderType;
        o.pricePNS = price;
        o.lotLNS = 1000;
        o.immediateOrCancel = immediate;
        o.leverageHdths = leverageHdths;
        return abi.encodeCall(IPerplExchange.execOrder, (o));
    }

    function _approveAndMint(uint256 amount, address to)
        internal
        view
        returns (PasskeyAccount.Call[] memory calls)
    {
        calls = new PasskeyAccount.Call[](2);
        calls[0] = PasskeyAccount.Call(
            address(ausd), 0, abi.encodeCall(IERC20.approve, (address(outcomes), amount))
        );
        calls[1] = PasskeyAccount.Call(
            address(outcomes), 0, abi.encodeCall(OutcomeMarkets.mint, (currentSeries, amount, to))
        );
    }

    function _ownerExecute(PasskeyAccount.Call[] memory calls) internal {
        uint256 deadline = vm.getBlockTimestamp() + 10 minutes;
        bytes32 digest = account.ownerExecuteDigest(calls, account.ownerNonce(), deadline);
        WebAuthn.WebAuthnAuth memory auth = WebAuthnSigner.sign(PASSKEY_PK, digest);
        try account.executeAsOwner(calls, deadline, auth) {}
        catch (bytes memory reason) {
            _unexpected(reason);
        }
    }

    /// @notice Keeps a fresh trend and an open series to trade.
    function _ensureSeries() internal {
        (, uint64 updatedAt) = registry.indexOf(trend);
        if (vm.getBlockTimestamp() > updatedAt) _push(trend, 40 * POINT);
        if (currentSeries != bytes32(0) && vm.getBlockTimestamp() < outcomes.seriesOf(currentSeries).expiry) {
            return;
        }
        currentSeries = outcomes.openSeries(identifier, 7 days);
        series.push(currentSeries);
    }
}
