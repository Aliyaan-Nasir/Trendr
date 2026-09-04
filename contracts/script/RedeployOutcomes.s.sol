// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {console} from "forge-std/Script.sol";

import {TrendRegistry} from "../src/TrendRegistry.sol";
import {PasskeyAccount} from "../src/account/PasskeyAccount.sol";
import {BondingCurve} from "../src/curve/BondingCurve.sol";
import {ITrendRegistry} from "../src/interfaces/ITrendRegistry.sol";
import {IKuruRouter} from "../src/interfaces/kuru/IKuru.sol";
import {TrendrLens} from "../src/lens/TrendrLens.sol";
import {OutcomeListing} from "../src/outcome/OutcomeListing.sol";
import {OutcomeMarkets} from "../src/outcome/OutcomeMarkets.sol";
import {AttentionPerp} from "../src/perp/AttentionPerp.sol";
import {TrendrSpot} from "../src/spot/TrendrSpot.sol";
import {Deploy} from "./Deploy.s.sol";
import {DeploymentFile} from "./DeploymentFile.sol";

/// @notice Upgrades the outcome layer of an existing deployment, keeping the registry and
///         everything else. Series opened on a previous OutcomeMarkets keep working: they settle
///         against the same registry.
///
///         - REDEPLOY=outcomes replaces OutcomeMarkets (for a new window set) and with it
///           OutcomeListing and TrendrLens, which point at it.
///         - REDEPLOY=listing replaces OutcomeListing and what reads it: TrendrLens and TrendrSpot.
///         - REDEPLOY=lens replaces TrendrLens alone; REDEPLOY=spot replaces TrendrSpot alone.
///         - REDEPLOY=account deploys a new PasskeyAccount and PerplOrderGuard. Accounts delegating to
///           the previous PasskeyAccount keep working, and the app moves each one over with
///           `upgrade`; packages/contracts-ts/src/legacy.ts lists the previous implementation.
///         - REDEPLOY=guard deploys a new PerplOrderGuard alone (PERPL_SESSION_MAX_LEVERAGE_HDTHS
///           picks its cap). Sessions naming the previous guard keep its rules until the app renews
///           them (sessionMarker in packages/contracts-ts).
///         - REDEPLOY=config deploys nothing and only refreshes external addresses (Perpl).
///         - Otherwise only a missing OutcomeListing or TrendrSpot is added.
///         Every mode refreshes the external addresses from Deploy's network settings.
///
///         Not for Mainnet.
contract RedeployOutcomes is DeploymentFile {
    function run() external returns (Deployment memory d) {
        require(block.chainid != 143, "Mainnet deploys go through Deploy");
        d = _load();
        Deploy.Network memory n = new Deploy().network();
        bytes32 mode = keccak256(bytes(vm.envOr("REDEPLOY", string(""))));
        bool outcomes = mode == keccak256("outcomes");
        bool listing = outcomes || mode == keccak256("listing") || d.outcomeListing == address(0);
        bool lens = listing || mode == keccak256("lens");
        bool spot = listing || mode == keccak256("spot") || d.spot == address(0);
        bool config = mode == keccak256("config");
        bool account = mode == keccak256("account");
        bool guard = account || mode == keccak256("guard");
        require(
            outcomes || mode == keccak256("listing") || mode == keccak256("lens") || mode == keccak256("spot")
                || guard || config || mode == keccak256(""),
            "REDEPLOY: outcomes, listing, lens, spot, account, guard or config"
        );
        bool externalsChanged = d.perplExchange != n.perplExchange;
        d.perplExchange = n.perplExchange;
        if (config || (!listing && !lens && !spot && !guard)) {
            if (externalsChanged) {
                console.log("Perpl Exchange", d.perplExchange);
                _save(d);
            } else {
                console.log("Nothing to do: deployment is current");
            }
            return d;
        }

        vm.startBroadcast();
        if (account) {
            console.log("Replacing PasskeyAccount", d.passkeyAccount);
            d.passkeyAccount = address(new PasskeyAccount(IERC20(d.ausd)));
        }
        if (guard) {
            console.log("Replacing PerplOrderGuard", d.perplOrderGuard);
            (d.perplOrderGuard, d.perplSessionMaxLeverageHdths) = _newPerplOrderGuard(d.perplExchange);
        }
        if (outcomes) {
            console.log("Replacing OutcomeMarkets", d.outcomes);
            d.outcomes =
                address(new OutcomeMarkets(IERC20(d.ausd), ITrendRegistry(d.registry), n.outcomeTestWindow));
        }
        if (listing) {
            d.outcomeListing = address(
                new OutcomeListing(IKuruRouter(d.kuruRouter), OutcomeMarkets(d.outcomes), n.kuruPermissioned)
            );
        }
        if (lens) {
            d.lens = address(
                new TrendrLens(
                    TrendRegistry(d.registry),
                    OutcomeMarkets(d.outcomes),
                    OutcomeListing(d.outcomeListing),
                    AttentionPerp(d.perp),
                    BondingCurve(d.curve)
                )
            );
        }
        if (spot) {
            d.spot = address(
                new TrendrSpot(
                    IKuruRouter(d.kuruRouter), OutcomeListing(d.outcomeListing), BondingCurve(d.curve)
                )
            );
        }
        vm.stopBroadcast();

        console.log("OutcomeMarkets", d.outcomes);
        console.log("OutcomeListing", d.outcomeListing);
        console.log("TrendrLens", d.lens);
        console.log("TrendrSpot", d.spot);
        console.log("PasskeyAccount", d.passkeyAccount);
        console.log("PerplOrderGuard", d.perplOrderGuard);
        console.log("Session leverage cap (hundredths)", d.perplSessionMaxLeverageHdths);
        _save(d);
    }
}
