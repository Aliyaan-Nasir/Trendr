// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {Test} from "forge-std/Test.sol";

import {KuruGraduationVenue} from "../../src/curve/KuruGraduationVenue.sol";
import {IKuruRouter} from "../../src/interfaces/kuru/IKuru.sol";
import {MockKuruMarket, MockKuruRouter, MockKuruVault} from "../mocks/MockKuru.sol";
import {MockStable} from "../mocks/MockStable.sol";

contract MockCoin is ERC20 {
    constructor() ERC20("Coin", "COIN") {}

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}

contract KuruGraduationVenueTest is Test {
    uint256 internal constant BASE = 160_000_000e18;
    uint256 internal constant QUOTE = 12_000e6; // 0.000075 AUSD per coin

    MockKuruRouter internal router;
    KuruGraduationVenue internal venue;
    MockStable internal ausd;
    MockCoin internal coin;
    address internal lister = address(0xC0);

    function setUp() public {
        router = new MockKuruRouter(false);
        venue = new KuruGraduationVenue(IKuruRouter(address(router)), false, 10, 0, 100);
        ausd = new MockStable();
        coin = new MockCoin();
        _fund(lister, venue);
    }

    function _fund(address who, KuruGraduationVenue v) internal {
        coin.mint(who, BASE);
        ausd.mint(who, QUOTE);
        vm.startPrank(who);
        coin.approve(address(v), type(uint256).max);
        ausd.approve(address(v), type(uint256).max);
        vm.stopPrank();
    }

    function _list(address who) internal returns (address market) {
        vm.prank(who);
        market = venue.list(address(coin), address(ausd), BASE, QUOTE);
    }

    function _vault(address market) internal view returns (MockKuruVault) {
        return MockKuruVault(MockKuruMarket(market).vault());
    }

    /// @dev The address the venue tries for parameter variant `i` when `who` lists in this block.
    function _variant(address who, uint256 i)
        internal
        view
        returns (KuruGraduationVenue.MarketParams memory p)
    {
        p = venue.marketParamsFor(address(coin), address(ausd), BASE, QUOTE);
        uint256 entropy = uint256(keccak256(abi.encode(block.prevrandao, block.number, who, address(coin))));
        p.maxSize += uint96(uint256(keccak256(abi.encode(entropy, i))) % 1e9);
    }

    function _deployVariant(KuruGraduationVenue.MarketParams memory p) internal returns (address) {
        return router.deployProxy(
            0,
            address(coin),
            address(ausd),
            p.sizePrecision,
            p.pricePrecision,
            p.tickSize,
            p.minSize,
            p.maxSize,
            10,
            0,
            100
        );
    }

    function _seedAtTenTimes(address market) internal {
        MockKuruVault v = _vault(market);
        address attacker = address(0xBAD);
        coin.mint(attacker, 1e18);
        ausd.mint(attacker, 1e6);
        vm.startPrank(attacker);
        coin.approve(address(v), 1e18);
        ausd.approve(address(v), 1e6);
        v.deposit(1e18, QUOTE * 10 * 1e18 / BASE, 0, attacker);
        vm.stopPrank();
    }

    // --- parameters -----------------------------------------------------------------------

    function test_marketParamsTrackThePrice() public view {
        uint256[4] memory quotes = [uint256(320e6), 12_000e6, 80_000_000e6, 4_800_000_000e6];
        for (uint256 i; i < quotes.length; ++i) {
            KuruGraduationVenue.MarketParams memory p =
                venue.marketParamsFor(address(coin), address(ausd), BASE, quotes[i]);
            uint256 priceWad = quotes[i] * 1e18 * 1e18 / (BASE * 1e6);
            uint256 priceUnits = priceWad * p.pricePrecision / 1e18;
            // About five significant digits (fewer only at Kuru's finest precision), inside the
            // uint32 price range with room to grow.
            assertGe(priceUnits, p.pricePrecision == 1e9 ? 100 : 1e4);
            assertLe(priceUnits, 1e5);
            // Ticks of about 0.1%.
            assertApproxEqRel(uint256(p.tickSize) * 1000, priceUnits, 0.01e18);
            // The minimum order is about one AUSD.
            uint256 minOrderWad = uint256(p.minSize) * priceWad / p.sizePrecision;
            assertApproxEqRel(minOrderWad, 1e18, 0.01e18);
            // Quote at the highest uint32 price for the largest order fits Kuru's uint96.
            assertLt(uint256(p.maxSize + 1e9) * type(uint32).max / p.sizePrecision, uint256(type(uint96).max));
            assertGt(p.maxSize, p.minSize);
        }
    }

    function test_priceOutOfRange() public {
        vm.expectRevert(KuruGraduationVenue.PriceOutOfRange.selector);
        venue.marketParamsFor(address(coin), address(ausd), BASE, 1);
    }

    function test_constructorBounds() public {
        IKuruRouter r = IKuruRouter(address(router));
        vm.expectRevert(KuruGraduationVenue.ZeroAddress.selector);
        new KuruGraduationVenue(IKuruRouter(address(0)), false, 10, 0, 100);
        vm.expectRevert(KuruGraduationVenue.InvalidParams.selector);
        new KuruGraduationVenue(r, false, 101, 0, 100);
        vm.expectRevert(KuruGraduationVenue.InvalidParams.selector);
        new KuruGraduationVenue(r, false, 10, 11, 100);
        vm.expectRevert(KuruGraduationVenue.InvalidParams.selector);
        new KuruGraduationVenue(r, false, 10, 0, 105);
        vm.expectRevert(KuruGraduationVenue.InvalidParams.selector);
        new KuruGraduationVenue(r, false, 10, 0, 500);
    }

    // --- permissionless router (Testnet) --------------------------------------------------

    function test_listDeploysAndSeedsAtTheGraduationPrice() public {
        address market = _list(lister);
        MockKuruVault v = _vault(market);
        assertEq(v.price(), QUOTE * 1e18 / BASE);
        assertEq(v.balanceOf(venue.LIQUIDITY_SINK()), v.totalSupply(), "all LP shares locked");
        assertEq(coin.balanceOf(address(venue)) + ausd.balanceOf(address(venue)), 0);
        assertEq(coin.balanceOf(address(v)), BASE);
        assertEq(ausd.balanceOf(address(v)), QUOTE);
        assertEq(coin.allowance(address(venue), address(v)) + ausd.allowance(address(venue), address(v)), 0);
        (,,, address market_) = venue.listings(lister, address(coin));
        assertEq(market_, market);
        (,, address base,, address quote,,,,,,) = router.verifiedMarket(market);
        assertEq(base, address(coin));
        assertEq(quote, address(ausd));
    }

    function test_listingsAreKeyedByLister() public {
        _list(lister);
        _fund(lister, venue);
        vm.prank(lister);
        vm.expectRevert(KuruGraduationVenue.AlreadyListed.selector);
        venue.list(address(coin), address(ausd), BASE, QUOTE);

        // Someone else listing the same coin cannot block or touch the first listing.
        address other = address(0xC1);
        _fund(other, venue);
        address second = _list(other);
        (,,, address first) = venue.listings(lister, address(coin));
        assertTrue(second != first);
    }

    function test_usesAPreDeployedMarketWithAnEmptyVault() public {
        address predicted = _deployVariant(_variant(lister, 0));
        address market = _list(lister);
        assertEq(market, predicted);
        assertEq(router.deployments(), 1);
        assertEq(_vault(market).price(), QUOTE * 1e18 / BASE);
    }

    function test_skipsAMarketWhoseVaultWasSeeded() public {
        address hijacked = _deployVariant(_variant(lister, 0));
        _seedAtTenTimes(hijacked);
        address market = _list(lister);
        assertTrue(market != hijacked);
        assertEq(_vault(market).price(), QUOTE * 1e18 / BASE);
    }

    function test_revertsWhenEveryVariantIsHijacked() public {
        for (uint256 i; i < venue.MAX_ATTEMPTS(); ++i) {
            _seedAtTenTimes(_deployVariant(_variant(lister, i)));
        }
        vm.prank(lister);
        vm.expectRevert(KuruGraduationVenue.NoFreshMarket.selector);
        venue.list(address(coin), address(ausd), BASE, QUOTE);
        // Graduation can retry in a later block, with new entropy.
        vm.roll(block.number + 1);
        vm.prevrandao(bytes32(uint256(7)));
        _list(lister);
    }

    function test_listRejectsZeroInputs() public {
        vm.startPrank(lister);
        vm.expectRevert(KuruGraduationVenue.ZeroAmount.selector);
        venue.list(address(coin), address(ausd), 0, QUOTE);
        vm.expectRevert(KuruGraduationVenue.ZeroAddress.selector);
        venue.list(address(0), address(ausd), BASE, QUOTE);
        vm.stopPrank();
    }

    // --- permissioned router (Kuru Mainnet) -----------------------------------------------

    function test_permissionedRouterRefusesCustody() public {
        router = new MockKuruRouter(true);
        venue = new KuruGraduationVenue(IKuruRouter(address(router)), true, 10, 0, 100);
        _fund(lister, venue);
        vm.prank(lister);
        vm.expectRevert(KuruGraduationVenue.ListingUnavailable.selector);
        venue.list(address(coin), address(ausd), BASE, QUOTE);
        assertEq(coin.balanceOf(address(venue)) + ausd.balanceOf(address(venue)), 0);
    }
}
