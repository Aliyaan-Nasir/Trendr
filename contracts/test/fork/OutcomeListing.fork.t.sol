// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Test} from "forge-std/Test.sol";

import {TrendRegistry} from "../../src/TrendRegistry.sol";
import {BondingCurve} from "../../src/curve/BondingCurve.sol";
import {ITrendRegistry} from "../../src/interfaces/ITrendRegistry.sol";
import {IKuruMarginAccount, IKuruOrderBook, IKuruRouter} from "../../src/interfaces/kuru/IKuru.sol";
import {OutcomeListing} from "../../src/outcome/OutcomeListing.sol";
import {OutcomeMarkets} from "../../src/outcome/OutcomeMarkets.sol";
import {TrendrSpot} from "../../src/spot/TrendrSpot.sol";

interface IAusdFaucet {
    function requestFunds(address to) external;
}

/// @notice UP and DOWN tokens listed on the real Kuru v1 Router on a Monad Testnet fork: canonical
///         markets, maker orders from the MarginAccount, and taker swaps through anyToAnySwap,
///         which is the path the app and the market maker use. Runs only with MONAD_FORK=true.
contract OutcomeListingForkTest is Test {
    IKuruRouter internal constant ROUTER = IKuruRouter(0x7EFbE105Ca7415dE98F96622173458ac1c054630);
    IKuruMarginAccount internal constant MARGIN =
        IKuruMarginAccount(0xd029C2D98ff85D8F64799017fE00a59B1159CE02);
    IERC20 internal constant AUSD = IERC20(0xa9012a055bd4e0eDfF8Ce09f960291C09D5322dC);
    IAusdFaucet internal constant FAUCET = IAusdFaucet(0xd236c18D274E54FAccC3dd9DDA4b27965a73ee6C);
    address internal constant FORWARDER = address(0xF0F0);
    address internal constant WF_OWNER = address(0xA11CE);
    bytes10 internal constant WF_NAME = bytes10("trendr-idx");
    uint256 internal constant UNIT = 1e6;

    OutcomeMarkets internal outcomes;
    OutcomeListing internal listing;
    bytes32 internal sid;
    IERC20 internal up;
    IERC20 internal down;
    address internal maker = makeAddr("maker");
    address internal taker = makeAddr("taker");

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
        listing = new OutcomeListing(ROUTER, outcomes, false);

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
        sid = outcomes.openSeries("hantavirus", 1 days);
        OutcomeMarkets.Series memory s = outcomes.seriesOf(sid);
        up = IERC20(address(s.up));
        down = IERC20(address(s.down));

        _faucet(maker);
        _faucet(taker);
    }

    function _faucet(address to) internal {
        vm.warp(vm.getBlockTimestamp() + 5 minutes);
        vm.roll(vm.getBlockNumber() + 750);
        FAUCET.requestFunds(to);
    }

    function _swap(address market, bool isBuy, IERC20 debit, IERC20 credit, uint256 amount)
        internal
        returns (uint256 out)
    {
        address[] memory markets = new address[](1);
        markets[0] = market;
        bool[] memory buys = new bool[](1);
        buys[0] = isBuy;
        vm.startPrank(taker);
        debit.approve(address(ROUTER), amount);
        out = ROUTER.anyToAnySwap(markets, buys, new bool[](1), address(debit), address(credit), amount, 1);
        vm.stopPrank();
        // The approval is consumed exactly, as a session batch requires.
        assertEq(debit.allowance(taker, address(ROUTER)), 0, "approval consumed");
    }

    function test_listedMarketsTradeAgainstMakerOrders() public {
        (address upMarket, address downMarket) = listing.list(sid);
        (uint32 pricePrecision, uint96 sizePrecision, address base,, address quote,, uint32 tick,,,,) =
            ROUTER.verifiedMarket(upMarket);
        assertEq(base, address(up));
        assertEq(quote, address(AUSD));
        assertEq(pricePrecision, listing.PRICE_PRECISION());
        assertEq(sizePrecision, listing.SIZE_PRECISION());
        assertEq(tick, listing.TICK_SIZE());
        (,, base,,,,,,,,) = ROUTER.verifiedMarket(downMarket);
        assertEq(base, address(down));

        // The maker mints 100 complete sets and quotes UP at 0.50 bid / 0.60 ask, 40 and 50 tokens.
        vm.startPrank(maker);
        AUSD.approve(address(outcomes), 100 * UNIT);
        outcomes.mint(sid, 100 * UNIT, maker);
        up.approve(address(MARGIN), 100 * UNIT);
        MARGIN.deposit(maker, address(up), 100 * UNIT);
        AUSD.approve(address(MARGIN), 20 * UNIT);
        MARGIN.deposit(maker, address(AUSD), 20 * UNIT);
        IKuruOrderBook(upMarket).addBuyOrder(5000, 4000, true);
        IKuruOrderBook(upMarket).addSellOrder(6000, 5000, true);
        vm.stopPrank();
        (uint256 bid, uint256 ask) = IKuruOrderBook(upMarket).bestBidAsk();
        assertEq(bid, 0.5e18, "bid in 1e18 AUSD per token");
        assertEq(ask, 0.6e18, "ask in 1e18 AUSD per token");

        // A taker buys UP with 12 AUSD: 20 tokens at 0.60, less the 0.1% taker fee.
        uint256 bought = _swap(upMarket, true, AUSD, up, 12 * UNIT);
        assertEq(up.balanceOf(taker), bought);
        assertApproxEqRel(bought, 20 * UNIT * 999 / 1000, 0.0005e18, "20 UP less fee");
        assertEq(
            MARGIN.getBalance(maker, address(AUSD)), 20 * UNIT - 20 * UNIT + 12 * UNIT, "maker paid in full"
        );

        // The taker sells 10 UP into the bid: 5 AUSD less the fee.
        uint256 before = AUSD.balanceOf(taker);
        uint256 proceeds = _swap(upMarket, false, up, AUSD, 10 * UNIT);
        assertEq(AUSD.balanceOf(taker) - before, proceeds);
        assertApproxEqRel(proceeds, 5 * UNIT * 999 / 1000, 0.0005e18, "5 AUSD less fee");
        assertEq(
            MARGIN.getBalance(maker, address(up)), 100 * UNIT - 50 * UNIT + 10 * UNIT, "maker received UP"
        );

        // The maker pulls the rest of the quotes and withdraws.
        uint40 last = IKuruOrderBook(upMarket).s_orderIdCounter();
        uint40[] memory ids = new uint40[](2);
        ids[0] = last - 1;
        ids[1] = last;
        vm.startPrank(maker);
        IKuruOrderBook(upMarket).batchCancelOrders(ids);
        uint256 freeUp = MARGIN.getBalance(maker, address(up));
        MARGIN.withdraw(freeUp, address(up));
        vm.stopPrank();
        assertEq(up.balanceOf(maker), freeUp);
        assertEq(freeUp, 100 * UNIT - 20 * UNIT + 10 * UNIT, "every unsold token comes back");
    }

    function test_batchUpdateRequotesInOneTransaction() public {
        (address upMarket,) = listing.list(sid);
        vm.startPrank(maker);
        AUSD.approve(address(MARGIN), 50 * UNIT);
        MARGIN.deposit(maker, address(AUSD), 50 * UNIT);
        uint32[] memory prices = new uint32[](1);
        uint96[] memory sizes = new uint96[](1);
        prices[0] = 4500;
        sizes[0] = 2000;
        IKuruOrderBook(upMarket)
            .batchUpdate(prices, sizes, new uint32[](0), new uint96[](0), new uint40[](0), true);
        uint40 first = IKuruOrderBook(upMarket).s_orderIdCounter();
        uint40[] memory cancel = new uint40[](1);
        cancel[0] = first;
        prices[0] = 4700;
        IKuruOrderBook(upMarket).batchUpdate(prices, sizes, new uint32[](0), new uint96[](0), cancel, true);
        vm.stopPrank();
        (uint256 bid,) = IKuruOrderBook(upMarket).bestBidAsk();
        assertEq(bid, 0.47e18, "the old bid is gone and the new one rests");
        // 20 tokens at 0.47 reserved; the cancelled 0.45 bid came back.
        assertEq(MARGIN.getBalance(maker, address(AUSD)), 50 * UNIT - 9_400_000);
    }

    /// @dev What the market maker relies on: the depth encoding, order records, and that a filled
    ///      order can no longer be named in a batchUpdate.
    function test_depthAndOrderRecords() public {
        (address upMarket,) = listing.list(sid);
        IKuruOrderBook book = IKuruOrderBook(upMarket);
        vm.startPrank(maker);
        AUSD.approve(address(outcomes), 20 * UNIT);
        outcomes.mint(sid, 20 * UNIT, maker);
        up.approve(address(MARGIN), 20 * UNIT);
        MARGIN.deposit(maker, address(up), 20 * UNIT);
        AUSD.approve(address(MARGIN), 10 * UNIT);
        MARGIN.deposit(maker, address(AUSD), 10 * UNIT);
        book.addBuyOrder(4000, 1000, true);
        book.addBuyOrder(3900, 500, true);
        book.addSellOrder(6000, 1000, true);
        vm.stopPrank();
        uint40 ask = book.s_orderIdCounter();

        bytes memory l2 = book.getL2Book(10, 10);
        uint256[] memory w = new uint256[](l2.length / 32);
        for (uint256 i; i < w.length; ++i) {
            w[i] = uint256(bytes32(_slice(l2, i * 32)));
        }
        assertEq(w.length, 1 + 4 + 1 + 2, "block, two bid levels, separator, one ask level");
        assertEq(w[0], block.number);
        assertEq(w[1], 4000);
        assertEq(w[2], 1000);
        assertEq(w[3], 3900);
        assertEq(w[4], 500);
        assertEq(w[5], 0);
        assertEq(w[6], 6000);
        assertEq(w[7], 1000);

        (address owner, uint96 size,,,, uint32 price,, bool isBuy) = book.s_orders(ask);
        assertEq(owner, maker);
        assertEq(size, 1000);
        assertEq(price, 6000);
        assertFalse(isBuy);

        // The taker lifts the whole ask. Its record stays until the owner names it in a cancel,
        // which then clears it; naming it a second time reverts the whole batchUpdate. Whether it
        // still rests shows in the price point: the level is empty, or its head is past the order.
        (uint40 head,) = book.s_sellPricePoints(6000);
        assertEq(head, ask, "the ask heads its level");
        _swap(upMarket, true, AUSD, up, 6 * UNIT);
        (owner,,,,,,,) = book.s_orders(ask);
        assertEq(owner, maker, "a filled order keeps its record");
        (head,) = book.s_sellPricePoints(6000);
        assertTrue(head == 0 || head > ask, "filled by the price point rule");
        uint40[] memory cancel = new uint40[](1);
        cancel[0] = ask;
        vm.prank(maker);
        book.batchUpdate(new uint32[](0), new uint96[](0), new uint32[](0), new uint96[](0), cancel, true);
        (owner,,,,,,,) = book.s_orders(ask);
        assertEq(owner, address(0), "the cancel clears the record");
        vm.prank(maker);
        vm.expectRevert();
        book.batchUpdate(new uint32[](0), new uint96[](0), new uint32[](0), new uint96[](0), cancel, true);
    }

    /// @dev The session trading path: TrendrSpot through the canonical market on the real Kuru.
    function test_spotTradesTheCanonicalMarket() public {
        (address upMarket,) = listing.list(sid);
        // The live Testnet curve, only for trend-coin lookups.
        TrendrSpot spot =
            new TrendrSpot(ROUTER, listing, BondingCurve(0x597e4ad49b2430Ed8D4543eb46f94189231534DF));
        vm.startPrank(maker);
        AUSD.approve(address(outcomes), 50 * UNIT);
        outcomes.mint(sid, 50 * UNIT, maker);
        up.approve(address(MARGIN), 50 * UNIT);
        MARGIN.deposit(maker, address(up), 50 * UNIT);
        AUSD.approve(address(MARGIN), 20 * UNIT);
        MARGIN.deposit(maker, address(AUSD), 20 * UNIT);
        IKuruOrderBook(upMarket).addBuyOrder(4500, 4000, true);
        IKuruOrderBook(upMarket).addSellOrder(5500, 4000, true);
        vm.stopPrank();

        address account = makeAddr("account");
        vm.startPrank(taker);
        AUSD.approve(address(spot), 11 * UNIT);
        uint256 bought = spot.buy(address(up), 11 * UNIT, 19.9e6, account);
        vm.stopPrank();
        assertApproxEqAbs(bought, 20 * UNIT * 999 / 1000, 1, "20 UP at 0.55 less the taker fee");
        assertEq(up.balanceOf(account), bought);

        vm.prank(account);
        up.approve(address(spot), 10 * UNIT);
        vm.prank(account);
        uint256 proceeds = spot.sell(address(up), 10 * UNIT, 4.4e6, account);
        assertApproxEqAbs(proceeds, 4.5e6 * 999 / 1000, 1, "10 UP at 0.45 less the taker fee");
        assertEq(AUSD.balanceOf(account), proceeds);
        assertEq(AUSD.balanceOf(address(spot)) + up.balanceOf(address(spot)), 0, "spot keeps nothing");

        // A minimum the book cannot meet reverts the whole trade.
        vm.startPrank(taker);
        AUSD.approve(address(spot), 1 * UNIT);
        vm.expectRevert();
        spot.buy(address(up), 1 * UNIT, 2 * UNIT, account);
        vm.stopPrank();
    }

    function _slice(bytes memory b, uint256 offset) internal pure returns (bytes32 out) {
        assembly ("memory-safe") {
            out := mload(add(add(b, 32), offset))
        }
    }
}
