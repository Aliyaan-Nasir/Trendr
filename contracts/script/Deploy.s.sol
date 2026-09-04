// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {CurationFees} from "../src/CurationFees.sol";
import {TrendRegistry} from "../src/TrendRegistry.sol";
import {PasskeyAccount} from "../src/account/PasskeyAccount.sol";
import {BondingCurve} from "../src/curve/BondingCurve.sol";
import {KuruGraduationVenue} from "../src/curve/KuruGraduationVenue.sol";
import {ICurationFees} from "../src/interfaces/ICurationFees.sol";
import {IGraduationVenue} from "../src/interfaces/IGraduationVenue.sol";
import {ITrendRegistry} from "../src/interfaces/ITrendRegistry.sol";
import {IKuruRouter} from "../src/interfaces/kuru/IKuru.sol";
import {TrendrLens} from "../src/lens/TrendrLens.sol";
import {OutcomeListing} from "../src/outcome/OutcomeListing.sol";
import {OutcomeMarkets} from "../src/outcome/OutcomeMarkets.sol";
import {AttentionPerp} from "../src/perp/AttentionPerp.sol";
import {TrendrSpot} from "../src/spot/TrendrSpot.sol";
import {MockKuruRouter} from "../test/mocks/MockKuru.sol";
import {MockStable} from "../test/mocks/MockStable.sol";
import {DeploymentFile} from "./DeploymentFile.sol";

/// @notice Deploys the Trendr contracts and writes their addresses to deployments/<chainId>.json.
///
///         Environment:
///         - CRE_MODE: "mock" (MockKeystoneForwarder, writes pinned to CRE_BROADCASTER, the key
///           `cre workflow simulate --broadcast` uses) or "production" (KeystoneForwarder, with
///           CRE_WORKFLOW_OWNER and CRE_WORKFLOW_NAME as bytes10). Defaults to "mock".
///         - TREASURY: receives protocol fees and curation for trends without a surfacer.
///           Required on Mainnet; defaults to the deployer elsewhere.
///         - POOL_SEED: AUSD (raw units) the deployer deposits into the perp insurance pool.
///         - PERPL_SESSION_MAX_LEVERAGE_HDTHS: the highest leverage a session Perpl opening may name,
///           in Perpl's hundredths. Defaults to 1000 (10x); higher leverage is a passkey action.
///
///         Monad Mainnet deploys only with explicit approval: set CONFIRM_MAINNET=yes.
contract Deploy is DeploymentFile {
    uint256 internal constant TESTNET = 10_143;
    uint256 internal constant MAINNET = 143;
    uint256 internal constant LOCAL = 31_337;
    uint256 internal constant UNIT = 1e6;

    struct Network {
        address ausd;
        address kuruRouter;
        address perplExchange;
        bool kuruPermissioned;
        address creForwarder;
        address creMockForwarder;
        TrendRegistry.Params params;
        uint256 maxOpenInterestPerSide;
        uint256 curveBaseVirtualQuote;
        uint256 curveGraduationReserve;
        /// @dev Short outcome window for fast end-to-end cycles; zero on Mainnet.
        uint32 outcomeTestWindow;
    }

    function run() external returns (Deployment memory d) {
        if (block.chainid == MAINNET) {
            require(
                keccak256(bytes(vm.envOr("CONFIRM_MAINNET", string("")))) == keccak256("yes"),
                "Mainnet needs CONFIRM_MAINNET=yes"
            );
        }
        Network memory n = network();
        // Mainnet must name its mode: a mock registry trusts one hot key, and the registry's
        // forwarder can never change, so moving to production later means a full redeploy.
        string memory creMode =
            block.chainid == MAINNET ? vm.envString("CRE_MODE") : vm.envOr("CRE_MODE", string("mock"));
        bool mock = keccak256(bytes(creMode)) == keccak256("mock");
        require(mock || keccak256(bytes(creMode)) == keccak256("production"), "CRE_MODE: mock or production");
        d.creMock = mock;

        vm.startBroadcast();
        (, address deployer,) = vm.readCallers();
        d.startBlock = block.number;
        d.treasury = block.chainid == MAINNET ? vm.envAddress("TREASURY") : vm.envOr("TREASURY", deployer);

        if (block.chainid == LOCAL) {
            n.ausd = address(new MockStable());
            n.kuruRouter = address(new MockKuruRouter(false));
            n.creMockForwarder = deployer;
        }
        d.ausd = n.ausd;
        d.kuruRouter = n.kuruRouter;
        d.perplExchange = n.perplExchange;

        TrendRegistry registry;
        if (mock) {
            d.forwarder = n.creMockForwarder;
            address broadcaster = block.chainid == LOCAL ? deployer : vm.envAddress("CRE_BROADCASTER");
            registry = new TrendRegistry(d.forwarder, broadcaster, address(0), bytes10(0), n.params);
        } else {
            d.forwarder = n.creForwarder;
            registry = new TrendRegistry(
                d.forwarder,
                address(0),
                vm.envAddress("CRE_WORKFLOW_OWNER"),
                bytes10(vm.envBytes32("CRE_WORKFLOW_NAME")),
                n.params
            );
        }
        d.registry = address(registry);
        ITrendRegistry reg = ITrendRegistry(d.registry);

        CurationFees curation = new CurationFees(IERC20(n.ausd), reg, d.treasury);
        d.curation = address(curation);
        d.outcomes = address(new OutcomeMarkets(IERC20(n.ausd), reg, n.outcomeTestWindow));
        d.outcomeListing = address(
            new OutcomeListing(IKuruRouter(n.kuruRouter), OutcomeMarkets(d.outcomes), n.kuruPermissioned)
        );
        AttentionPerp perp = new AttentionPerp(
            IERC20(n.ausd), reg, ICurationFees(d.curation), d.treasury, n.maxOpenInterestPerSide
        );
        d.perp = address(perp);
        d.venue = address(new KuruGraduationVenue(IKuruRouter(n.kuruRouter), n.kuruPermissioned, 10, 0, 100));
        d.curve = address(
            new BondingCurve(
                IERC20(n.ausd),
                reg,
                ICurationFees(d.curation),
                IGraduationVenue(d.venue),
                d.treasury,
                n.curveBaseVirtualQuote,
                n.curveGraduationReserve
            )
        );
        d.passkeyAccount = address(new PasskeyAccount(IERC20(n.ausd)));
        (d.perplOrderGuard, d.perplSessionMaxLeverageHdths) = _newPerplOrderGuard(n.perplExchange);
        d.lens = address(
            new TrendrLens(
                registry,
                OutcomeMarkets(d.outcomes),
                OutcomeListing(d.outcomeListing),
                AttentionPerp(d.perp),
                BondingCurve(d.curve)
            )
        );
        d.spot = address(
            new TrendrSpot(IKuruRouter(n.kuruRouter), OutcomeListing(d.outcomeListing), BondingCurve(d.curve))
        );

        uint256 poolSeed = vm.envOr("POOL_SEED", uint256(0));
        if (block.chainid == LOCAL && poolSeed == 0) poolSeed = 100_000 * UNIT;
        if (poolSeed > 0) {
            if (block.chainid == LOCAL) MockStable(n.ausd).mint(deployer, poolSeed);
            IERC20(n.ausd).approve(d.perp, poolSeed);
            perp.depositPool(poolSeed);
        }
        vm.stopBroadcast();

        _save(d);
    }

    function network() public view returns (Network memory n) {
        if (block.chainid == TESTNET) {
            n.ausd = 0xa9012a055bd4e0eDfF8Ce09f960291C09D5322dC;
            n.kuruRouter = 0x7EFbE105Ca7415dE98F96622173458ac1c054630;
            n.perplExchange = 0x1964C32f0bE608E7D29302AFF5E61268E72080cc;
            n.creForwarder = 0xF8344CFd5c43616a4366C34E3EEE75af79a74482;
            n.creMockForwarder = 0xB9F79d863261869B234c481D1f9A7af84AeAd192;
            // Fast cadence for demos: the Testnet workflow runs every minute and re-reports each trend
            // at least every few minutes (heartbeat), well inside the staleness limit.
            n.params = TrendRegistry.Params({
                stalenessLimit: 10 minutes,
                maxMoveBps: 5000,
                attentionFloor: 5e6,
                coolingWindow: 30 minutes,
                retireWindow: 1 hours,
                staleRetireWindow: 2 hours,
                settlementTolerance: 10 minutes,
                maxReportAge: 5 minutes,
                maxFutureSkew: 1 minutes
            });
            n.maxOpenInterestPerSide = 250_000 * UNIT;
            n.curveBaseVirtualQuote = 2000 * UNIT;
            n.curveGraduationReserve = 2000 * UNIT;
            n.outcomeTestWindow = 15 minutes;
        } else if (block.chainid == MAINNET) {
            n.ausd = 0x00000000eFE302BEAA2b3e6e1b18d08D69a9012a;
            n.kuruRouter = 0xd651346d7c789536ebf06dc72aE3C8502cd695CC;
            n.perplExchange = 0x34B6552d57a35a1D042CcAe1951BD1C370112a6F;
            n.kuruPermissioned = true;
            n.creForwarder = 0x76c9cf548b4179F8901cda1f8623568b58215E62;
            n.creMockForwarder = 0x9eF6468C5f37b976E57d52054c693269479A784d;
            // Production cadence: the workflow runs every minute and re-reports each trend at least
            // every 12 minutes (config.mainnet.json), inside the 15 minute staleness limit.
            n.params = TrendRegistry.Params({
                stalenessLimit: 15 minutes,
                maxMoveBps: 3000,
                attentionFloor: 5e6,
                coolingWindow: 6 hours,
                retireWindow: 24 hours,
                staleRetireWindow: 24 hours,
                settlementTolerance: 15 minutes,
                maxReportAge: 10 minutes,
                maxFutureSkew: 1 minutes
            });
            n.maxOpenInterestPerSide = 100_000 * UNIT;
            n.curveBaseVirtualQuote = 2000 * UNIT;
            n.curveGraduationReserve = 10_000 * UNIT;
        } else if (block.chainid == LOCAL) {
            n.params = TrendRegistry.Params({
                stalenessLimit: 5 minutes,
                maxMoveBps: 5000,
                attentionFloor: 5e6,
                coolingWindow: 30 minutes,
                retireWindow: 1 hours,
                staleRetireWindow: 2 hours,
                settlementTolerance: 5 minutes,
                maxReportAge: 5 minutes,
                maxFutureSkew: 1 minutes
            });
            n.maxOpenInterestPerSide = 250_000 * UNIT;
            n.curveBaseVirtualQuote = 2000 * UNIT;
            n.curveGraduationReserve = 2000 * UNIT;
            n.outcomeTestWindow = 15 minutes;
        } else {
            revert("unsupported chain");
        }
    }
}
