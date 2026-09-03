// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Test} from "forge-std/Test.sol";
import {WebAuthn} from "solady/utils/WebAuthn.sol";

import {TrendRegistry} from "../../src/TrendRegistry.sol";
import {PasskeyAccount} from "../../src/account/PasskeyAccount.sol";
import {PerplOrderGuard} from "../../src/account/guards/PerplOrderGuard.sol";
import {ITrendRegistry} from "../../src/interfaces/ITrendRegistry.sol";
import {IPerplExchange} from "../../src/interfaces/perpl/IPerplExchange.sol";
import {OutcomeMarkets} from "../../src/outcome/OutcomeMarkets.sol";
import {PasskeyAccountV1} from "../legacy/PasskeyAccountV1.sol";
import {WebAuthnSigner} from "../utils/WebAuthnSigner.sol";

interface IAusdFaucet {
    function requestFunds(address to) external;
}

interface IPerplAccounts {
    function createAccount(uint256 amountCNS) external returns (uint256);
}

/// @notice The full EIP-7702 account flow on a Monad Testnet fork with Agora's Testnet AUSD:
///         delegate, initialize, trade with a session key, withdraw with the passkey; and the upgrade
///         of an account on the deployed version 1 to version 2, then session trading on Perpl's
///         Testnet Exchange through the order guard. A relayer submits everything, so the account
///         never holds MON. Runs only with MONAD_FORK=true.
contract PasskeyAccountForkTest is Test {
    IERC20 internal constant AUSD = IERC20(0xa9012a055bd4e0eDfF8Ce09f960291C09D5322dC);
    IAusdFaucet internal constant FAUCET = IAusdFaucet(0xd236c18D274E54FAccC3dd9DDA4b27965a73ee6C);
    address internal constant FORWARDER = address(0xF0F0);
    address internal constant WF_OWNER = address(0xA11CE);
    bytes10 internal constant WF_NAME = bytes10("trendr-idx");
    uint256 internal constant UNIT = 1e6;
    uint256 internal constant EOA_PK = 0xE0A7702;
    uint256 internal constant PASSKEY_PK = 0x9A55;
    uint256 internal constant SESSION_PK = 0x5E5;
    /// @dev The PasskeyAccount every Testnet account delegated to before version 2.
    address internal constant V1 = 0xdF6C6019C70fC321211A0483E74E2DDe839fa955;
    address internal constant PERPL = 0x1964C32f0bE608E7D29302AFF5E61268E72080cc;
    uint256 internal constant BTC = 16;

    OutcomeMarkets internal outcomes;
    PasskeyAccount internal impl;
    address internal eoa;
    address internal relayer = makeAddr("relayer");

    function setUp() public {
        if (!vm.envOr("MONAD_FORK", false)) vm.skip(true);
        vm.createSelectFork(vm.rpcUrl("monad_testnet"));

        TrendRegistry registry = new TrendRegistry(
            FORWARDER,
            address(0),
            WF_OWNER,
            WF_NAME,
            TrendRegistry.Params({
                stalenessLimit: 10 minutes,
                maxMoveBps: 5000,
                attentionFloor: 5e6,
                coolingWindow: 1 hours,
                retireWindow: 1 hours,
                staleRetireWindow: 2 hours,
                settlementTolerance: 10 minutes,
                maxReportAge: 10 minutes,
                maxFutureSkew: 1 minutes
            })
        );
        outcomes = new OutcomeMarkets(AUSD, ITrendRegistry(address(registry)), 0);
        TrendRegistry.NewTrend[] memory created = new TrendRegistry.NewTrend[](1);
        created[0] = TrendRegistry.NewTrend({
            identifier: "hantavirus",
            assetClass: 6,
            index: 40e6,
            surfacer: address(0x5EED),
            smartMoneyConfirmed: false
        });
        TrendRegistry.Report memory r = TrendRegistry.Report({
            runId: 1,
            observedAt: uint64(block.timestamp),
            newTrends: created,
            updates: new TrendRegistry.IndexUpdate[](0),
            settlements: new TrendRegistry.SettlementRequest[](0)
        });
        vm.prank(FORWARDER);
        registry.onReport(abi.encodePacked(bytes32(uint256(1)), WF_NAME, WF_OWNER, bytes2(0)), abi.encode(r));

        impl = new PasskeyAccount(AUSD);
        eoa = vm.addr(EOA_PK);
        FAUCET.requestFunds(eoa);
    }

    function test_delegateInitializeTradeWithdraw() public {
        assertEq(eoa.balance, 0, "the account holds no MON");
        bytes32 seriesId = outcomes.openSeries("hantavirus", 1 days);

        // 1. The relayer submits the EIP-7702 authorization signed by the account key.
        vm.signAndAttachDelegation(address(impl), EOA_PK);
        vm.prank(relayer);
        (bool ok,) = eoa.call("");
        assertTrue(ok);
        assertEq(eoa.code, abi.encodePacked(hex"ef0100", address(impl)));
        PasskeyAccount account = PasskeyAccount(payable(eoa));

        // 2. Initialize: the passkey becomes owner and a trading session starts.
        address session = vm.addr(SESSION_PK);
        PasskeyAccount.Permission[] memory perms = new PasskeyAccount.Permission[](2);
        perms[0] = PasskeyAccount.Permission(address(outcomes), OutcomeMarkets.mint.selector, 3, address(0));
        perms[1] = PasskeyAccount.Permission(address(outcomes), bytes4(0), 0, address(0));
        PasskeyAccount.SessionConfig memory cfg = PasskeyAccount.SessionConfig({
            key: session,
            validUntil: uint48(block.timestamp + 7 days),
            dailyLimit: uint128(200 * UNIT),
            permissions: perms
        });
        this.initializeAccount(account, cfg);
        uint256 deadline = block.timestamp + 10 minutes;

        // 3. The session key trades: approve plus mint in one batch.
        PasskeyAccount.Call[] memory calls = new PasskeyAccount.Call[](2);
        calls[0] = PasskeyAccount.Call(
            address(AUSD), 0, abi.encodeCall(IERC20.approve, (address(outcomes), 150 * UNIT))
        );
        calls[1] = PasskeyAccount.Call(
            address(outcomes), 0, abi.encodeCall(OutcomeMarkets.mint, (seriesId, 150 * UNIT, eoa))
        );
        bytes memory signature = _signSession(account, calls, session, deadline);
        vm.prank(relayer);
        account.executeWithSession(calls, session, deadline, signature);
        assertEq(outcomes.seriesOf(seriesId).up.balanceOf(eoa), 150 * UNIT);
        assertEq(account.remainingToday(session), 50 * UNIT);

        // 4. The owner withdraws with a passkey assertion.
        address wallet = makeAddr("wallet");
        uint256 balance = AUSD.balanceOf(eoa);
        calls = new PasskeyAccount.Call[](1);
        calls[0] = PasskeyAccount.Call(address(AUSD), 0, abi.encodeCall(IERC20.transfer, (wallet, balance)));
        WebAuthn.WebAuthnAuth memory auth =
            WebAuthnSigner.sign(PASSKEY_PK, account.ownerExecuteDigest(calls, 0, deadline));
        vm.prank(relayer);
        account.executeAsOwner(calls, deadline, auth);
        assertEq(AUSD.balanceOf(wallet), balance);
        assertEq(AUSD.balanceOf(eoa), 0);
        assertEq(eoa.balance, 0, "still no MON needed");
    }

    /// @dev The relayer's `initialize`, signed by the account key. External, so the optimizer keeps
    ///      its ABI encoding out of the calling test's stack frame.
    function initializeAccount(PasskeyAccount account, PasskeyAccount.SessionConfig memory cfg) external {
        (bytes32 x, bytes32 y) = WebAuthnSigner.publicKey(PASSKEY_PK);
        uint256 deadline = block.timestamp + 10 minutes;
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(EOA_PK, account.initializeDigest(x, y, cfg, deadline));
        vm.prank(relayer);
        account.initialize(x, y, cfg, deadline, abi.encodePacked(r, s, v));
    }

    function test_upgradeDeployedVersionOneThenTradePerpl() public {
        assertGt(V1.code.length, 0, "version 1 is deployed");
        bytes32 seriesId = outcomes.openSeries("hantavirus", 1 days);
        address session = vm.addr(SESSION_PK);
        this.versionOneAccount(seriesId, session);
        (bytes32 ownerX,) = PasskeyAccountV1(payable(eoa)).owner();
        uint256 balance = AUSD.balanceOf(eoa);

        this.upgradeWithPerplSession(session);
        PasskeyAccount account = PasskeyAccount(payable(eoa));
        assertEq(eoa.code, abi.encodePacked(hex"ef0100", address(impl)));
        (bytes32 x, bytes32 y) = account.owner();
        (, bytes32 expectedY) = WebAuthnSigner.publicKey(PASSKEY_PK);
        assertEq(x, ownerX, "same passkey owner");
        assertEq(y, expectedY);
        assertEq(account.sessionOf(session).nonce, 1, "the session nonce carried over");
        assertEq(AUSD.balanceOf(eoa), balance);
        assertEq(outcomes.seriesOf(seriesId).up.balanceOf(eoa), 10 * UNIT);

        this.tradePerpl(account, session);
    }

    /// @dev Re-delegation and `upgrade` in one relayed transaction, with a session that may trade on
    ///      Perpl through the guard.
    function upgradeWithPerplSession(address session) external {
        PerplOrderGuard guard = new PerplOrderGuard(IPerplExchange(PERPL), 200, 2 minutes, 1000);
        PasskeyAccount.SessionConfig[] memory sessions = new PasskeyAccount.SessionConfig[](1);
        sessions[0] = _perplSession(session, address(guard));
        uint256 deadline = block.timestamp + 10 minutes;
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(EOA_PK, _upgradeDigest(sessions, deadline));
        vm.signAndAttachDelegation(address(impl), EOA_PK);
        vm.prank(relayer);
        PasskeyAccount(payable(eoa)).upgrade(sessions, deadline, abi.encodePacked(r, s, v));
    }

    /// @dev A version 1 account on the deployed implementation, as the app made them, after one trade.
    /// @dev External, so the optimizer keeps it out of the test's stack frame.
    function versionOneAccount(bytes32 seriesId, address session) external {
        vm.signAndAttachDelegation(V1, EOA_PK);
        vm.prank(relayer);
        (bool ok,) = eoa.call("");
        assertTrue(ok);
        PasskeyAccountV1 old = PasskeyAccountV1(payable(eoa));
        PasskeyAccountV1.Permission[] memory perms = new PasskeyAccountV1.Permission[](2);
        perms[0] = PasskeyAccountV1.Permission(address(outcomes), OutcomeMarkets.mint.selector, 3);
        perms[1] = PasskeyAccountV1.Permission(address(outcomes), bytes4(0), 0);
        PasskeyAccountV1.SessionConfig memory cfg = PasskeyAccountV1.SessionConfig({
            key: session,
            validUntil: uint48(block.timestamp + 7 days),
            dailyLimit: uint128(200 * UNIT),
            permissions: perms
        });
        (bytes32 x, bytes32 y) = WebAuthnSigner.publicKey(PASSKEY_PK);
        uint256 deadline = block.timestamp + 10 minutes;
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(EOA_PK, old.initializeDigest(x, y, cfg, deadline));
        vm.prank(relayer);
        old.initialize(x, y, cfg, deadline, abi.encodePacked(r, s, v));
        PasskeyAccountV1.Call[] memory calls = new PasskeyAccountV1.Call[](2);
        calls[0] = PasskeyAccountV1.Call(
            address(AUSD), 0, abi.encodeCall(IERC20.approve, (address(outcomes), 10 * UNIT))
        );
        calls[1] = PasskeyAccountV1.Call(
            address(outcomes), 0, abi.encodeCall(OutcomeMarkets.mint, (seriesId, 10 * UNIT, eoa))
        );
        (v, r, s) = vm.sign(SESSION_PK, old.sessionExecuteDigest(calls, session, 0, deadline));
        vm.prank(relayer);
        old.executeWithSession(calls, session, deadline, abi.encodePacked(r, s, v));
    }

    /// @dev Opens the Perpl account and buys one lot of BTC at most 0.5% over the mark, as Autopilot
    ///      does; then a thief's order 5% over the mark, into its own ask, never reaches the Exchange,
    ///      nor does an opening at 20x. A 10x opening and a close do.
    function tradePerpl(PasskeyAccount account, address session) external {
        uint256 mark = IPerplExchange(PERPL).getPerpetualInfo(BTC).markPNS;
        PasskeyAccount.Call[] memory calls = new PasskeyAccount.Call[](3);
        calls[0] = PasskeyAccount.Call(address(AUSD), 0, abi.encodeCall(IERC20.approve, (PERPL, 100 * UNIT)));
        calls[1] = PasskeyAccount.Call(PERPL, 0, abi.encodeCall(IPerplAccounts.createAccount, (100 * UNIT)));
        calls[2] = _orderCall(0, mark * 10_050 / 10_000, 500);
        uint256 deadline = block.timestamp + 10 minutes;
        bytes memory signature = _signSession(account, calls, session, deadline);
        vm.prank(relayer);
        account.executeWithSession(calls, session, deadline, signature);
        assertEq(
            account.sessionOf(session).spentToday, 110 * UNIT, "version 1's spend today plus the deposit"
        );

        uint256 price = mark * 10_500 / 10_000;
        calls = new PasskeyAccount.Call[](1);
        calls[0] = _orderCall(0, price, 500);
        signature = _signSession(account, calls, session, deadline);
        bytes memory reason =
            abi.encodeWithSelector(PerplOrderGuard.PriceOutsideBand.selector, 0, price, mark);
        vm.expectRevert(abi.encodeWithSelector(PasskeyAccount.GuardRejected.selector, 0, reason));
        vm.prank(relayer);
        account.executeWithSession(calls, session, deadline, signature);

        calls[0] = _orderCall(0, mark * 10_050 / 10_000, 2000);
        signature = _signSession(account, calls, session, deadline);
        reason = abi.encodeWithSelector(PerplOrderGuard.LeverageNotAllowed.selector, 0, 2000, 1000);
        vm.expectRevert(abi.encodeWithSelector(PasskeyAccount.GuardRejected.selector, 0, reason));
        vm.prank(relayer);
        account.executeWithSession(calls, session, deadline, signature);

        // At the cap, then a close, which names no leverage.
        calls = new PasskeyAccount.Call[](2);
        calls[0] = _orderCall(0, mark * 10_050 / 10_000, 1000);
        calls[1] = _orderCall(2, mark * 9950 / 10_000, 0);
        signature = _signSession(account, calls, session, deadline);
        vm.prank(relayer);
        account.executeWithSession(calls, session, deadline, signature);
    }

    function _signSession(
        PasskeyAccount account,
        PasskeyAccount.Call[] memory calls,
        address session,
        uint256 deadline
    ) internal view returns (bytes memory) {
        bytes32 digest = account.sessionExecuteDigest(
            calls, session, account.sessionOf(session).nonce, deadline
        );
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(SESSION_PK, digest);
        return abi.encodePacked(r, s, v);
    }

    /// @dev An immediate-or-cancel order for one lot, as packages/perpl's openMarketOrder and
    ///      closeMarketOrder build them.
    function _orderCall(uint8 orderType, uint256 price, uint256 leverageHdths)
        internal
        pure
        returns (PasskeyAccount.Call memory)
    {
        IPerplExchange.OrderDesc memory o;
        o.orderDescId = 1;
        o.perpId = BTC;
        o.orderType = orderType;
        o.pricePNS = price;
        o.lotLNS = 1;
        o.immediateOrCancel = true;
        o.leverageHdths = leverageHdths;
        o.maxNegPnlCollatBPS = 1000;
        return PasskeyAccount.Call(PERPL, 0, abi.encodeCall(IPerplExchange.execOrder, (o)));
    }

    function _perplSession(address key, address guard)
        internal
        view
        returns (PasskeyAccount.SessionConfig memory)
    {
        PasskeyAccount.Permission[] memory perms = new PasskeyAccount.Permission[](5);
        perms[0] = PasskeyAccount.Permission(address(outcomes), OutcomeMarkets.mint.selector, 3, address(0));
        perms[1] = PasskeyAccount.Permission(address(outcomes), bytes4(0), 0, address(0));
        perms[2] = PasskeyAccount.Permission(PERPL, IPerplExchange.execOrder.selector, 0, guard);
        perms[3] = PasskeyAccount.Permission(PERPL, IPerplAccounts.createAccount.selector, 0, address(0));
        perms[4] = PasskeyAccount.Permission(PERPL, bytes4(0), 0, address(0));
        return PasskeyAccount.SessionConfig({
            key: key,
            validUntil: uint48(block.timestamp + 7 days),
            dailyLimit: uint128(200 * UNIT),
            permissions: perms
        });
    }

    function _upgradeDigest(PasskeyAccount.SessionConfig[] memory sessions, uint256 deadline)
        internal
        view
        returns (bytes32)
    {
        bytes32[] memory hashes = new bytes32[](sessions.length);
        for (uint256 i; i < sessions.length; ++i) {
            PasskeyAccount.SessionConfig memory c = sessions[i];
            hashes[i] = keccak256(
                abi.encode(c.key, c.validUntil, c.dailyLimit, keccak256(abi.encode(c.permissions)))
            );
        }
        bytes32 structHash =
            keccak256(abi.encode(impl.UPGRADE_TYPEHASH(), keccak256(abi.encodePacked(hashes)), deadline));
        // The account still runs version 1, whose signing domain version 2 keeps.
        return
            keccak256(
                abi.encodePacked("\x19\x01", PasskeyAccountV1(payable(eoa)).domainSeparator(), structHash)
            );
    }
}
