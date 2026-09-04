// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {console} from "forge-std/Script.sol";
import {LibString} from "solady/utils/LibString.sol";
import {WebAuthn} from "solady/utils/WebAuthn.sol";

import {CurationFees} from "../src/CurationFees.sol";
import {TrendRegistry} from "../src/TrendRegistry.sol";
import {PasskeyAccount} from "../src/account/PasskeyAccount.sol";
import {BondingCurve} from "../src/curve/BondingCurve.sol";
import {KuruGraduationVenue} from "../src/curve/KuruGraduationVenue.sol";
import {ITrendRegistry} from "../src/interfaces/ITrendRegistry.sol";
import {IKuruMarginAccount, IKuruOrderBook} from "../src/interfaces/kuru/IKuru.sol";
import {OutcomeListing} from "../src/outcome/OutcomeListing.sol";
import {OutcomeMarkets} from "../src/outcome/OutcomeMarkets.sol";
import {AttentionPerp} from "../src/perp/AttentionPerp.sol";
import {TrendrSpot} from "../src/spot/TrendrSpot.sol";
import {WebAuthnSigner} from "../test/utils/WebAuthnSigner.sol";
import {DeploymentFile} from "./DeploymentFile.sol";

interface IMockKeystoneForwarder {
    function report(address receiver, bytes calldata rawReport, bytes calldata, bytes[] calldata) external;
}

/// @notice Rehearses the Monad Mainnet deployment on a local Anvil fork of Mainnet, one broadcast
///         per step, so every transaction gets a real receipt under Monad gas rules. It refuses to
///         run anywhere but Anvil on chain 143, and signs only with Anvil's public dev accounts.
///
///         Run Deploy.s.sol on the fork first (CRE_MODE=mock, CRE_BROADCASTER = dev account 0),
///         then the steps in order. docs/mainnet.md has the full command sequence, including the
///         Kuru Safe impersonation between `probe` and `listed` and the clock moves before
///         `settle`. Rehearse from a separate worktree: Deploy writes deployments/143.json, which
///         must never reach the main checkout before the real deploy.
///
///         forge script script/MainnetRehearsal.s.sol --sig "run(string)" <step> \
///             --rpc-url http://127.0.0.1:8645 --broadcast --slow --non-interactive
///
///         Steps: create, setup, trade, report (INDEX_POINTS=44), close, passkey, graduate, probe,
///         listed, then after the clock moves report (INDEX_POINTS=50) and settle.
///
///         Reports go out like the CRE does: with an explicit gas limit sized per item. Forge
///         would set an estimated limit, and the forwarder swallows a failed onReport, so an
///         estimate is just enough for the forwarder and starves the registry. Anvil's unlocked
///         dev account 0 sends them with eth_sendTransaction.
contract MainnetRehearsal is DeploymentFile {
    string internal constant DEV_MNEMONIC = "test test test test test test test test test test test junk";
    IKuruMarginAccount internal constant KURU_MARGIN =
        IKuruMarginAccount(0x2A68ba1833cDf93fa9Da1EEbd7F46242aD8E90c5);
    string internal constant TREND = "trendr-rehearsal";
    uint256 internal constant UNIT = 1e6;
    uint64 internal constant POINT = 1e6;
    /// @dev The oracle's report gas sizing (config.mainnet.json `gas`).
    uint256 internal constant REPORT_GAS_BASE = 150_000;
    uint256 internal constant REPORT_GAS_PER_NEW_TREND = 230_000;
    uint256 internal constant REPORT_GAS_PER_UPDATE = 52_000;

    Deployment internal d;
    IERC20 internal ausd;
    TrendRegistry internal registry;
    OutcomeMarkets internal outcomes;
    OutcomeListing internal listing;
    AttentionPerp internal perp;
    BondingCurve internal curve;
    TrendrSpot internal spot;

    uint256 internal deployerKey;
    address internal deployer;
    uint256 internal traderKey;
    address internal trader;

    function run(string calldata step) external {
        _guard();
        d = _load();
        ausd = IERC20(d.ausd);
        registry = TrendRegistry(d.registry);
        outcomes = OutcomeMarkets(d.outcomes);
        listing = OutcomeListing(d.outcomeListing);
        perp = AttentionPerp(d.perp);
        curve = BondingCurve(d.curve);
        spot = TrendrSpot(d.spot);
        deployerKey = vm.deriveKey(DEV_MNEMONIC, 0);
        deployer = vm.addr(deployerKey);
        traderKey = vm.deriveKey(DEV_MNEMONIC, 2);
        trader = vm.addr(traderKey);
        require(registry.trustedOrigin() == deployer, "deploy with CRE_BROADCASTER = Anvil dev account 0");

        bytes32 trend = keccak256(bytes(TREND));
        bytes32 s = keccak256(bytes(step));
        if (s == keccak256("create")) _report(_newTrend(), new TrendRegistry.IndexUpdate[](0));
        else if (s == keccak256("setup")) _setup(trend);
        else if (s == keccak256("trade")) _trade(trend);
        else if (s == keccak256("close")) _close(trend);
        else if (s == keccak256("passkey")) _passkey(trend);
        else if (s == keccak256("graduate")) _graduate(trend);
        else if (s == keccak256("probe")) _probe(trend);
        else if (s == keccak256("listed")) _listed(trend);
        else if (s == keccak256("report")) _push(trend, uint64(vm.envUint("INDEX_POINTS")) * POINT);
        else if (s == keccak256("settle")) _settle(trend);
        else revert("unknown step");
    }

    /// @dev Chain 143 alone is not enough: anvil_nodeInfo exists only on Anvil, so a real Monad
    ///      RPC makes this revert before anything is signed.
    function _guard() internal {
        require(block.chainid == 143, "Monad Mainnet fork only");
        vm.rpc("anvil_nodeInfo", "[]");
    }

    // ---------------------------------------------------------------------------------------
    // Steps
    // ---------------------------------------------------------------------------------------

    /// @notice After the `create` report: the keeper's first actions, a 24 hour and a 7 day
    ///         series and a curve.
    function _setup(bytes32 trend) internal {
        require(registry.statusOf(trend) == ITrendRegistry.Status.Active, "run the create step first");

        vm.startBroadcast(deployerKey);
        outcomes.openSeries(TREND, 1 days);
        outcomes.openSeries(TREND, 7 days);
        curve.createCurve(TREND);
        ausd.transfer(trader, 20_000 * UNIT);
        vm.stopBroadcast();
        console.log("trend created, series and curve open");
    }

    /// @notice Complete sets, a perp round trip and a curve buy and sell.
    function _trade(bytes32 trend) internal {
        bytes32 sid = outcomes.latestSeries(trend, 1 days);
        uint256 deadline = block.timestamp + 10 minutes;

        vm.startBroadcast(traderKey);
        ausd.approve(address(outcomes), 100 * UNIT);
        outcomes.mint(sid, 100 * UNIT, trader);
        outcomes.redeemSets(sid, 40 * UNIT, trader);
        ausd.approve(address(perp), 400 * UNIT);
        perp.open(trend, true, 300 * UNIT, 2e18, type(uint64).max, deadline);
        perp.open(trend, false, 100 * UNIT, 1e18, 0, deadline);
        ausd.approve(address(curve), 100 * UNIT);
        uint256 coins = curve.buy(trend, 100 * UNIT, 0, trader, deadline);
        IERC20(address(curve.curveOf(trend).coin)).approve(address(curve), coins / 2);
        uint256 back = curve.sell(trend, coins / 2, 0, trader, deadline);
        vm.stopBroadcast();
        console.log("curve coins bought / AUSD back for half", coins, back);
    }

    /// @notice After a report moved the index: closes the long.
    function _close(bytes32 trend) internal {
        uint256 longId = _findPosition(trader, trend, true);
        vm.startBroadcast(traderKey);
        uint256 payout = perp.close(longId, 0, block.timestamp + 10 minutes);
        vm.stopBroadcast();
        console.log("closed 2x long, payout", payout);
    }

    /// @notice EIP-7702: a fresh EOA delegates to PasskeyAccount, the relayer (dev account 0)
    ///         initializes it, a session key mints sets, and the passkey withdraws.
    function _passkey(bytes32 trend) internal {
        bytes32 sid = outcomes.latestSeries(trend, 1 days);
        // Not an Anvil dev account: on Monad Mainnet those already carry 7702 delegations.
        uint256 userKey = uint256(keccak256("trendr rehearsal 7702 account"));
        uint256 passkey = uint256(keccak256("rehearsal passkey"));
        uint256 sessionKey = uint256(keccak256("trendr rehearsal session key"));
        address user = vm.addr(userKey);
        require(user.code.length == 0, "the passkey step runs once per fork");

        vm.startBroadcast(deployerKey);
        ausd.transfer(user, 50 * UNIT);
        vm.signAndAttachDelegation(d.passkeyAccount, userKey);
        (bool ok,) = user.call("");
        require(ok, "delegation call failed");
        vm.stopBroadcast();
        PasskeyAccount account = PasskeyAccount(payable(user));

        _initialize(account, userKey, passkey, vm.addr(sessionKey));
        _sessionMint(account, sessionKey, sid);
        _ownerWithdraw(account, passkey);
        require(outcomes.seriesOf(sid).up.balanceOf(user) == 25 * UNIT, "session mint failed");
        require(ausd.balanceOf(user) == 0, "owner withdrawal failed");
        require(user.balance == 0, "the account never needs MON");
        console.log("7702 account", user);
    }

    /// @dev The account key makes the passkey owner and starts a session the relayer submits.
    function _initialize(PasskeyAccount account, uint256 userKey, uint256 passkey, address session) internal {
        PasskeyAccount.Permission[] memory perms = new PasskeyAccount.Permission[](2);
        perms[0] = PasskeyAccount.Permission(address(outcomes), OutcomeMarkets.mint.selector, 3, address(0));
        perms[1] = PasskeyAccount.Permission(address(outcomes), bytes4(0), 0, address(0));
        PasskeyAccount.SessionConfig memory cfg = PasskeyAccount.SessionConfig({
            key: session,
            validUntil: uint48(block.timestamp + 1 days),
            dailyLimit: uint128(40 * UNIT),
            permissions: perms
        });
        (bytes32 x, bytes32 y) = WebAuthnSigner.publicKey(passkey);
        uint256 deadline = block.timestamp + 10 minutes;
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(userKey, account.initializeDigest(x, y, cfg, deadline));
        vm.startBroadcast(deployerKey);
        account.initialize(x, y, cfg, deadline, abi.encodePacked(r, s, v));
        vm.stopBroadcast();
    }

    /// @dev The session key approves and mints in one relayed batch, within its daily limit.
    function _sessionMint(PasskeyAccount account, uint256 sessionKey, bytes32 sid) internal {
        address session = vm.addr(sessionKey);
        PasskeyAccount.Call[] memory calls = new PasskeyAccount.Call[](2);
        calls[0] = PasskeyAccount.Call(
            address(ausd), 0, abi.encodeCall(IERC20.approve, (address(outcomes), 25 * UNIT))
        );
        calls[1] = PasskeyAccount.Call(
            address(outcomes), 0, abi.encodeCall(OutcomeMarkets.mint, (sid, 25 * UNIT, address(account)))
        );
        uint256 deadline = block.timestamp + 10 minutes;
        (uint8 v, bytes32 r, bytes32 s) =
            vm.sign(sessionKey, account.sessionExecuteDigest(calls, session, 0, deadline));
        vm.startBroadcast(deployerKey);
        account.executeWithSession(calls, session, deadline, abi.encodePacked(r, s, v));
        vm.stopBroadcast();
        require(account.remainingToday(session) == 15 * UNIT, "spend not tracked");
    }

    /// @dev The passkey (a WebAuthn assertion over P256, verified by the 0x0100 precompile)
    ///      withdraws the rest.
    function _ownerWithdraw(PasskeyAccount account, uint256 passkey) internal {
        PasskeyAccount.Call[] memory calls = new PasskeyAccount.Call[](1);
        calls[0] =
            PasskeyAccount.Call(address(ausd), 0, abi.encodeCall(IERC20.transfer, (deployer, 25 * UNIT)));
        uint256 deadline = block.timestamp + 10 minutes;
        WebAuthn.WebAuthnAuth memory auth =
            WebAuthnSigner.sign(passkey, account.ownerExecuteDigest(calls, 0, deadline));
        vm.startBroadcast(deployerKey);
        account.executeAsOwner(calls, deadline, auth);
        vm.stopBroadcast();
    }

    /// @notice Fills the curve. On the permissioned Mainnet router graduating it then refuses with
    ///         ListingUnavailable, so the filled curve waits and holders can still sell back.
    function _graduate(bytes32 trend) internal {
        uint256 deadline = block.timestamp + 10 minutes;
        vm.startBroadcast(traderKey);
        ausd.approve(address(curve), type(uint256).max);
        vm.stopBroadcast();
        while (curve.curveOf(trend).state == BondingCurve.State.Open) {
            BondingCurve.Curve memory c = curve.curveOf(trend);
            vm.startBroadcast(traderKey);
            curve.buy(trend, (c.virtualQuote + c.reserve) / 12, 0, trader, deadline);
            vm.stopBroadcast();
        }
        vm.startBroadcast(traderKey);
        ausd.approve(address(curve), 0);
        vm.stopBroadcast();
        // Simulated only: a reverting graduation is never broadcast.
        try curve.graduate(trend) {
            revert("a permissioned router cannot list at graduation");
        } catch (bytes memory err) {
            require(
                bytes4(err) == KuruGraduationVenue.ListingUnavailable.selector, "expected ListingUnavailable"
            );
        }
        require(curve.curveOf(trend).state == BondingCurve.State.Ready, "the filled curve waits");
        console.log("coin", address(curve.curveOf(trend).coin));
        console.log("graduate refuses with ListingUnavailable; the filled curve waits for Kuru");
    }

    /// @notice Read only. What OutcomeListing needs from Kuru on Mainnet: the canonical markets of
    ///         the series' tokens, deployed with the arguments in docs/mainnet.md.
    function _probe(bytes32 trend) internal {
        bytes32 sid = outcomes.latestSeries(trend, 1 days);
        OutcomeMarkets.Series memory s = outcomes.seriesOf(sid);
        try listing.list(sid) {
            console.log("list succeeded: Kuru already deployed both canonical markets");
        } catch (bytes memory err) {
            if (bytes4(err) == OutcomeListing.NotDeployed.selector) {
                console.log("list reverts NotDeployed until Kuru deploys the canonical markets");
            } else {
                console.log("list reverts with selector (SeriesClosed once the series settled)");
                console.logBytes4(bytes4(err));
            }
        }
        console.log("UP token / predicted market", address(s.up), listing.predictMarket(address(s.up)));
        console.log("DOWN token / predicted market", address(s.down), listing.predictMarket(address(s.down)));
    }

    /// @notice After Kuru deployed the canonical markets: records them and trades UP through
    ///         TrendrSpot.
    function _listed(bytes32 trend) internal {
        bytes32 sid = outcomes.latestSeries(trend, 1 days);
        vm.startBroadcast(deployerKey);
        (address upMarket,) = listing.list(sid);
        vm.stopBroadcast();
        _tradeUp(sid, upMarket);
    }

    /// @dev A maker quotes UP from the MarginAccount 5 cents either side of its attention-implied
    ///      value (inside the band TrendrSpot's session entry points keep to); the trader buys and
    ///      sells through TrendrSpot.
    function _tradeUp(bytes32 sid, address upMarket) internal {
        IERC20 up = IERC20(address(outcomes.seriesOf(sid).up));
        (uint256 fair,,) = spot.priceBand(address(up));
        require(fair > 0.06e18 && fair < 0.94e18, "no room to quote around this value");
        // Price units of 0.0001 AUSD on 0.001 ticks.
        uint32 bid = uint32((fair - 0.05e18) / 1e15) * 10;
        uint32 ask = uint32((fair + 0.05e18 + 1e15 - 1) / 1e15) * 10;
        vm.startBroadcast(deployerKey);
        ausd.approve(address(outcomes), 100 * UNIT);
        outcomes.mint(sid, 100 * UNIT, deployer);
        up.approve(address(KURU_MARGIN), 100 * UNIT);
        KURU_MARGIN.deposit(deployer, address(up), 100 * UNIT);
        ausd.approve(address(KURU_MARGIN), 20 * UNIT);
        KURU_MARGIN.deposit(deployer, address(ausd), 20 * UNIT);
        IKuruOrderBook(upMarket).addBuyOrder(bid, 2000, true);
        IKuruOrderBook(upMarket).addSellOrder(ask, 4000, true);
        vm.stopBroadcast();

        // Within 1% of the quotes, less Kuru's 0.1% taker fee on the output.
        vm.startBroadcast(traderKey);
        ausd.approve(address(spot), 11 * UNIT);
        uint256 bought = spot.buy(address(up), 11 * UNIT, 11 * UNIT * 1e4 / ask * 989 / 1000, trader);
        up.approve(address(spot), 10 * UNIT);
        uint256 proceeds = spot.sell(address(up), 10 * UNIT, 10 * UNIT * bid / 1e4 * 989 / 1000, trader);
        vm.stopBroadcast();
        console.log("UP bought for 11 AUSD / AUSD for 10 UP via TrendrSpot", bought, proceeds);
    }

    /// @notice After the 24 hour window: the first observation at or after expiry settles the
    ///         series, winners redeem, the short closes, and fees and curation are collected.
    function _settle(bytes32 trend) internal {
        bytes32 sid = outcomes.latestSeries(trend, 1 days);
        OutcomeMarkets.Series memory s = outcomes.seriesOf(sid);
        require(block.timestamp >= s.expiry, "move the clock past expiry and report first");

        uint256 upHeld = s.up.balanceOf(trader);
        uint256 downHeld = s.down.balanceOf(trader);
        vm.startBroadcast(traderKey);
        OutcomeMarkets.Outcome outcome = outcomes.settle(sid);
        uint256 payout = outcomes.redeemWinnings(sid, upHeld, downHeld, trader);
        vm.stopBroadcast();
        console.log("outcome (1 up, 2 down, 3 void) / winnings", uint8(outcome), payout);

        uint256 shortId = _findPosition(trader, trend, false);
        vm.startBroadcast(traderKey);
        uint256 shortPayout = perp.close(shortId, type(uint64).max, block.timestamp + 10 minutes);
        vm.stopBroadcast();
        console.log("closed 1x short, payout", shortPayout);

        vm.startBroadcast(deployerKey);
        uint256 claimed = CurationFees(d.curation).claim(deployer);
        perp.sweepProtocolFees();
        curve.sweepProtocolFees();
        vm.stopBroadcast();
        console.log("curation claimed by the surfacer", claimed);
    }

    // ---------------------------------------------------------------------------------------
    // Helpers
    // ---------------------------------------------------------------------------------------

    function _newTrend() internal view returns (TrendRegistry.NewTrend[] memory created) {
        created = new TrendRegistry.NewTrend[](1);
        created[0] = TrendRegistry.NewTrend({
            identifier: TREND,
            assetClass: 6,
            index: 40 * POINT,
            surfacer: deployer,
            smartMoneyConfirmed: false
        });
    }

    function _push(bytes32 trend, uint64 index) internal {
        TrendRegistry.IndexUpdate[] memory updates = new TrendRegistry.IndexUpdate[](1);
        updates[0] = TrendRegistry.IndexUpdate({id: trend, index: index});
        _report(new TrendRegistry.NewTrend[](0), updates);
    }

    /// @notice Sends a report through the MockKeystoneForwarder as `cre workflow simulate
    ///         --broadcast` does, from the trusted broadcaster, with the oracle's gas sizing
    ///         (`gas` in apps/cre-oracle/attention-index/config.mainnet.json).
    function _report(TrendRegistry.NewTrend[] memory created, TrendRegistry.IndexUpdate[] memory updates)
        internal
    {
        uint64 runId = registry.lastRunId() + 1;
        TrendRegistry.Report memory r = TrendRegistry.Report({
            runId: runId,
            observedAt: uint64(block.timestamp),
            newTrends: created,
            updates: updates,
            settlements: new TrendRegistry.SettlementRequest[](0)
        });
        uint256 gas = REPORT_GAS_BASE + created.length * REPORT_GAS_PER_NEW_TREND + updates.length
            * REPORT_GAS_PER_UPDATE;
        bytes memory data =
            abi.encodeCall(IMockKeystoneForwarder.report, (address(registry), _raw(r), "", new bytes[](0)));
        bytes memory hash = vm.rpc(
            "eth_sendTransaction",
            string.concat(
                '[{"from":"',
                vm.toString(deployer),
                '","to":"',
                vm.toString(d.forwarder),
                '","gas":"',
                LibString.toMinimalHexString(gas),
                '","data":"',
                vm.toString(data),
                '"}]'
            )
        );
        console.log("report tx", vm.toString(hash));
        console.log("gas limit", gas);
        // The forwarder succeeds either way; the registry's run id says whether onReport did.
        // Anvil mines the transaction just after returning its hash, so poll briefly.
        uint64 lastRun;
        for (uint256 i; i < 50 && lastRun < runId; ++i) {
            if (i > 0) vm.sleep(200);
            lastRun = abi.decode(
                vm.rpc(
                    "eth_call",
                    string.concat(
                        '[{"to":"',
                        vm.toString(address(registry)),
                        '","data":"',
                        vm.toString(abi.encodeWithSignature("lastRunId()")),
                        '"},"latest"]'
                    )
                ),
                (uint64)
            );
        }
        require(lastRun == runId, "onReport failed inside the forwarder: raise the gas");
        console.log("run landed", runId);
    }

    /// @dev version | execution id | timestamp | don id | don config version | metadata (64) | report
    function _raw(TrendRegistry.Report memory r) internal view returns (bytes memory) {
        bytes memory header = abi.encodePacked(
            bytes1(0x01),
            keccak256(abi.encode(r.runId, block.timestamp)),
            uint32(block.timestamp),
            uint32(1),
            uint32(1)
        );
        return abi.encodePacked(header, bytes32(0), bytes10(0), address(0), bytes2(0), abi.encode(r));
    }

    function _findPosition(address owner, bytes32 trend, bool isLong) internal view returns (uint256) {
        for (uint256 id = perp.nextPositionId() - 1; id > 0; --id) {
            AttentionPerp.Position memory p = perp.positionOf(id);
            if (p.owner == owner && p.trendId == trend && p.isLong == isLong) return id;
        }
        revert("position not found");
    }
}
