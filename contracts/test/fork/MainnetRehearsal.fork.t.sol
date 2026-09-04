// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Test} from "forge-std/Test.sol";
import {WebAuthn} from "solady/utils/WebAuthn.sol";

import {Deploy} from "../../script/Deploy.s.sol";
import {DeploymentFile} from "../../script/DeploymentFile.sol";
import {CurationFees} from "../../src/CurationFees.sol";
import {TrendRegistry} from "../../src/TrendRegistry.sol";
import {PasskeyAccount} from "../../src/account/PasskeyAccount.sol";
import {PerplOrderGuard} from "../../src/account/guards/PerplOrderGuard.sol";
import {BondingCurve} from "../../src/curve/BondingCurve.sol";
import {KuruGraduationVenue} from "../../src/curve/KuruGraduationVenue.sol";
import {ITrendRegistry} from "../../src/interfaces/ITrendRegistry.sol";
import {
    IKuruMarginAccount,
    IKuruOrderBook,
    IKuruRouter,
    IKuruVault
} from "../../src/interfaces/kuru/IKuru.sol";
import {IPerplExchange} from "../../src/interfaces/perpl/IPerplExchange.sol";
import {OutcomeListing} from "../../src/outcome/OutcomeListing.sol";
import {OutcomeMarkets} from "../../src/outcome/OutcomeMarkets.sol";
import {AttentionPerp} from "../../src/perp/AttentionPerp.sol";
import {TrendrSpot} from "../../src/spot/TrendrSpot.sol";
import {WebAuthnSigner} from "../utils/WebAuthnSigner.sol";

interface IMockKeystoneForwarder {
    function report(address receiver, bytes calldata rawReport, bytes calldata, bytes[] calldata) external;
}

interface IOwnable {
    function owner() external view returns (address);
}

interface IPerplAccounts {
    function createAccount(uint256 amountCNS) external returns (uint256);
}

/// @notice The Monad Mainnet deployment rehearsed on a fork of Mainnet: the real Deploy script with
///         Mainnet settings (CRE in mock mode through the Mainnet MockKeystoneForwarder), then the
///         core flows against the live AUSD, Kuru and P256 precompile. Runs only with
///         MONAD_MAINNET_FORK=true; MAINNET_FORK_BLOCK pins a block, and MONAD_MAINNET_RPC_URL picks the
///         RPC to fork (default: the public one in foundry.toml).
///
///         Kuru Mainnet as found on 2026-10-10, which this test pins down:
///         - Router.deployProxy is owner-only (Kuru's Safe), so OutcomeListing.list waits for Kuru
///           to deploy the canonical markets, then records them.
///         - Every Kuru AMM vault refuses deposits (VaultDisabled), so no graduated coin's market
///           could be seeded; the venue refuses custody and a filled curve waits for Kuru.
///         When an expectation here fails, Kuru changed; update docs/mainnet.md with it.
///
///         Deploy writes deployments/143.json. The test puts back whatever was there (or nothing)
///         right after the deploy, and does everything in one test function so no two tests race
///         on that file.
contract MainnetRehearsalForkTest is Test {
    IERC20 internal constant AUSD = IERC20(0x00000000eFE302BEAA2b3e6e1b18d08D69a9012a);
    IKuruRouter internal constant ROUTER = IKuruRouter(0xd651346d7c789536ebf06dc72aE3C8502cd695CC);
    IKuruMarginAccount internal constant MARGIN =
        IKuruMarginAccount(0x2A68ba1833cDf93fa9Da1EEbd7F46242aD8E90c5);
    /// @dev The AUSD/USDC/USDT0 stable pool, the largest AUSD holder found on Mainnet.
    address internal constant AUSD_HOLDER = 0x942644106B073E30D72c2C5D7529D5C296ea91ab;
    address internal constant MOCK_FORWARDER = 0x9eF6468C5f37b976E57d52054c693269479A784d;
    address internal constant PERPL = 0x34B6552d57a35a1D042CcAe1951BD1C370112a6F;
    /// @dev Perpl Mainnet's BTC perpetual.
    uint256 internal constant PERPL_BTC = 1;
    bytes4 internal constant VAULT_DISABLED = bytes4(keccak256("VaultDisabled()"));
    string internal constant TREND = "trendr-rehearsal";
    uint256 internal constant UNIT = 1e6;
    uint64 internal constant POINT = 1e6;
    uint256 internal constant POOL_SEED = 20_000 * UNIT;
    /// @dev The oracle's report gas sizing (apps/cre-oracle/attention-index/config.mainnet.json).
    uint256 internal constant REPORT_GAS_BASE = 150_000;
    uint256 internal constant REPORT_GAS_PER_NEW_TREND = 230_000;
    uint256 internal constant REPORT_GAS_PER_UPDATE = 52_000;
    uint256 internal constant REPORT_GAS_PER_SETTLEMENT = 60_000;
    /// @dev maxLiveTrends in config.mainnet.json: the most trends one run creates or updates.
    uint256 internal constant MAX_LIVE_TRENDS = 12;

    DeploymentFile.Deployment internal d;
    TrendRegistry internal registry;
    OutcomeMarkets internal outcomes;
    OutcomeListing internal listing;
    AttentionPerp internal perp;
    BondingCurve internal curve;
    KuruGraduationVenue internal venue;
    TrendrSpot internal spot;

    address internal broadcaster = makeAddr("cre broadcaster");
    address internal treasury = makeAddr("treasury");
    address internal keeper = makeAddr("keeper");
    address internal trader = makeAddr("trader");
    address internal maker = makeAddr("maker");
    address internal relayer = makeAddr("relayer");
    bytes32 internal trend = keccak256(bytes(TREND));

    function setUp() public {
        if (!vm.envOr("MONAD_MAINNET_FORK", false)) vm.skip(true);
        uint256 blockNumber = vm.envOr("MAINNET_FORK_BLOCK", uint256(0));
        // A provider endpoint (CI passes one from a secret) instead of the public, rate-limited RPC.
        string memory rpc = vm.envOr("MONAD_MAINNET_RPC_URL", string(""));
        if (bytes(rpc).length == 0) rpc = vm.rpcUrl("monad_mainnet");
        if (blockNumber == 0) vm.createSelectFork(rpc);
        else vm.createSelectFork(rpc, blockNumber);
        assertEq(block.chainid, 143);
    }

    function test_deployAndCoreFlowsOnMainnet() public {
        _externalsLookRight();
        _deploy();
        _createTrend();
        // Before the clock moves: on a fork Perpl's mark stays at the fork block, and the order guard
        // refuses a mark more than two minutes old.
        _passkeyAccount();
        _fullOracleRunsFitTheirGas();
        _completeSetsAndPerps();
        _curveWaitsForKuru();
        _outcomeMarketsWaitForKuru();
        _settleAfterTheWindow();
    }

    // ---------------------------------------------------------------------------------------
    // Steps
    // ---------------------------------------------------------------------------------------

    function _externalsLookRight() internal view {
        assertGt(address(AUSD).code.length, 0, "AUSD");
        assertGt(address(ROUTER).code.length, 0, "Kuru Router");
        assertGt(MOCK_FORWARDER.code.length, 0, "MockKeystoneForwarder");
        assertGt(address(0x76c9cf548b4179F8901cda1f8623568b58215E62).code.length, 0, "KeystoneForwarder");
        assertGt(address(0x34B6552d57a35a1D042CcAe1951BD1C370112a6F).code.length, 0, "Perpl Exchange");
        assertGt(address(0xcA11bde05977b3631167028862bE2a173976CA11).code.length, 0, "Multicall3");
        assertGe(AUSD.balanceOf(AUSD_HOLDER), 100_000 * UNIT, "the AUSD holder still holds enough");
    }

    /// @notice The real Deploy script with Mainnet settings, run by forge's default sender.
    function _deploy() internal {
        vm.prank(AUSD_HOLDER);
        AUSD.transfer(DEFAULT_SENDER, POOL_SEED);
        vm.setEnv("CONFIRM_MAINNET", "yes");
        vm.setEnv("TREASURY", vm.toString(treasury));
        vm.setEnv("CRE_MODE", "mock");
        vm.setEnv("CRE_BROADCASTER", vm.toString(broadcaster));
        vm.setEnv("POOL_SEED", vm.toString(POOL_SEED));

        string memory path = string.concat(vm.projectRoot(), "/deployments/143.json");
        bool existed = vm.exists(path);
        string memory previous = existed ? vm.readFile(path) : "";
        Deploy script = new Deploy();
        d = script.run();
        if (existed) vm.writeFile(path, previous);
        else vm.removeFile(path);

        registry = TrendRegistry(d.registry);
        outcomes = OutcomeMarkets(d.outcomes);
        listing = OutcomeListing(d.outcomeListing);
        perp = AttentionPerp(d.perp);
        curve = BondingCurve(d.curve);
        venue = KuruGraduationVenue(d.venue);
        spot = TrendrSpot(d.spot);

        assertEq(d.forwarder, MOCK_FORWARDER);
        assertEq(registry.trustedOrigin(), broadcaster);
        assertEq(registry.stalenessLimit(), 15 minutes);
        assertEq(perp.pool(), POOL_SEED);
        assertEq(perp.openInterestCap(25 * POINT), 100_000 * UNIT, "the seed unlocks the full OI cap");
        assertTrue(listing.routerPermissioned() && venue.routerPermissioned());
        assertEq(outcomes.windows().length, 2, "no test window on Mainnet");
    }

    function _createTrend() internal {
        TrendRegistry.NewTrend[] memory created = new TrendRegistry.NewTrend[](1);
        created[0] = TrendRegistry.NewTrend({
            identifier: TREND, assetClass: 6, index: 40 * POINT, surfacer: keeper, smartMoneyConfirmed: false
        });
        _report(created, new TrendRegistry.IndexUpdate[](0), _noSettlements());
        assertEq(uint8(registry.statusOf(trend)), uint8(ITrendRegistry.Status.Active));

        vm.startPrank(keeper);
        outcomes.openSeries(TREND, 1 days);
        outcomes.openSeries(TREND, 7 days);
        curve.createCurve(TREND);
        vm.stopPrank();
        _fund(trader, 20_000 * UNIT);
    }

    /// @notice The largest runs the Mainnet oracle sends fit the gas it gives them: a run creating
    ///         the other eleven live trends, then one updating all twelve.
    function _fullOracleRunsFitTheirGas() internal {
        TrendRegistry.NewTrend[] memory created = new TrendRegistry.NewTrend[](MAX_LIVE_TRENDS - 1);
        TrendRegistry.IndexUpdate[] memory updates = new TrendRegistry.IndexUpdate[](MAX_LIVE_TRENDS);
        updates[0] = TrendRegistry.IndexUpdate({id: trend, index: 40 * POINT});
        for (uint256 i; i < created.length; ++i) {
            string memory identifier = string.concat("rehearsal-", vm.toString(i));
            uint64 index = uint64(20 + i) * POINT;
            created[i] = TrendRegistry.NewTrend({
                identifier: identifier,
                assetClass: 6,
                index: index,
                surfacer: keeper,
                smartMoneyConfirmed: false
            });
            updates[i + 1] =
                TrendRegistry.IndexUpdate({id: keccak256(bytes(identifier)), index: index + POINT});
        }
        vm.warp(vm.getBlockTimestamp() + 1 minutes);
        _report(created, new TrendRegistry.IndexUpdate[](0), _noSettlements());
        assertEq(registry.trendCount(), MAX_LIVE_TRENDS);
        vm.warp(vm.getBlockTimestamp() + 1 minutes);
        _report(new TrendRegistry.NewTrend[](0), updates, _noSettlements());
        (uint64 last,) = registry.indexOf(updates[MAX_LIVE_TRENDS - 1].id);
        assertEq(last, updates[MAX_LIVE_TRENDS - 1].index, "every update applied");
    }

    function _completeSetsAndPerps() internal {
        bytes32 sid = outcomes.latestSeries(trend, 1 days);
        uint256 deadline = block.timestamp + 10 minutes;
        vm.startPrank(trader);
        AUSD.approve(address(outcomes), 100 * UNIT);
        outcomes.mint(sid, 100 * UNIT, trader);
        outcomes.redeemSets(sid, 40 * UNIT, trader);
        AUSD.approve(address(perp), 400 * UNIT);
        uint256 longId = perp.open(trend, true, 300 * UNIT, 2e18, type(uint64).max, deadline);
        perp.open(trend, false, 100 * UNIT, 1e18, 0, deadline);
        vm.stopPrank();
        assertEq(outcomes.seriesOf(sid).up.balanceOf(trader), 60 * UNIT);

        // Only the owner tops up a position.
        vm.prank(keeper);
        vm.expectRevert(AttentionPerp.NotOwner.selector);
        perp.addMargin(longId, 1);

        // Observations must be strictly newer than the last one.
        vm.warp(vm.getBlockTimestamp() + 1 minutes);
        _push(44 * POINT);
        vm.prank(trader);
        uint256 payout = perp.close(longId, 0, block.timestamp + 10 minutes);
        // 2x on a 10% rise, less fees.
        assertApproxEqRel(payout, 359 * UNIT, 0.01e18);
    }

    /// @notice EIP-7702 with the P256 precompile at 0x0100: delegate, initialize, a session-key
    ///         mint, a session-key Perpl account and order through the order guard against Perpl's
    ///         live mark, and a passkey withdrawal, all submitted by the relayer.
    function _passkeyAccount() internal {
        bytes32 sid = outcomes.latestSeries(trend, 1 days);
        // Not an Anvil dev key: on Monad Mainnet those already carry 7702 delegations.
        uint256 userKey = uint256(keccak256("trendr rehearsal 7702 account"));
        uint256 passkey = uint256(keccak256("rehearsal passkey"));
        uint256 sessionKey = uint256(keccak256("trendr rehearsal session key"));
        address user = vm.addr(userKey);
        _fund(user, 60 * UNIT);

        vm.signAndAttachDelegation(d.passkeyAccount, userKey);
        vm.prank(relayer);
        (bool ok,) = user.call("");
        assertTrue(ok);
        assertEq(user.code, abi.encodePacked(hex"ef0100", d.passkeyAccount));
        PasskeyAccount account = PasskeyAccount(payable(user));

        _initialize(account, userKey, passkey, vm.addr(sessionKey));
        _sessionMint(account, sessionKey, sid);
        _sessionPerpl(account, sessionKey);
        _ownerWithdraw(account, passkey);
        assertEq(outcomes.seriesOf(sid).up.balanceOf(user), 25 * UNIT);
        assertEq(AUSD.balanceOf(user), 0);
        assertEq(user.balance, 0, "the account never needs MON");
    }

    /// @notice On the permissioned router the venue refuses custody, so a filled curve waits for
    ///         Kuru and holders can still sell back. Kuru Mainnet vaults also refuse deposits, so
    ///         even a market Kuru deploys for the coin could not be seeded.
    function _curveWaitsForKuru() internal {
        vm.startPrank(trader);
        AUSD.approve(address(curve), type(uint256).max);
        uint256 coins = curve.buy(trend, 100 * UNIT, 0, trader, block.timestamp);
        IERC20 coin = IERC20(address(curve.curveOf(trend).coin));
        coin.approve(address(curve), coins / 2);
        curve.sell(trend, coins / 2, 0, trader, block.timestamp);
        while (curve.curveOf(trend).state == BondingCurve.State.Open) {
            BondingCurve.Curve memory c = curve.curveOf(trend);
            curve.buy(trend, (c.virtualQuote + c.reserve) / 12, 0, trader, block.timestamp);
        }
        vm.stopPrank();

        vm.prank(keeper);
        vm.expectRevert(KuruGraduationVenue.ListingUnavailable.selector);
        curve.graduate(trend);
        assertEq(
            uint8(curve.curveOf(trend).state),
            uint8(BondingCurve.State.Ready),
            "graduation waits in the curve"
        );
        assertEq(coin.balanceOf(address(venue)), 0, "the venue holds nothing");
        assertEq(spot.marketOf(address(coin)), address(0), "a waiting coin has no TrendrSpot route");

        // Kuru deploys a market for the pair; its vault still refuses the seed.
        BondingCurve.Curve memory w = curve.curveOf(trend);
        uint256 quoteAmount = w.reserve + w.floorReserve + w.graduationLiquidity;
        uint256 baseAmount = coin.balanceOf(trader);
        KuruGraduationVenue.MarketParams memory p =
            venue.marketParamsFor(address(coin), address(AUSD), baseAmount, quoteAmount);
        vm.prank(IOwnable(address(ROUTER)).owner());
        address coinMarket = ROUTER.deployProxy(
            0,
            address(coin),
            address(AUSD),
            p.sizePrecision,
            p.pricePrecision,
            p.tickSize,
            p.minSize,
            p.maxSize,
            10,
            0,
            100
        );
        // Only the vault address is needed.
        // forge-lint: disable-next-line(unused-return)
        (address vault,,,,,,,) = IKuruOrderBook(coinMarket).getVaultParams();
        vm.startPrank(trader);
        coin.approve(vault, baseAmount);
        AUSD.approve(vault, UNIT);
        vm.expectRevert(VAULT_DISABLED);
        IKuruVault(vault).deposit(baseAmount, UNIT, UNIT, trader);

        // Holders sell back, in steps inside the price impact limit, and below the graduation
        // reserve the curve reopens.
        coin.approve(address(curve), baseAmount);
        for (uint256 i; i < 24 && curve.curveOf(trend).state == BondingCurve.State.Ready; ++i) {
            curve.sell(
                trend, (curve.VIRTUAL_TOKENS() - curve.curveOf(trend).sold) / 24, 0, trader, block.timestamp
            );
        }
        vm.stopPrank();
        assertEq(
            uint8(curve.curveOf(trend).state),
            uint8(BondingCurve.State.Open),
            "selling back reopens the curve"
        );
    }

    /// @notice OutcomeListing.list waits for Kuru, then records the canonical markets, which trade
    ///         through TrendrSpot against a maker's orders.
    function _outcomeMarketsWaitForKuru() internal {
        bytes32 sid = outcomes.latestSeries(trend, 1 days);
        OutcomeMarkets.Series memory s = outcomes.seriesOf(sid);
        vm.expectRevert(OutcomeListing.NotDeployed.selector);
        listing.list(sid);

        vm.prank(address(0xBAD));
        vm.expectRevert();
        ROUTER.deployProxy(0, address(s.up), address(AUSD), 100, 10_000, 10, 100, 1e9, 10, 0, 100);

        vm.startPrank(IOwnable(address(ROUTER)).owner());
        ROUTER.deployProxy(0, address(s.up), address(AUSD), 100, 10_000, 10, 100, 1e9, 10, 0, 100);
        ROUTER.deployProxy(0, address(s.down), address(AUSD), 100, 10_000, 10, 100, 1e9, 10, 0, 100);
        vm.stopPrank();
        (address upMarket, address downMarket) = listing.list(sid);
        assertEq(
            upMarket, listing.predictMarket(address(s.up)), "Kuru's canonical market is the predicted one"
        );
        assertEq(downMarket, listing.predictMarket(address(s.down)));

        // The maker quotes UP 5 cents either side of its attention-implied value, inside the band
        // TrendrSpot's session entry points keep to.
        (uint32 bid, uint32 ask) = _quotesAroundFair(address(s.up));
        _fund(maker, 120 * UNIT);
        vm.startPrank(maker);
        AUSD.approve(address(outcomes), 100 * UNIT);
        outcomes.mint(sid, 100 * UNIT, maker);
        s.up.approve(address(MARGIN), 100 * UNIT);
        MARGIN.deposit(maker, address(s.up), 100 * UNIT);
        AUSD.approve(address(MARGIN), 20 * UNIT);
        MARGIN.deposit(maker, address(AUSD), 20 * UNIT);
        IKuruOrderBook(upMarket).addBuyOrder(bid, 2000, true);
        IKuruOrderBook(upMarket).addSellOrder(ask, 4000, true);
        vm.stopPrank();

        // Price units are 0.0001 AUSD, so a token costs `ask` / 1e4 AUSD; Kuru takes 0.1% of the output.
        uint256 wantBought = 11 * UNIT * 1e4 / ask * 999 / 1000;
        uint256 wantProceeds = 10 * UNIT * bid / 1e4 * 999 / 1000;
        vm.startPrank(trader);
        AUSD.approve(address(spot), 11 * UNIT);
        uint256 bought = spot.buy(address(s.up), 11 * UNIT, wantBought * 99 / 100, trader);
        s.up.approve(address(spot), 10 * UNIT);
        uint256 proceeds = spot.sell(address(s.up), 10 * UNIT, wantProceeds * 99 / 100, trader);
        vm.stopPrank();
        assertApproxEqRel(bought, wantBought, 0.002e18, "UP at the ask less the taker fee");
        assertApproxEqRel(proceeds, wantProceeds, 0.001e18, "UP at the bid less the taker fee");
    }

    /// @dev A bid and an ask (price units, 0.001 ticks) 5 cents either side of `token`'s
    ///      attention-implied value.
    function _quotesAroundFair(address token) internal view returns (uint32 bid, uint32 ask) {
        (uint256 fair,,) = spot.priceBand(token);
        require(fair > 0.06e18 && fair < 0.94e18, "no room to quote around this value");
        bid = uint32((fair - 0.05e18) / 1e15) * 10;
        ask = uint32((fair + 0.05e18 + 1e15 - 1) / 1e15) * 10;
    }

    /// @notice The first observation after expiry settles the series; winners redeem, the short
    ///         closes, and the surfacer claims curation fees.
    function _settleAfterTheWindow() internal {
        bytes32 sid = outcomes.latestSeries(trend, 1 days);
        OutcomeMarkets.Series memory s = outcomes.seriesOf(sid);
        vm.warp(vm.getBlockTimestamp() + 12 hours);
        _push(46 * POINT);
        vm.warp(s.expiry + 1 minutes);
        _push(50 * POINT);
        TrendRegistry.SettlementRequest[] memory settlements = new TrendRegistry.SettlementRequest[](1);
        settlements[0] = TrendRegistry.SettlementRequest({id: trend, expiry: s.expiry});
        _report(new TrendRegistry.NewTrend[](0), new TrendRegistry.IndexUpdate[](0), settlements);
        (bool finalized, uint64 value) = registry.settlementOf(trend, s.expiry);
        assertTrue(finalized && value == 50 * POINT, "settlement recorded");

        uint256 upHeld = s.up.balanceOf(trader);
        vm.startPrank(trader);
        assertEq(uint8(outcomes.settle(sid)), uint8(OutcomeMarkets.Outcome.Up));
        assertEq(outcomes.redeemWinnings(sid, upHeld, s.down.balanceOf(trader), trader), upHeld);
        uint256 shortId = perp.nextPositionId() - 1;
        uint256 payout = perp.close(shortId, type(uint64).max, block.timestamp + 10 minutes);
        vm.stopPrank();
        assertLt(payout, 100 * UNIT, "a 1x short loses on a 25% rise");

        vm.prank(keeper);
        assertGt(CurationFees(d.curation).claim(keeper), 0);
        uint256 before = AUSD.balanceOf(treasury);
        perp.sweepProtocolFees();
        curve.sweepProtocolFees();
        assertGt(AUSD.balanceOf(treasury), before);
    }

    // ---------------------------------------------------------------------------------------
    // Helpers
    // ---------------------------------------------------------------------------------------

    function _fund(address to, uint256 amount) internal {
        vm.prank(AUSD_HOLDER);
        AUSD.transfer(to, amount);
    }

    function _initialize(PasskeyAccount account, uint256 userKey, uint256 passkey, address session) internal {
        assertEq(address(PerplOrderGuard(d.perplOrderGuard).exchange()), PERPL, "the guard watches Perpl");
        assertEq(PerplOrderGuard(d.perplOrderGuard).maxLeverageHdths(), 1000, "sessions open at up to 10x");
        assertEq(d.perplSessionMaxLeverageHdths, 1000, "the deployments file records the cap");
        PasskeyAccount.Permission[] memory perms = new PasskeyAccount.Permission[](5);
        perms[0] = PasskeyAccount.Permission(address(outcomes), OutcomeMarkets.mint.selector, 3, address(0));
        perms[1] = PasskeyAccount.Permission(address(outcomes), bytes4(0), 0, address(0));
        perms[2] = PasskeyAccount.Permission(PERPL, IPerplExchange.execOrder.selector, 0, d.perplOrderGuard);
        perms[3] = PasskeyAccount.Permission(PERPL, IPerplAccounts.createAccount.selector, 0, address(0));
        perms[4] = PasskeyAccount.Permission(PERPL, bytes4(0), 0, address(0));
        PasskeyAccount.SessionConfig memory cfg = PasskeyAccount.SessionConfig({
            key: session,
            validUntil: uint48(block.timestamp + 1 days),
            dailyLimit: uint128(40 * UNIT),
            permissions: perms
        });
        (bytes32 x, bytes32 y) = WebAuthnSigner.publicKey(passkey);
        uint256 deadline = block.timestamp + 10 minutes;
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(userKey, account.initializeDigest(x, y, cfg, deadline));
        vm.prank(relayer);
        account.initialize(x, y, cfg, deadline, abi.encodePacked(r, s, v));
    }

    function _sessionMint(PasskeyAccount account, uint256 sessionKey, bytes32 sid) internal {
        address session = vm.addr(sessionKey);
        PasskeyAccount.Call[] memory calls = new PasskeyAccount.Call[](2);
        calls[0] = PasskeyAccount.Call(
            address(AUSD), 0, abi.encodeCall(IERC20.approve, (address(outcomes), 25 * UNIT))
        );
        calls[1] = PasskeyAccount.Call(
            address(outcomes), 0, abi.encodeCall(OutcomeMarkets.mint, (sid, 25 * UNIT, address(account)))
        );
        uint256 deadline = block.timestamp + 10 minutes;
        (uint8 v, bytes32 r, bytes32 s) =
            vm.sign(sessionKey, account.sessionExecuteDigest(calls, session, 0, deadline));
        vm.prank(relayer);
        account.executeWithSession(calls, session, deadline, abi.encodePacked(r, s, v));
        assertEq(account.remainingToday(session), 15 * UNIT, "spend tracked against the daily limit");
    }

    /// @notice A Perpl account (Mainnet's $10 minimum, which counts against the daily limit) and one
    ///         lot of BTC at most 0.5% over the live mark, as Autopilot sends it; a thief's order 5%
    ///         over the mark, or at 20x, is refused before it reaches the Exchange.
    function _sessionPerpl(PasskeyAccount account, uint256 sessionKey) internal {
        address session = vm.addr(sessionKey);
        uint256 mark = IPerplExchange(PERPL).getPerpetualInfo(PERPL_BTC).markPNS;
        PasskeyAccount.Call[] memory calls = new PasskeyAccount.Call[](3);
        calls[0] = PasskeyAccount.Call(address(AUSD), 0, abi.encodeCall(IERC20.approve, (PERPL, 10 * UNIT)));
        calls[1] = PasskeyAccount.Call(PERPL, 0, abi.encodeCall(IPerplAccounts.createAccount, (10 * UNIT)));
        calls[2] = _perplOrder(mark * 10_050 / 10_000, 500);
        uint256 deadline = block.timestamp + 10 minutes;
        (uint8 v, bytes32 r, bytes32 s) =
            vm.sign(sessionKey, account.sessionExecuteDigest(calls, session, 1, deadline));
        vm.prank(relayer);
        account.executeWithSession(calls, session, deadline, abi.encodePacked(r, s, v));
        assertEq(account.remainingToday(session), 5 * UNIT, "the Perpl deposit counts");

        uint256 price = mark * 10_500 / 10_000;
        calls = new PasskeyAccount.Call[](1);
        calls[0] = _perplOrder(price, 500);
        (v, r, s) = vm.sign(sessionKey, account.sessionExecuteDigest(calls, session, 2, deadline));
        bytes memory reason =
            abi.encodeWithSelector(PerplOrderGuard.PriceOutsideBand.selector, 0, price, mark);
        vm.expectRevert(abi.encodeWithSelector(PasskeyAccount.GuardRejected.selector, 0, reason));
        vm.prank(relayer);
        account.executeWithSession(calls, session, deadline, abi.encodePacked(r, s, v));

        calls[0] = _perplOrder(mark, 2000);
        (v, r, s) = vm.sign(sessionKey, account.sessionExecuteDigest(calls, session, 2, deadline));
        reason = abi.encodeWithSelector(PerplOrderGuard.LeverageNotAllowed.selector, 0, 2000, 1000);
        vm.expectRevert(abi.encodeWithSelector(PasskeyAccount.GuardRejected.selector, 0, reason));
        vm.prank(relayer);
        account.executeWithSession(calls, session, deadline, abi.encodePacked(r, s, v));
    }

    /// @dev An immediate-or-cancel buy of one lot, as packages/perpl's openMarketOrder builds it.
    function _perplOrder(uint256 price, uint256 leverageHdths)
        internal
        pure
        returns (PasskeyAccount.Call memory)
    {
        IPerplExchange.OrderDesc memory o;
        o.orderDescId = 1;
        o.perpId = PERPL_BTC;
        o.pricePNS = price;
        o.lotLNS = 1;
        o.immediateOrCancel = true;
        o.leverageHdths = leverageHdths;
        o.maxNegPnlCollatBPS = 1000;
        return PasskeyAccount.Call(PERPL, 0, abi.encodeCall(IPerplExchange.execOrder, (o)));
    }

    function _ownerWithdraw(PasskeyAccount account, uint256 passkey) internal {
        PasskeyAccount.Call[] memory calls = new PasskeyAccount.Call[](1);
        calls[0] =
            PasskeyAccount.Call(address(AUSD), 0, abi.encodeCall(IERC20.transfer, (relayer, 25 * UNIT)));
        uint256 deadline = block.timestamp + 10 minutes;
        WebAuthn.WebAuthnAuth memory auth =
            WebAuthnSigner.sign(passkey, account.ownerExecuteDigest(calls, 0, deadline));
        vm.prank(relayer);
        account.executeAsOwner(calls, deadline, auth);
    }

    function _noSettlements() internal pure returns (TrendRegistry.SettlementRequest[] memory) {
        return new TrendRegistry.SettlementRequest[](0);
    }

    function _push(uint64 index) internal {
        TrendRegistry.IndexUpdate[] memory updates = new TrendRegistry.IndexUpdate[](1);
        updates[0] = TrendRegistry.IndexUpdate({id: trend, index: index});
        _report(new TrendRegistry.NewTrend[](0), updates, _noSettlements());
    }

    /// @notice A report through the Mainnet MockKeystoneForwarder from the trusted broadcaster,
    ///         with no more gas than the oracle's limit leaves after the transaction's intrinsic
    ///         and calldata cost. The forwarder swallows a failed onReport, so the run id is what
    ///         proves the oracle's gas sizing holds under Monad's gas rules.
    function _report(
        TrendRegistry.NewTrend[] memory created,
        TrendRegistry.IndexUpdate[] memory updates,
        TrendRegistry.SettlementRequest[] memory settlements
    ) internal {
        uint64 runId = registry.lastRunId() + 1;
        TrendRegistry.Report memory r = TrendRegistry.Report({
            runId: runId,
            observedAt: uint64(block.timestamp),
            newTrends: created,
            updates: updates,
            settlements: settlements
        });
        bytes memory raw = abi.encodePacked(
            abi.encodePacked(
                bytes1(0x01),
                keccak256(abi.encode(runId, block.timestamp)),
                uint32(block.timestamp),
                uint32(1),
                uint32(1)
            ),
            bytes32(0),
            bytes10(0),
            address(0),
            bytes2(0),
            abi.encode(r)
        );
        bytes memory data =
            abi.encodeCall(IMockKeystoneForwarder.report, (address(registry), raw, "", new bytes[](0)));
        uint256 txLimit = REPORT_GAS_BASE + created.length * REPORT_GAS_PER_NEW_TREND + updates.length
            * REPORT_GAS_PER_UPDATE + settlements.length * REPORT_GAS_PER_SETTLEMENT;
        uint256 callGas = txLimit - 21_000 - 16 * data.length;
        vm.prank(broadcaster, broadcaster);
        (bool ok,) = MOCK_FORWARDER.call{gas: callGas}(data);
        assertTrue(ok);
        assertEq(registry.lastRunId(), runId, "onReport ran out of the oracle's gas limit");
    }
}
