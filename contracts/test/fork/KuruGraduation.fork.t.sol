// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Test} from "forge-std/Test.sol";

import {CurationFees} from "../../src/CurationFees.sol";
import {TrendRegistry} from "../../src/TrendRegistry.sol";
import {BondingCurve} from "../../src/curve/BondingCurve.sol";
import {KuruGraduationVenue} from "../../src/curve/KuruGraduationVenue.sol";
import {TrendCoin} from "../../src/curve/TrendCoin.sol";
import {ICurationFees} from "../../src/interfaces/ICurationFees.sol";
import {IGraduationVenue} from "../../src/interfaces/IGraduationVenue.sol";
import {ITrendRegistry} from "../../src/interfaces/ITrendRegistry.sol";
import {IKuruOrderBook, IKuruRouter, IKuruVault} from "../../src/interfaces/kuru/IKuru.sol";

interface IAusdFaucet {
    function requestFunds(address to) external;
}

/// @notice Graduation onto the real Kuru v1 Router on a Monad Testnet fork, with Agora's
///         Testnet AUSD. Runs only with MONAD_FORK=true.
contract KuruGraduationForkTest is Test {
    IKuruRouter internal constant ROUTER = IKuruRouter(0x7EFbE105Ca7415dE98F96622173458ac1c054630);
    IERC20 internal constant AUSD = IERC20(0xa9012a055bd4e0eDfF8Ce09f960291C09D5322dC);
    IAusdFaucet internal constant FAUCET = IAusdFaucet(0xd236c18D274E54FAccC3dd9DDA4b27965a73ee6C);
    address internal constant FORWARDER = address(0xF0F0);
    address internal constant WF_OWNER = address(0xA11CE);
    bytes10 internal constant WF_NAME = bytes10("trendr-idx");
    uint256 internal constant UNIT = 1e6;

    TrendRegistry internal registry;
    BondingCurve internal curve;
    KuruGraduationVenue internal venue;
    bytes32 internal trend;
    TrendCoin internal coin;
    address internal buyer = makeAddr("buyer");
    address internal trader = makeAddr("trader");

    function setUp() public {
        if (!vm.envOr("MONAD_FORK", false)) vm.skip(true);
        vm.createSelectFork(vm.rpcUrl("monad_testnet"));

        registry = new TrendRegistry(
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
        CurationFees curation = new CurationFees(AUSD, ITrendRegistry(address(registry)), address(0x7EA5));
        venue = new KuruGraduationVenue(ROUTER, false, 10, 0, 100);
        curve = new BondingCurve(
            AUSD,
            ITrendRegistry(address(registry)),
            ICurationFees(address(curation)),
            IGraduationVenue(address(venue)),
            address(0x7EA5),
            2000 * UNIT,
            2000 * UNIT
        );

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
        trend = keccak256("hantavirus");
        coin = TrendCoin(curve.createCurve("hantavirus"));

        _faucet(buyer);
        _faucet(trader);
        vm.prank(buyer);
        AUSD.approve(address(curve), type(uint256).max);
    }

    /// @dev The faucet limits how often it pays out, so move the fork's clock between requests.
    function _faucet(address to) internal {
        vm.warp(vm.getBlockTimestamp() + 5 minutes);
        vm.roll(vm.getBlockNumber() + 750);
        FAUCET.requestFunds(to);
    }

    function _fill() internal {
        while (curve.curveOf(trend).state == BondingCurve.State.Open) {
            BondingCurve.Curve memory c = curve.curveOf(trend);
            vm.prank(buyer);
            curve.buy(trend, (c.virtualQuote + c.reserve) / 12, 0, buyer, block.timestamp);
        }
    }

    function test_graduationListsAndSeedsAKuruMarket() public {
        _fill();
        BondingCurve.Curve memory c = curve.curveOf(trend);
        uint256 quoteAmount = c.reserve + c.floorReserve + c.graduationLiquidity;
        uint256 spot = curve.spotPrice(trend);
        address market = curve.graduate(trend);

        (uint32 pricePrecision, uint96 sizePrecision, address base,, address quote,,,,,,) =
            ROUTER.verifiedMarket(market);
        assertEq(base, address(coin));
        assertEq(quote, address(AUSD));
        (address vaultAddress,,,,,,,) = IKuruOrderBook(market).getVaultParams();
        IKuruVault vault = IKuruVault(vaultAddress);
        assertGt(vault.balanceOf(venue.LIQUIDITY_SINK()), 0, "LP shares locked");
        assertEq(AUSD.balanceOf(address(venue)), 0, "venue keeps nothing");
        assertEq(coin.balanceOf(address(venue)), 0);
        assertEq(curve.curveOf(trend).market, market);

        // The vault quotes around the curve's final price: 1e18-scaled AUSD per coin.
        (uint256 bid, uint256 ask) = IKuruOrderBook(market).bestBidAsk();
        // spot is raw AUSD per raw coin scaled by 1e36; in whole tokens that is spot / 1e6 at 1e18.
        uint256 spotWad = spot / UNIT;
        assertApproxEqRel(ask, spotWad, 0.02e18, "ask near graduation price");
        assertLt(bid, ask);
        emit log_named_uint("graduation quote (AUSD units)", quoteAmount);
        emit log_named_uint("pricePrecision", pricePrecision);
        emit log_named_uint("sizePrecision", sizePrecision);

        // A trader buys 25 AUSD of coins and sells half back through the new market.
        uint256 spend = 25 * UNIT;
        vm.startPrank(trader);
        AUSD.approve(market, spend);
        uint96 quoteSize = uint96(spend * pricePrecision / UNIT);
        uint256 coinsOut = IKuruOrderBook(market).placeAndExecuteMarketBuy(quoteSize, 0, false, true);
        assertEq(coin.balanceOf(trader), coinsOut);
        assertApproxEqRel(coinsOut, spend * 1e18 * 1e18 / UNIT / ask, 0.03e18, "fill near ask");

        uint96 sellSize = uint96(coinsOut / 2 * sizePrecision / 1e18);
        coin.approve(market, coinsOut);
        uint256 before = AUSD.balanceOf(trader);
        uint256 quoteOut = IKuruOrderBook(market).placeAndExecuteMarketSell(sellSize, 0, false, true);
        vm.stopPrank();
        assertEq(AUSD.balanceOf(trader) - before, quoteOut);
        assertApproxEqRel(quoteOut, spend / 2, 0.05e18, "round trip within spread and fees");
    }

    function test_frontRunnerCannotHijackTheListing() public {
        _fill();
        BondingCurve.Curve memory c = curve.curveOf(trend);
        uint256 quoteAmount = c.reserve + c.floorReserve + c.graduationLiquidity;
        uint256 coinAmount = quoteAmount * (curve.VIRTUAL_TOKENS() - c.sold) / (c.virtualQuote + c.reserve);

        // An attacker who predicts the first parameter variant deploys it and seeds the vault at
        // ten times the price.
        KuruGraduationVenue.MarketParams memory p =
            venue.marketParamsFor(address(coin), address(AUSD), coinAmount, quoteAmount);
        uint256 entropy =
            uint256(keccak256(abi.encode(block.prevrandao, block.number, address(curve), address(coin))));
        uint96 maxSize = p.maxSize + uint96(uint256(keccak256(abi.encode(entropy, uint256(0)))) % 1e9);
        address attacker = makeAddr("attacker");
        address hijacked = ROUTER.deployProxy(
            0,
            address(coin),
            address(AUSD),
            p.sizePrecision,
            p.pricePrecision,
            p.tickSize,
            p.minSize,
            maxSize,
            10,
            0,
            100
        );
        (address hijackedVault,,,,,,,) = IKuruOrderBook(hijacked).getVaultParams();
        uint256 bait = coin.balanceOf(buyer) / 100;
        vm.prank(buyer);
        coin.transfer(attacker, bait);
        _faucet(attacker);
        vm.startPrank(attacker);
        coin.approve(hijackedVault, bait);
        AUSD.approve(hijackedVault, type(uint256).max);
        uint256 skewedQuote = bait * 10 * quoteAmount / coinAmount;
        IKuruVault(hijackedVault).deposit(bait, skewedQuote, 0, attacker);
        vm.stopPrank();

        address market = curve.graduate(trend);
        assertTrue(market != hijacked, "graduation must not use the hijacked market");
        (, uint256 ask) = IKuruOrderBook(market).bestBidAsk();
        (, uint256 hijackedAsk) = IKuruOrderBook(hijacked).bestBidAsk();
        assertGt(hijackedAsk, ask * 5);
    }
}
