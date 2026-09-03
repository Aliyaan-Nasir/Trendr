// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {CurationFees} from "../../../src/CurationFees.sol";
import {TrendRegistry} from "../../../src/TrendRegistry.sol";
import {BondingCurve} from "../../../src/curve/BondingCurve.sol";
import {ITrendRegistry} from "../../../src/interfaces/ITrendRegistry.sol";
import {MockStable} from "../../mocks/MockStable.sol";
import {MockVenue} from "../../mocks/MockVenue.sol";
import {OracleDriver} from "./OracleDriver.sol";

contract CurveHandler is OracleDriver {
    BondingCurve internal immutable curve;
    MockStable internal immutable ausd;
    MockVenue internal immutable venue;
    CurationFees internal immutable curation;

    uint256 internal constant T = 1_000_000_000e18;

    bytes32[] public trends;
    address[] public actors;
    mapping(bytes32 trendId => uint256) internal _lastVirtualQuote;

    /// @notice Times a curve's floor (virtual quote) went down; must stay zero.
    uint256 public floorDecreases;
    /// @notice Graduations that did not move exactly the curve's reserves; must stay zero.
    uint256 public graduationMismatches;

    constructor(
        TrendRegistry registry_,
        BondingCurve curve_,
        MockStable ausd_,
        MockVenue venue_,
        CurationFees curation_
    ) OracleDriver(registry_) {
        curve = curve_;
        ausd = ausd_;
        venue = venue_;
        curation = curation_;
        actors.push(address(0xA1));
        actors.push(address(0xA2));
        actors.push(address(0xA3));
        for (uint256 i; i < actors.length; ++i) {
            vm.prank(actors[i]);
            ausd.approve(address(curve), type(uint256).max);
        }
    }

    function trendCount() external view returns (uint256) {
        return trends.length;
    }

    // --- actions ----------------------------------------------------------------------------

    function createCurve(uint256 seed) external {
        if (trends.length >= 2) return;
        string memory identifier = string.concat("coin-", vm.toString(trends.length));
        bytes32 trend = _create(
            identifier,
            uint64(_bound(seed, 6, 60)) * POINT,
            trends.length % 2 == 0 ? address(0x5EED) : address(0)
        );
        curve.createCurve(identifier);
        trends.push(trend);
        _lastVirtualQuote[trend] = curve.curveOf(trend).virtualQuote;
    }

    /// @notice Buys within the price-impact limit, which must always succeed on an open curve.
    function buy(uint256 actorSeed, uint256 trendSeed, uint256 amount) external {
        (bool ok, bytes32 trend, BondingCurve.Curve memory c) = _pick(trendSeed);
        if (!ok || c.state != BondingCurve.State.Open) return;
        if (registry.statusOf(trend) != ITrendRegistry.Status.Active) return;
        uint256 depth = c.virtualQuote + c.reserve;
        amount = _bound(amount, depth / 100, depth / 12);
        address a = actors[actorSeed % actors.length];
        ausd.mint(a, amount);
        vm.prank(a);
        try curve.buy(trend, amount, 0, a, vm.getBlockTimestamp()) {
            _hit("buy");
            if (curve.curveOf(trend).state == BondingCurve.State.Ready) _hit("filled");
        } catch (bytes memory reason) {
            _unexpected(reason);
        }
        _checkFloor(trend);
    }

    /// @notice Buys of any size; ones that move the price too far must revert with PriceImpact.
    function bigBuy(uint256 actorSeed, uint256 trendSeed, uint256 amount) external {
        (bool ok, bytes32 trend, BondingCurve.Curve memory c) = _pick(trendSeed);
        if (!ok || c.state != BondingCurve.State.Open) return;
        if (registry.statusOf(trend) != ITrendRegistry.Status.Active) return;
        amount = _bound(amount, UNIT, c.virtualQuote + c.reserve);
        address a = actors[actorSeed % actors.length];
        ausd.mint(a, amount);
        vm.prank(a);
        try curve.buy(trend, amount, 0, a, vm.getBlockTimestamp()) {
            _hit("buy");
        } catch (bytes memory reason) {
            if (bytes4(reason) != BondingCurve.PriceImpact.selector) _unexpected(reason);
            else _hit("price impact rejected");
        }
        _checkFloor(trend);
    }

    function sell(uint256 actorSeed, uint256 trendSeed, uint256 amount) external {
        (bool ok, bytes32 trend, BondingCurve.Curve memory c) = _pick(trendSeed);
        if (!ok || c.state != BondingCurve.State.Open) return;
        address a = actors[actorSeed % actors.length];
        uint256 balance = IERC20(address(c.coin)).balanceOf(a);
        uint256 limit = (T - c.sold) / 12;
        if (balance == 0) return;
        amount = _bound(amount, 1, balance < limit ? balance : limit);
        (uint256 quoteOut,) = curve.quoteSell(trend, amount);
        if (quoteOut == 0) return; // dust worth nothing
        vm.prank(a);
        try curve.sell(trend, amount, 0, a, vm.getBlockTimestamp()) {
            _hit("sell");
        } catch (bytes memory reason) {
            _unexpected(reason);
        }
        _checkFloor(trend);
    }

    function syncFloor(uint256 trendSeed) external {
        (bool ok, bytes32 trend, BondingCurve.Curve memory c) = _pick(trendSeed);
        if (!ok || c.state != BondingCurve.State.Open) return;
        curve.syncFloor(trend);
        if (curve.curveOf(trend).virtualQuote > c.virtualQuote) _hit("floor raised");
        _checkFloor(trend);
    }

    function moveIndex(uint256 trendSeed, uint256 seed, uint256 secs) external {
        (bool ok, bytes32 trend,) = _pick(trendSeed);
        if (!ok) return;
        _advance(_bound(secs, 1, 10 minutes));
        if (registry.statusOf(trend) == ITrendRegistry.Status.Retired) return;
        _walk(trend, seed);
    }

    function graduate(uint256 trendSeed) external {
        (bool ok, bytes32 trend, BondingCurve.Curve memory c) = _pick(trendSeed);
        if (!ok || c.state != BondingCurve.State.Ready) return;
        _graduate(trend, c);
    }

    function sweepFees() external {
        if (curve.protocolFees() == 0) return;
        curve.sweepProtocolFees();
    }

    function claimCuration(bool treasury) external {
        address who = treasury ? address(0x7EA5) : address(0x5EED);
        if (curation.claimable(who) == 0) return;
        vm.prank(who);
        curation.claim(who);
    }

    // --- exit -------------------------------------------------------------------------------

    /// @notice Graduates filled curves and sells every coin back into open ones.
    function exitAll() external {
        for (uint256 t; t < trends.length; ++t) {
            bytes32 trend = trends[t];
            BondingCurve.Curve memory c = curve.curveOf(trend);
            if (c.state == BondingCurve.State.Ready) _graduate(trend, c);
            if (c.state != BondingCurve.State.Open) continue;
            for (uint256 i; i < actors.length; ++i) {
                address a = actors[i];
                for (uint256 guard; guard < 64; ++guard) {
                    c = curve.curveOf(trend);
                    uint256 balance = IERC20(address(c.coin)).balanceOf(a);
                    uint256 limit = (T - c.sold) / 12;
                    uint256 amount = balance < limit ? balance : limit;
                    if (amount == 0) break;
                    (uint256 quoteOut,) = curve.quoteSell(trend, amount);
                    if (quoteOut == 0) break;
                    vm.prank(a);
                    try curve.sell(trend, amount, 0, a, vm.getBlockTimestamp()) {}
                    catch (bytes memory reason) {
                        _unexpected(reason);
                        break;
                    }
                }
            }
        }
    }

    // --- helpers ----------------------------------------------------------------------------

    function _graduate(bytes32 trend, BondingCurve.Curve memory c) internal {
        uint256 quoteAmount = c.reserve + c.floorReserve + c.graduationLiquidity;
        uint256 curveBalance = ausd.balanceOf(address(curve));
        uint256 venueQuote = ausd.balanceOf(address(venue));
        uint256 supply = IERC20(address(c.coin)).totalSupply();
        try curve.graduate(trend) {
            _hit("graduate");
            bool exact = ausd.balanceOf(address(venue)) - venueQuote == quoteAmount
                && curveBalance - ausd.balanceOf(address(curve)) == quoteAmount
                && venue.lastQuoteAmount() == quoteAmount
                && IERC20(address(c.coin)).totalSupply() - supply == venue.lastBaseAmount()
                && IERC20(address(c.coin)).balanceOf(address(venue)) == venue.lastBaseAmount();
            if (!exact) ++graduationMismatches;
        } catch (bytes memory reason) {
            _unexpected(reason);
        }
    }

    function _checkFloor(bytes32 trend) internal {
        uint256 vq = curve.curveOf(trend).virtualQuote;
        if (vq < _lastVirtualQuote[trend]) ++floorDecreases;
        _lastVirtualQuote[trend] = vq;
    }

    function _pick(uint256 seed) internal view returns (bool, bytes32, BondingCurve.Curve memory c) {
        if (trends.length == 0) return (false, bytes32(0), c);
        bytes32 trend = trends[seed % trends.length];
        return (true, trend, curve.curveOf(trend));
    }
}
