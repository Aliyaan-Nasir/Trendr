// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {PasskeyAccount} from "../../src/account/PasskeyAccount.sol";
import {PerplOrderGuard} from "../../src/account/guards/PerplOrderGuard.sol";
import {ITrendRegistry} from "../../src/interfaces/ITrendRegistry.sol";
import {IPerplExchange} from "../../src/interfaces/perpl/IPerplExchange.sol";
import {OutcomeMarkets} from "../../src/outcome/OutcomeMarkets.sol";
import {MockPerplExchange} from "../mocks/MockPerplExchange.sol";
import {WebAuthnSigner} from "../utils/WebAuthnSigner.sol";
import {InvariantBase} from "./InvariantBase.sol";
import {SessionHandler} from "./handlers/SessionHandler.sol";

/// @notice Passkey accounts: a session key never pays out more than the daily limit (gross, call by
///         call, whatever comes back in), never routes value away from the account, never leaves an
///         allowance, never changes its own permissions, and never gets a Perpl order executed that
///         could rest on the book, is priced outside the band around the mark, or opens above the
///         leverage cap.
contract SessionInvariants is InvariantBase {
    uint256 internal constant EOA_PK = 0xE0A;
    uint256 internal constant PASSKEY_PK = 0x9A55;
    uint256 internal constant SESSION_PK = 0x5E5;

    SessionHandler internal handler;
    PasskeyAccount internal account;
    address internal session;

    function setUp() public override {
        super.setUp();
        createTrend("session-topic", ITrendRegistry.AssetClass.Topic, 40 * POINT);
        PasskeyAccount impl = new PasskeyAccount(IERC20(address(ausd)));
        address eoa = vm.addr(EOA_PK);
        vm.signAndAttachDelegation(address(impl), EOA_PK);
        (bool ok,) = eoa.call("");
        assertTrue(ok);
        account = PasskeyAccount(payable(eoa));
        session = vm.addr(SESSION_PK);
        ausd.mint(eoa, 2000 * UNIT);

        MockPerplExchange exchange = new MockPerplExchange(ausd);
        exchange.setMark(16, 830_377, block.timestamp);
        PerplOrderGuard guard = new PerplOrderGuard(IPerplExchange(address(exchange)), 200, 120, 1000);
        handler = new SessionHandler(
            registry, account, outcomes, ausd, exchange, guard, "session-topic", uint128(100 * UNIT)
        );
        (bytes32 x, bytes32 y) = WebAuthnSigner.publicKey(PASSKEY_PK);
        PasskeyAccount.SessionConfig memory cfg = handler.sessionConfig(session, uint128(100 * UNIT));
        uint256 deadline = block.timestamp + 1 hours;
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(EOA_PK, account.initializeDigest(x, y, cfg, deadline));
        account.initialize(x, y, cfg, deadline, abi.encodePacked(r, s, v));

        bytes4[] memory selectors = new bytes4[](11);
        selectors[0] = SessionHandler.trade.selector;
        selectors[1] = SessionHandler.trade.selector;
        selectors[2] = SessionHandler.trade.selector;
        selectors[3] = SessionHandler.trade.selector;
        selectors[4] = SessionHandler.trade.selector; // weighted: trading is the attack surface
        selectors[5] = SessionHandler.ownerSetsLimit.selector;
        selectors[6] = SessionHandler.ownerRevokes.selector;
        selectors[7] = SessionHandler.revokedSessionTries.selector;
        selectors[8] = SessionHandler.moveMark.selector;
        selectors[9] = SessionHandler.advance.selector;
        selectors[10] = SessionHandler.topUp.selector;
        targetSelector(FuzzSelector({addr: address(handler), selectors: selectors}));
        targetContract(address(handler));
    }

    function invariant_sessionNeverExceedsDailyLimit() public view {
        for (uint256 i; i < handler.dayCount(); ++i) {
            uint256 day = handler.tradeDays(i);
            assertLe(handler.spentOnDay(day), handler.maxLimitOnDay(day), "daily limit exceeded");
        }
    }

    /// @notice The account charges exactly the gross outflow the handler counted call by call.
    function invariant_spendIsGross() public view {
        PasskeyAccount.Session memory s = account.sessionOf(session);
        uint256 today = block.timestamp / 1 days;
        if (s.day == today) {
            assertEq(s.spentToday, handler.spentOnDay(today), "spent today is not the gross outflow");
        }
    }

    /// @notice Every Perpl order a session got executed was immediate, an open or close, and priced
    ///         within the band around the mark it executed against.
    function invariant_perplOrdersStayInTheBand() public view {
        MockPerplExchange exchange = handler.exchange();
        for (uint256 i; i < exchange.executedCount(); ++i) {
            MockPerplExchange.Executed memory o = exchange.executedAt(i);
            assertTrue(o.immediateOrCancel && !o.postOnly, "a resting order executed");
            assertLe(o.orderType, 3, "not an open or close");
            uint256 distance = o.price > o.mark ? o.price - o.mark : o.mark - o.price;
            assertLe(distance * 10_000, o.mark * handler.BAND_BPS(), "order outside the band");
        }
    }

    /// @notice Every opening a session got executed named a leverage from 1 hundredth up to the cap.
    function invariant_perplOpensStayUnderTheLeverageCap() public view {
        MockPerplExchange exchange = handler.exchange();
        for (uint256 i; i < exchange.executedCount(); ++i) {
            MockPerplExchange.Executed memory o = exchange.executedAt(i);
            if (o.orderType > 1) continue;
            assertGt(o.leverageHdths, 0, "an opening without leverage executed");
            assertLe(
                o.leverageHdths, handler.MAX_LEVERAGE_HDTHS(), "an opening above the leverage cap executed"
            );
        }
    }

    function invariant_valueNeverLeavesTheAccount() public view {
        address attacker = handler.ATTACKER();
        assertEq(handler.attacksSucceeded(), 0, "malicious batch executed");
        assertEq(ausd.balanceOf(attacker), 0);
        assertEq(ausd.allowance(address(account), attacker), 0);
        for (uint256 i; i < handler.seriesCount(); ++i) {
            OutcomeMarkets.Series memory s = outcomes.seriesOf(handler.series(i));
            assertEq(s.up.balanceOf(attacker) + s.down.balanceOf(attacker), 0);
        }
    }

    function invariant_noLingeringAllowance() public view {
        assertEq(ausd.allowance(address(account), address(outcomes)), 0);
    }

    function invariant_onlyTheOwnerChangesTheSession() public view {
        PasskeyAccount.Session memory s = account.sessionOf(session);
        assertEq(s.dailyLimit, handler.currentLimit());
        assertEq(s.active, handler.sessionActive());
        (bytes32 x, bytes32 y) = account.owner();
        (bytes32 ex, bytes32 ey) = WebAuthnSigner.publicKey(PASSKEY_PK);
        assertEq(x, ex);
        assertEq(y, ey);
    }

    function invariant_honestTradesNeverFailUnexpectedly() public view {
        assertEq(handler.unexpectedReverts(), 0, vm.toString(handler.lastUnexpectedRevert()));
    }

    function afterInvariant() public {
        string[] memory paths = new string[](12);
        paths[0] = "honest mint";
        paths[1] = "honest redeem";
        paths[2] = "recycle";
        paths[3] = "perpl order";
        paths[4] = "perpl deposit";
        paths[5] = "limit enforced";
        paths[6] = "attack blocked";
        paths[7] = "band enforced";
        paths[8] = "limit changed";
        paths[9] = "revoked";
        paths[10] = "revoked session blocked";
        paths[11] = "leverage enforced";
        _reportCoverage(handler, paths);
    }
}
