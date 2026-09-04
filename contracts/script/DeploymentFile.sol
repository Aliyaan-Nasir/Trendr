// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Script, console} from "forge-std/Script.sol";
import {VmSafe} from "forge-std/Vm.sol";

import {PerplOrderGuard} from "../src/account/guards/PerplOrderGuard.sol";
import {IPerplExchange} from "../src/interfaces/perpl/IPerplExchange.sol";

/// @notice Reads and writes deployments/<chainId>.json, the address book every app is generated
///         from. A dry run never writes.
abstract contract DeploymentFile is Script {
    /// @dev Session Perpl orders: within 2% of Perpl's mark price, which must be at most two minutes
    ///      old. Trendr's own orders keep within 1% of the mark (docs/mainnet.md, "Session limits").
    uint256 internal constant PERPL_BAND_BPS = 200;
    uint256 internal constant PERPL_MAX_MARK_AGE = 2 minutes;
    /// @dev Session Perpl openings name at most 10x (Perpl's leverage is in hundredths). A deploy may
    ///      choose another cap with PERPL_SESSION_MAX_LEVERAGE_HDTHS; the deployments file records it.
    uint256 internal constant PERPL_SESSION_MAX_LEVERAGE_HDTHS = 1000;

    struct Deployment {
        address ausd;
        address registry;
        address curation;
        address outcomes;
        address outcomeListing;
        address perp;
        address venue;
        address curve;
        address passkeyAccount;
        /// @dev The guard session Perpl order permissions name, or zero where Perpl is not deployed.
        address perplOrderGuard;
        /// @dev The guard's leverage cap in hundredths (1000 is 10x), or zero without a guard.
        uint256 perplSessionMaxLeverageHdths;
        address lens;
        address spot;
        address kuruRouter;
        /// @dev Perpl's Exchange on this network, or zero where Perpl is not deployed.
        address perplExchange;
        address forwarder;
        address treasury;
        uint256 startBlock;
        bool creMock;
    }

    /// @dev The guard session Perpl order permissions name, and its leverage cap; none where Perpl is
    ///      not deployed. Call while broadcasting.
    function _newPerplOrderGuard(address exchange)
        internal
        returns (address guard, uint256 maxLeverageHdths)
    {
        if (exchange == address(0)) return (address(0), 0);
        maxLeverageHdths = vm.envOr("PERPL_SESSION_MAX_LEVERAGE_HDTHS", PERPL_SESSION_MAX_LEVERAGE_HDTHS);
        guard = address(
            new PerplOrderGuard(
                IPerplExchange(exchange), PERPL_BAND_BPS, PERPL_MAX_MARK_AGE, maxLeverageHdths
            )
        );
    }

    function _path() internal view returns (string memory) {
        return string.concat(vm.projectRoot(), "/deployments/", vm.toString(block.chainid), ".json");
    }

    function _load() internal view returns (Deployment memory d) {
        string memory json = vm.readFile(_path());
        d.ausd = vm.parseJsonAddress(json, ".ausd");
        d.registry = vm.parseJsonAddress(json, ".trendRegistry");
        d.curation = vm.parseJsonAddress(json, ".curationFees");
        d.outcomes = vm.parseJsonAddress(json, ".outcomeMarkets");
        if (vm.keyExistsJson(json, ".outcomeListing")) {
            d.outcomeListing = vm.parseJsonAddress(json, ".outcomeListing");
        }
        d.perp = vm.parseJsonAddress(json, ".attentionPerp");
        d.venue = vm.parseJsonAddress(json, ".kuruGraduationVenue");
        d.curve = vm.parseJsonAddress(json, ".bondingCurve");
        d.passkeyAccount = vm.parseJsonAddress(json, ".passkeyAccount");
        if (vm.keyExistsJson(json, ".perplOrderGuard")) {
            d.perplOrderGuard = vm.parseJsonAddress(json, ".perplOrderGuard");
        }
        if (vm.keyExistsJson(json, ".perplSessionMaxLeverageHdths")) {
            d.perplSessionMaxLeverageHdths = vm.parseJsonUint(json, ".perplSessionMaxLeverageHdths");
        }
        d.lens = vm.parseJsonAddress(json, ".trendrLens");
        if (vm.keyExistsJson(json, ".trendrSpot")) d.spot = vm.parseJsonAddress(json, ".trendrSpot");
        d.kuruRouter = vm.parseJsonAddress(json, ".kuruRouter");
        if (vm.keyExistsJson(json, ".perplExchange")) {
            d.perplExchange = vm.parseJsonAddress(json, ".perplExchange");
        }
        d.forwarder = vm.parseJsonAddress(json, ".creForwarder");
        d.treasury = vm.parseJsonAddress(json, ".treasury");
        d.startBlock = vm.parseJsonUint(json, ".startBlock");
        d.creMock = keccak256(bytes(vm.parseJsonString(json, ".creMode"))) == keccak256("mock");
    }

    function _save(Deployment memory d) internal {
        if (vm.isContext(VmSafe.ForgeContext.ScriptDryRun)) {
            console.log("Dry run: deployments file not written");
            return;
        }
        string memory key = "deployment";
        vm.serializeUint(key, "chainId", block.chainid);
        vm.serializeUint(key, "startBlock", d.startBlock);
        vm.serializeString(key, "creMode", d.creMock ? "mock" : "production");
        vm.serializeAddress(key, "ausd", d.ausd);
        vm.serializeAddress(key, "trendRegistry", d.registry);
        vm.serializeAddress(key, "curationFees", d.curation);
        vm.serializeAddress(key, "outcomeMarkets", d.outcomes);
        vm.serializeAddress(key, "outcomeListing", d.outcomeListing);
        vm.serializeAddress(key, "attentionPerp", d.perp);
        vm.serializeAddress(key, "kuruGraduationVenue", d.venue);
        vm.serializeAddress(key, "bondingCurve", d.curve);
        vm.serializeAddress(key, "passkeyAccount", d.passkeyAccount);
        vm.serializeAddress(key, "perplOrderGuard", d.perplOrderGuard);
        vm.serializeUint(key, "perplSessionMaxLeverageHdths", d.perplSessionMaxLeverageHdths);
        vm.serializeAddress(key, "trendrLens", d.lens);
        vm.serializeAddress(key, "trendrSpot", d.spot);
        vm.serializeAddress(key, "kuruRouter", d.kuruRouter);
        vm.serializeAddress(key, "perplExchange", d.perplExchange);
        vm.serializeAddress(key, "creForwarder", d.forwarder);
        string memory json = vm.serializeAddress(key, "treasury", d.treasury);
        vm.createDir(string.concat(vm.projectRoot(), "/deployments"), true);
        vm.writeJson(json, _path());
        console.log("Deployment written to", _path());
    }
}
