// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Script, console} from "forge-std/Script.sol";
import {WebAuthn} from "solady/utils/WebAuthn.sol";

import {CurationFees} from "../src/CurationFees.sol";
import {TrendRegistry} from "../src/TrendRegistry.sol";
import {PasskeyAccount} from "../src/account/PasskeyAccount.sol";
import {BondingCurve} from "../src/curve/BondingCurve.sol";
import {KuruGraduationVenue} from "../src/curve/KuruGraduationVenue.sol";
import {ITrendRegistry} from "../src/interfaces/ITrendRegistry.sol";
import {IKuruOrderBook} from "../src/interfaces/kuru/IKuru.sol";
import {OutcomeMarkets} from "../src/outcome/OutcomeMarkets.sol";
import {AttentionPerp} from "../src/perp/AttentionPerp.sol";
import {WebAuthnSigner} from "../test/utils/WebAuthnSigner.sol";

interface IMockKeystoneForwarder {
    function report(address receiver, bytes calldata rawReport, bytes calldata, bytes[] calldata) external;
}

interface IAusdFaucet {
    function requestFunds(address to) external;
}

/// @notice End-to-end scenarios against the live Testnet deployment, run by the deployer, which is
///         also the CRE simulation broadcaster. Each step is its own broadcast and reads ids from
///         chain state, because series ids and Kuru market addresses depend on the block they land in.
///
///         forge script script/Scenarios.s.sol --sig "run(string,string)" <step> <identifier> \
///             --rpc-url monad_testnet --broadcast --slow --non-interactive
///
///         Steps, in order: setup, trade, post, crash, liquidate, then retire once the trend has had
///         no observation for the stale-retire window (two hours on Testnet).
contract Scenarios is Script {
    IAusdFaucet internal constant FAUCET = IAusdFaucet(0xd236c18D274E54FAccC3dd9DDA4b27965a73ee6C);
    uint256 internal constant UNIT = 1e6;
    uint64 internal constant POINT = 1e6;

    struct Deployment {
        IERC20 ausd;
        TrendRegistry registry;
        CurationFees curation;
        OutcomeMarkets outcomes;
        AttentionPerp perp;
        BondingCurve curve;
        address passkeyAccount;
        address forwarder;
    }

    Deployment internal d;
    address internal deployer;
    uint256 internal deployerKey;

    function run(string calldata step, string calldata identifier) external {
        require(block.chainid == 10_143, "Testnet only");
        _load();
        deployerKey = vm.envUint("DEPLOYER_PRIVATE_KEY");
        deployer = vm.addr(deployerKey);
        bytes32 trend = keccak256(bytes(identifier));
        bytes32 s = keccak256(bytes(step));

        vm.startBroadcast(deployerKey);
        if (s == keccak256("setup")) _setup(identifier, trend);
        else if (s == keccak256("trade")) _trade(trend);
        else if (s == keccak256("post")) _post(trend);
        else if (s == keccak256("crash")) _crash(trend);
        else if (s == keccak256("liquidate")) _liquidate(trend);
        else if (s == keccak256("retire")) _retire(trend);
        else revert("unknown step");
        vm.stopBroadcast();
    }

    // ---------------------------------------------------------------------------------------
    // Steps
    // ---------------------------------------------------------------------------------------

    /// @notice A CRE report creates the trend, then an outcome series and a curve open on it.
    function _setup(string calldata identifier, bytes32 trend) internal {
        if (d.ausd.balanceOf(deployer) < 5000 * UNIT) FAUCET.requestFunds(deployer);
        TrendRegistry.NewTrend[] memory created = new TrendRegistry.NewTrend[](1);
        created[0] = TrendRegistry.NewTrend({
            identifier: identifier,
            assetClass: 6,
            index: 40 * POINT,
            surfacer: deployer,
            smartMoneyConfirmed: false
        });
        _report(created, new TrendRegistry.IndexUpdate[](0));
        require(d.registry.statusOf(trend) == ITrendRegistry.Status.Active, "trend not created");
        d.outcomes.openSeries(identifier, 1 days);
        d.curve.createCurve(identifier);
        console.log("setup done for", identifier);
    }

    /// @notice Mints sets, opens three perp positions and fills the curve until it graduates.
    function _trade(bytes32 trend) internal {
        bytes32 seriesId = d.outcomes.latestSeries(trend, 1 days);
        d.ausd.approve(address(d.outcomes), 100 * UNIT);
        d.outcomes.mint(seriesId, 100 * UNIT, deployer);

        d.ausd.approve(address(d.perp), 450 * UNIT);
        uint256 deadline = block.timestamp + 10 minutes;
        d.perp.open(trend, true, 300 * UNIT, 3e18, type(uint64).max, deadline); // liquidated later
        d.perp.open(trend, false, 100 * UNIT, 1e18, 0, deadline); // closed in post
        d.perp.open(trend, false, 50 * UNIT, 1e18, 0, deadline); // settles at retirement

        d.ausd.approve(address(d.curve), type(uint256).max);
        while (d.curve.curveOf(trend).state == BondingCurve.State.Open) {
            BondingCurve.Curve memory c = d.curve.curveOf(trend);
            d.curve.buy(trend, (c.virtualQuote + c.reserve) / 12, 0, deployer, deadline);
        }
        d.ausd.approve(address(d.curve), 0);
        d.curve.graduate(trend);
        console.log("graduated");
    }

    /// @notice Refreshes the index, closes a short, trades on the new Kuru market, runs the
    ///         EIP-7702 passkey flow and claims the surfacer's curation fees.
    function _post(bytes32 trend) internal {
        _push(trend, 40 * POINT);
        uint256 shortId = _findPosition(trend, false, 90 * UNIT, 110 * UNIT);
        uint256 payout = d.perp.close(shortId, type(uint64).max, block.timestamp + 10 minutes);
        console.log("closed short, payout", payout);

        address market = d.curve.curveOf(trend).market;
        IERC20 coin = IERC20(address(d.curve.curveOf(trend).coin));
        KuruGraduationVenue venue = KuruGraduationVenue(address(d.curve.venue()));
        (uint32 pricePrecision, uint96 sizePrecision,,,,,,,,,) = venue.router().verifiedMarket(market);
        d.ausd.approve(market, 10 * UNIT);
        uint256 coinsOut = IKuruOrderBook(market)
            .placeAndExecuteMarketBuy(uint96(10 * uint256(pricePrecision)), 0, false, true);
        coin.approve(market, coinsOut);
        uint256 quoteOut = IKuruOrderBook(market)
            .placeAndExecuteMarketSell(uint96(coinsOut / 2 * sizePrecision / 1e18), 0, false, true);
        require(coinsOut > 0 && quoteOut > 0, "kuru round trip failed");
        console.log("kuru market", market);
        console.log("bought coins / sold for AUSD units", coinsOut, quoteOut);

        _passkeyFlow(d.outcomes.latestSeries(trend, 1 days));

        uint256 claimed = d.curation.claim(deployer);
        console.log("curation claimed", claimed);
    }

    /// @notice A 30% drop: the 3x long falls below maintenance with equity left.
    function _crash(bytes32 trend) internal {
        _push(trend, 28 * POINT);
        uint256 longId = _findPosition(trend, true, 290 * UNIT, 310 * UNIT);
        (int256 equity,,,) = d.perp.positionState(longId);
        console.log("long equity after crash (AUSD units)", uint256(equity));
    }

    /// @notice A keeper liquidates the long and earns the reward.
    function _liquidate(bytes32 trend) internal {
        uint256 longId = _findPosition(trend, true, 290 * UNIT, 310 * UNIT);
        uint256 reward = d.perp.liquidate(longId);
        require(reward > 0, "no keeper reward");
        console.log("liquidated, keeper reward", reward);
    }

    /// @notice The oracle stopped updating the trend: anyone retires it and the last position
    ///         settles at the final index.
    function _retire(bytes32 trend) internal {
        if (d.registry.statusOf(trend) != ITrendRegistry.Status.Retired) d.registry.pokeLifecycle(trend);
        uint256 shortId = _findPosition(trend, false, 45 * UNIT, 55 * UNIT);
        uint256 payout = d.perp.settleRetired(shortId);
        console.log("retired, settled short, payout", payout);
    }

    // ---------------------------------------------------------------------------------------
    // Helpers
    // ---------------------------------------------------------------------------------------

    function _passkeyFlow(bytes32 seriesId) internal {
        uint256 userKey = vm.randomUint(1, 2 ** 200);
        uint256 passkey = vm.randomUint(1, 2 ** 200);
        uint256 sessionKey = vm.randomUint(1, 2 ** 200);
        address user = vm.addr(userKey);
        address session = vm.addr(sessionKey);
        d.ausd.transfer(user, 50 * UNIT);

        vm.signAndAttachDelegation(d.passkeyAccount, userKey);
        (bool ok,) = user.call("");
        require(ok, "delegation call failed");
        PasskeyAccount account = PasskeyAccount(payable(user));

        PasskeyAccount.Permission[] memory perms = new PasskeyAccount.Permission[](2);
        perms[0] = PasskeyAccount.Permission(address(d.outcomes), OutcomeMarkets.mint.selector, 3, address(0));
        perms[1] = PasskeyAccount.Permission(address(d.outcomes), bytes4(0), 0, address(0));
        PasskeyAccount.SessionConfig memory cfg = PasskeyAccount.SessionConfig({
            key: session,
            validUntil: uint48(block.timestamp + 1 days),
            dailyLimit: uint128(40 * UNIT),
            permissions: perms
        });
        (bytes32 x, bytes32 y) = WebAuthnSigner.publicKey(passkey);
        uint256 deadline = block.timestamp + 10 minutes;
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(userKey, account.initializeDigest(x, y, cfg, deadline));
        account.initialize(x, y, cfg, deadline, abi.encodePacked(r, s, v));

        PasskeyAccount.Call[] memory calls = new PasskeyAccount.Call[](2);
        calls[0] = PasskeyAccount.Call(
            address(d.ausd), 0, abi.encodeCall(IERC20.approve, (address(d.outcomes), 25 * UNIT))
        );
        calls[1] = PasskeyAccount.Call(
            address(d.outcomes), 0, abi.encodeCall(OutcomeMarkets.mint, (seriesId, 25 * UNIT, user))
        );
        (v, r, s) = vm.sign(sessionKey, account.sessionExecuteDigest(calls, session, 0, deadline));
        account.executeWithSession(calls, session, deadline, abi.encodePacked(r, s, v));
        require(account.remainingToday(session) == 15 * UNIT, "spend not tracked");

        calls = new PasskeyAccount.Call[](1);
        calls[0] =
            PasskeyAccount.Call(address(d.ausd), 0, abi.encodeCall(IERC20.transfer, (deployer, 25 * UNIT)));
        WebAuthn.WebAuthnAuth memory auth =
            WebAuthnSigner.sign(passkey, account.ownerExecuteDigest(calls, 0, deadline));
        account.executeAsOwner(calls, deadline, auth);
        require(d.outcomes.seriesOf(seriesId).up.balanceOf(user) == 25 * UNIT, "session mint failed");
        require(d.ausd.balanceOf(user) == 0, "owner withdrawal failed");
        console.log("7702 account", user);
    }

    function _push(bytes32 trend, uint64 index) internal {
        TrendRegistry.IndexUpdate[] memory updates = new TrendRegistry.IndexUpdate[](1);
        updates[0] = TrendRegistry.IndexUpdate({id: trend, index: index});
        _report(new TrendRegistry.NewTrend[](0), updates);
    }

    /// @notice Sends a report through the MockKeystoneForwarder exactly as a CRE simulation does.
    function _report(TrendRegistry.NewTrend[] memory created, TrendRegistry.IndexUpdate[] memory updates)
        internal
    {
        TrendRegistry.Report memory r = TrendRegistry.Report({
            runId: d.registry.lastRunId() + 1,
            observedAt: uint64(block.timestamp),
            newTrends: created,
            updates: updates,
            settlements: new TrendRegistry.SettlementRequest[](0)
        });
        // version | execution id | timestamp | don id | don config version | metadata (64) | report
        bytes memory raw = abi.encodePacked(
            bytes1(0x01),
            keccak256(abi.encode(r.runId, block.timestamp)),
            uint32(block.timestamp),
            uint32(1),
            uint32(1),
            bytes32(0),
            bytes10(0),
            address(0),
            bytes2(0),
            abi.encode(r)
        );
        IMockKeystoneForwarder(d.forwarder).report(address(d.registry), raw, "", new bytes[](0));
    }

    /// @notice Finds the deployer's open position on `trend` by side and net margin range.
    function _findPosition(bytes32 trend, bool isLong, uint256 minMargin, uint256 maxMargin)
        internal
        view
        returns (uint256)
    {
        uint256 next = d.perp.nextPositionId();
        for (uint256 id = next - 1; id > 0 && id + 200 > next; --id) {
            AttentionPerp.Position memory p = d.perp.positionOf(id);
            if (
                p.owner == deployer && p.trendId == trend && p.isLong == isLong && p.margin >= minMargin
                    && p.margin <= maxMargin
            ) return id;
        }
        revert("position not found");
    }

    function _load() internal {
        string memory json = vm.readFile(string.concat(vm.projectRoot(), "/deployments/10143.json"));
        d.ausd = IERC20(vm.parseJsonAddress(json, ".ausd"));
        d.registry = TrendRegistry(vm.parseJsonAddress(json, ".trendRegistry"));
        d.curation = CurationFees(vm.parseJsonAddress(json, ".curationFees"));
        d.outcomes = OutcomeMarkets(vm.parseJsonAddress(json, ".outcomeMarkets"));
        d.perp = AttentionPerp(vm.parseJsonAddress(json, ".attentionPerp"));
        d.curve = BondingCurve(vm.parseJsonAddress(json, ".bondingCurve"));
        d.passkeyAccount = vm.parseJsonAddress(json, ".passkeyAccount");
        d.forwarder = vm.parseJsonAddress(json, ".creForwarder");
    }
}
