# Monad Mainnet runbook

This is the runbook for deploying Trendr to Monad Mainnet (chain 143) and switching every service over.
Nothing is deployed on Mainnet yet.
Every number below was measured on 2026-10-10 by rehearsing the deploy on a local Anvil fork of Mainnet block 112038400, with the real AUSD, Kuru, Perpl, CRE forwarders and P256 precompile.
The rehearsal is repeatable: `contracts/test/fork/MainnetRehearsal.fork.t.sol` (automated, nightly in `.github/workflows/mainnet-fork.yml`) and `contracts/script/MainnetRehearsal.s.sol` (step by step on Anvil, with real receipts).

## Readiness and launch order

Mainnet goes live one product at a time, in this order, with the oracle on Trendr's own key (mock mode) first and on Chainlink's network later.
The contracts are permissionless, so each step is about which services run and what the app shows, not about on-chain switches; the app has no per-product switch yet, so when it goes live in step 3 it shows trend coins and Perpl too.

| Step | Ready | Waits on |
|---|---|---|
| 1. Contracts, CRE in mock mode | Yes: `Deploy.s.sol` requires `CRE_MODE` on Mainnet, and the rehearsal runs nightly on a Mainnet fork (`mainnet-fork.yml`) | the deployer key, 15 MON and `POOL_SEED` AUSD, the treasury multisig, the oracle broadcaster's address |
| 2. Oracle in mock mode | Yes: `pnpm sync-config` fills the config from `143.json`, the Mainnet cadence costs about half of Testnet's, and `pnpm cre:loop:mainnet` broadcasts only on a mock-mode registry | the Mainnet backend (collector and candidate queue) and the broadcaster key with MON |
| 3. Attention perps | Yes: the pool is seeded at deploy; relayer budgets, keeper and indexer configs are in place | hosting the backend, indexer, relayer, keeper and app |
| 4. Trend coins without graduation | Yes: where only Kuru can list, `graduate` reverts `ListingUnavailable`, a full curve waits and holders can sell back, and the keeper does not try to graduate | nothing more |
| 5. Perpl | Partly: trading from the account works; the Autopilot bot needs Mainnet credentials | a Perpl builder code and the Mainnet bot's API key |
| 6. Aurora deposits | Yes: deposits, and the USDC to AUSD conversion (app, relayer policy, fork-tested) | `AURORA_API_KEY` and the integrator fee in Aurora's portal; persistent addresses need Aurora's approval |
| 7. Up/Down on Kuru | No | Kuru's Safe deploying each series' markets, for windows agreed with Kuru |
| Later: oracle on Chainlink | No | Chainlink's deploy access; a mock-mode registry cannot switch, so this is a full redeploy and roll forward |

1. **Contracts.**
   Deploy with `CRE_MODE=mock` and `CRE_BROADCASTER` set to the oracle broadcaster's address ("Deploy" below), verify, then publish the addresses (step 6 there), which also writes the oracle and indexer configs.
   Accounts start on PasskeyAccount version 2 (gross daily limit, `PerplOrderGuard` on session Perpl orders), so Mainnet has no version 1 accounts: `legacyPasskeyAccounts(143)` stays empty and the relayer's upgrade route never applies there.
   The guard's leverage cap for session Perpl openings is fixed at deploy: 10x unless `PERPL_SESSION_MAX_LEVERAGE_HDTHS` (hundredths) says otherwise, recorded as `perplSessionMaxLeverageHdths` in `143.json`, which the app, Autopilot and backend read.
   A mock-mode registry trusts that one key for every index, forever: guard it like the treasury's keys.
2. **Oracle in mock mode.**
   Bring up the Mainnet backend (`BACKGROUND` on, `ORACLE_TOKEN` set), then run `CONFIRM_MAINNET=yes pnpm cre:loop:mainnet` in `apps/cre-oracle` with the broadcaster key in `.env.mainnet` (or exported on its host) and the topup service watching its balance.
   Check that `lastRunId()` rises and trends appear (smoke checks below).
3. **Attention perps.**
   Bring up the indexer (`pnpm start:mainnet`), relayer, keeper (with `SERIES_WINDOWS` and `LIST_WINDOWS` empty) and the app.
   Perps trade against the pool seeded at deploy; the keeper liquidates and marks them.
4. **Trend coins without graduation.**
   Curves need nothing more: a curve that reaches its graduation reserve waits, and holders keep selling into it.
   Graduation becomes possible only if Kuru enables vault deposits and lists the coin, which needs a venue change.
5. **Perpl.**
   Register the builder code, create the Mainnet bot's API key at app.perpl.xyz/apikeys with the bot wallet, set the bot in the backend, app and indexer (`src/lib/constants.ts`), and start the Autopilot service.
6. **Aurora.**
   Set `AURORA_API_KEY` on the backend and the integrator fee in the portal.
   Deposits land as USDC; the deposit page converts them to AUSD with one passkey prompt (`docs/aurora.md`).
7. **Up/Down on Kuru.**
   Agree the windows with Kuru, set `SERIES_WINDOWS` so the keeper opens those series, have Kuru's Safe deploy each series' UP and DOWN markets at `OutcomeListing.predictMarket`, then set `LIST_WINDOWS` so the keeper records them, and start the market maker with AUSD inventory.
   Kuru can deploy a series' markets only after the series opens.

### MON a day: oracle on our key or on Chainlink's network

Monad bills the gas limit at about 102 gwei (base fee 100 plus tip 2, checked again on 2026-10-10), so 1M gas of limit costs 0.102 MON.

The oracle, measured:

- Testnet receipts bill a report's full limit: 774,000 gas (0.079 MON) for 12 updates and 254,000 (0.026 MON) for 2.
- Over 11.4 hours on 2026-10-09 and 10, the Testnet loop (every minute, 7 minute heartbeat, 14 live trends with 12 measured a run) sent 360 reports and 2,409 trend updates a day, 179M gas a day, which is 18.3 MON a day at Mainnet prices.
- Mainnet runs every minute with a 12 minute heartbeat and measures every live trend each run, so one report every 12 minutes carries them all: 120 reports a day, 92.9M gas, 9.5 MON a day at twelve live trends (5.7 at six).
  That holds the 15 minute staleness limit even when one run fails: the 720 second heartbeat, two 60 second run intervals and 30 seconds to land make 870 seconds (`apps/cre-oracle/scripts/targets.test.ts` checks it against `Deploy.s.sol`).
- Index moves of 1% or more trigger extra reports, but they were rare on Testnet because the backend collector refreshes readings slowly; Up/Down settlements add one report per series expiry, about 0.4 MON a day at twelve trends.

| Wallet | Steps 1 to 6 | From step 7 (Up/Down on Kuru) |
|---|---|---|
| Oracle broadcaster, mock mode | about 9.5 MON | about 10 MON |
| Oracle on Chainlink's network | nothing: the DON pays the gas, and Chainlink bills under its CRE terms | nothing |
| Keeper | about 0.05 MON (perp marks, retirements, liquidations) | about 3.9 MON (`openSeries` 3.4, `list` 0.3, `settle` 0.1) |
| Market maker | nothing (it quotes only recorded markets) | about 12 MON at Testnet's settings, bounded by `MAX_SERIES`, `REQUOTE_TICKS` and `MIN_REQUOTE_SEC` |
| Relayer keys | per use: 0.035 MON a sign-up, 0.043 a session mint, 0.068 a Kuru trade, 0.035 an Aurora conversion; at most 4.1 MON an hour by budget | same |
| Autopilot bot | nothing with `BOT_VENUE=api` | nothing |
| Before any user, mock mode | about 9.6 MON | about 26 MON |
| Before any user, on Chainlink | about 0.05 MON | about 16 MON |

On Chainlink's network the workflow runs 1,440 times a day; if CRE bills per run, a 2 minute schedule with a 10 minute heartbeat (600 + 2 x 120 + 30 = 870 seconds) halves the runs for about 20% more report gas, which the DON pays.
Fund the broadcaster with 100 MON and let the topup service refill it (`apps/topup/.env.mainnet.example`).

## What the rehearsal found

Worked on the fork, with Mainnet parameters:

- `Deploy.s.sol` deploys all eleven contracts and seeds the perp pool in 13 transactions.
- A CRE report through the Mainnet MockKeystoneForwarder creates a trend; the keeper opens the 24 hour and 7 day series and a curve.
- Complete sets mint and redeem; an attention perp opens and closes at the new index; the curve buys and sells.
- EIP-7702: a fresh EOA delegates to PasskeyAccount, a session key mints within its daily limit, opens a Perpl account and buys one lot through `PerplOrderGuard` against Perpl's live mark (an order 5% off the mark is refused), and a WebAuthn passkey assertion (P256 precompile at 0x0100) withdraws, all relayed, with the account holding no MON.
  The order guard refuses a mark more than two minutes old, and on a fork the mark stays at the fork block, so the rehearsal does this step before it moves the clock.
- After the 24 hour window, the first observation after expiry settles the series Up, winners redeem, the short closes, the surfacer claims curation fees and protocol fees sweep to the treasury.
- Once Kuru's Safe deploys the canonical UP and DOWN markets, `OutcomeListing.list` records them (they land exactly at `predictMarket`), a maker quotes from Kuru's MarginAccount, and TrendrSpot buys and sells UP through them.
- The oracle's report gas sizing (`gas` in `config.mainnet.json`) holds under Monad gas rules for its largest runs: 11 new trends, 12 updates, and a settlement request.

Blocks Mainnet, each covered under "Before the deploy":

1. Kuru Mainnet AMM vaults refuse deposits: every vault, through the shared implementation `0x17ecCB57F292d8e41cCF40432F91b6B8Dcfe7A3c`, reverts `VaultDisabled()` (confirmed read-only against live Mainnet).
   `KuruGraduationVenue.completeListing` can therefore never seed a graduated coin's market, and on the permissioned router `BondingCurve.graduate` hands the curve's reserves to the venue first.
   On the fork a graduated curve left 10,934 AUSD and 133.4M coins in the ownerless venue with no way out, and coin holders with no market.
2. Kuru Mainnet's `Router.deployProxy` is owner-only (`Unauthorized()` for anyone else); the owner is Kuru's 3-of-5 Safe `0x8B736DCe2071783Fd9DB0a423dad17cc8ed5788b`.
   Every outcome series needs two markets from Kuru, about 1.27M gas each.
3. A registry's forwarder and trust mode are immutable, and `Deploy.s.sol` defaults `CRE_MODE` to `mock` even on Mainnet.
   A mock-mode Mainnet registry trusts one hot key, and moving to the DON later means redeploying every contract.
4. A graduated coin's market never reaches `BondingCurve.curveOf(trend).market` on a permissioned router (it stays zero), so `TrendrSpot.marketOf(coin)` and the app's coin ticket find no market even if Kuru seeds one.

Where they stand: 1 and 4 are handled in the code (graduation waits in the curve, below), 3 is decided (mock mode first, then a redeploy for Chainlink), and 2 waits on Kuru, so Up/Down goes live last.

Found along the way:

- Anvil's well-known dev accounts all carry EIP-7702 delegations on Monad Mainnet (sweepers), so a fork rehearsal uses fresh keys for 7702 flows; never fund those accounts on a real network.
- `forge script` broadcasts set each gas limit from `eth_estimateGas`, and because the forwarder swallows a failed `onReport`, the estimate covers only the forwarder: the registry ran out of gas and the run silently did not land.
  The CRE sets an explicit limit, so production is fine; any script or tool that sends reports must set one too.
- `CRE_WORKFLOW_NAME` must be a full 32-byte hex value (the 10 name bytes first, then zeros); a 10-byte value fails to parse.

## Before the deploy

### Decisions and external approvals

**Chainlink (CRE).**
Trendr needs workflow deploy access on Monad Mainnet so the DON delivers reports through the real KeystoneForwarder `0x76c9cf548b4179F8901cda1f8623568b58215E62` (on the fork: `KeystoneForwarder 1.0.0`, owner `0xB8F1032c6E69ef81DB98CF036133b9CBeAD1B3b0`).
Get the workflow owner address and the exact 10-byte workflow name the DON writes into report metadata for `trendr-attention-mainnet` (bytes 32 to 41 of the metadata, which `TrendRegistry` compares).
Prove both on Testnet first: deploy a throwaway production-mode `TrendRegistry` there with the Testnet workflow's owner and name, and see a DON report raise its `lastRunId`.
The launch starts in mock mode instead (see "Readiness and launch order"); moving to the DON later means deploying a production-mode set and rolling forward, since a registry's forwarder never changes.
`Deploy.s.sol` makes Mainnet name its mode (`CRE_MODE=mock` or `production`).
In production the DON transmits and pays gas, billed under Chainlink's CRE terms.

**Kuru (listing and graduation).**
For outcome markets, Trendr needs Kuru to deploy the canonical markets of each listed series, or a Router upgrade that lets `OutcomeListing` deploy them.
The exact call for each UP and DOWN token, which lands at `OutcomeListing.predictMarket(token)`:

```solidity
router.deployProxy(0, token, AUSD, 100, 10_000, 10, 100, 1_000_000_000, 10, 0, 100);
// type NO_NATIVE, sizePrecision 100, pricePrecision 10_000, tickSize 10, minSize 100,
// maxSize 1e9, takerFeeBps 10, makerFeeBps 0, kuruAmmSpread 100
```

A 24 hour series rolls daily per trend, so twelve live trends need 24 markets a day; the 7 day window alone needs about 3.4 a day.
Agree the windows with Kuru, then set the keeper's `LIST_WINDOWS` to them.
For graduated coins, Trendr needs Kuru to enable AMM vault deposits for those markets (`VaultDisabled` today) and to deploy each coin's market with the parameters `KuruGraduationVenue.marketParamsFor` returns, or a different graduation venue.

**The launch layer (bonding curves).**
Until Kuru vaults take deposits, a curve that fills on Mainnet strands its reserves, and `graduate` is permissionless, so hiding curves in the app does not protect anyone who buys through the contract.
Choose one before deploying:

- Ship the proposed contract change below (the venue refuses custody on a permissioned router, and holders can sell back while a filled curve waits), so graduation simply waits.
- Or leave the launch layer out of the Mainnet deploy, which needs `Deploy.s.sol`, `TrendrLens` and `TrendrSpot` changes because they take the curve's address.

**Perpl.**
Register a builder code (id 1 to 255) for Trendr with Perpl; `packages/perpl` already encodes it (`builderExtension`, and the `builder` option at enrollment), but no builder id is configured anywhere yet.
Create the Mainnet bot's API key at app.perpl.xyz/apikeys with the bot wallet (trade scope); Testnet keys do not carry over.
Perpl's Exchange `0x34B6552d57a35a1D042CcAe1951BD1C370112a6F` answers `getContractVersion` 1.7.5 on the fork.

**Aurora.**
In the Aurora Client Portal, set the integrator fee on Trendr's key (currently 0; at most 500 bps, split 60/40 with Aurora's floor of 2 bps on stables and 10 on others) and the Fees Collection payout (asset and threshold).
Ask Aurora to enable persistent deposit addresses for the key (creation answers 403 today).
Deposits land as USDC; the deposit page converts it to AUSD in the AUSD/USDC/USDT0 stable pool with one passkey prompt, and the relayer sponsors exactly that batch on Mainnet (Kuru's AUSD/USDC book is soft-paused).
The pool's admin is a single EOA that can raise its fee to 50% at once, so every conversion carries a minimum out near par; `docs/aurora.md` has who controls the pool and the fork test.

### Proposed contract changes

The `Deploy.s.sol` and graduation changes below are in the code; the `TrendrSpot.sol` one is not, and is needed only if Kuru enables vault deposits and the venue keeps its custody flow.

`Deploy.s.sol`: Mainnet must name its CRE mode.

```diff
-        bool mock = keccak256(bytes(vm.envOr("CRE_MODE", string("mock")))) == keccak256("mock");
+        // Mainnet must name its mode: a mock registry trusts one hot key, and the registry's
+        // forwarder can never change, so moving to production later means a full redeploy.
+        string memory creMode =
+            block.chainid == MAINNET ? vm.envString("CRE_MODE") : vm.envOr("CRE_MODE", string("mock"));
+        bool mock = keccak256(bytes(creMode)) == keccak256("mock");
+        require(mock || keccak256(bytes(creMode)) == keccak256("production"), "CRE_MODE: mock or production");
```

`KuruGraduationVenue.sol` and `BondingCurve.sol`: graduation waits in the curve where only Kuru can list, and holders can always sell back.
Two venue tests that exercise the pending listing (`test_permissionedRouterWaitsForKuru`, `test_completeListingRefusesASeededVault`) are replaced by one that expects `ListingUnavailable`; a new curve test sells a filled curve back below the reserve and sees it reopen.
`completeListing`, the `ListingPending` event and their errors are removed with it; the indexer's `ListingPending` handler and `Graduation.pending` go at its next resync.

```diff
--- contracts/src/curve/KuruGraduationVenue.sol
+    error ListingUnavailable();
@@ function list(address base, address quote, uint256 baseAmount, uint256 quoteAmount)
-        if (routerPermissioned) {
-            emit ListingPending(msg.sender, base, quote, baseAmount, quoteAmount);
-            return address(0);
-        }
+        // Where only Kuru deploys markets, a listing could wait forever (and Kuru Mainnet vaults
+        // refuse deposits), so graduation waits in the curve, where holders can still sell.
+        if (routerPermissioned) revert ListingUnavailable();
--- contracts/src/curve/BondingCurve.sol
@@ function sell(bytes32 trendId, uint256 coinsIn, uint256 minQuoteOut, address to, uint256 deadline)
-        Curve storage c = _openCurve(trendId);
+        Curve storage c = _sellableCurve(trendId);
@@
         c.sold -= coinsIn;
+        if (c.state == State.Ready && c.reserve < graduationReserve) c.state = State.Open;
@@
+    /// @dev Open, or Ready while graduation waits on the venue: holders can always sell back.
+    function _sellableCurve(bytes32 trendId) internal view returns (Curve storage c) {
+        c = _curves[trendId];
+        if (c.state == State.None) revert UnknownCurve();
+        if (c.state != State.Open && c.state != State.Ready) revert CurveClosed();
+    }
```

`TrendrSpot.sol`: only if Kuru enables vault deposits and the venue keeps its custody flow instead, route graduated coins through the market the venue recorded (the app's coin ticket and portfolio, which read `curveOf(trend).market`, need the same fallback).

```diff
+import {KuruGraduationVenue} from "../curve/KuruGraduationVenue.sol";
@@ function marketOf(address token) public view returns (address market) {
         if (address(c.coin) != token || c.state != BondingCurve.State.Graduated) return address(0);
-        return c.market;
+        if (c.market != address(0)) return c.market;
+        // On a permissioned router the venue seeds the market after graduation and records it;
+        // only that market is needed.
+        // forge-lint: disable-next-line(unused-return)
+        (,,, market) = KuruGraduationVenue(address(curve.venue())).listings(address(curve), token);
```

### MON and AUSD per wallet

Monad bills the gas limit, not the gas used, at the base fee plus the tip: 100 gwei plus 2 gwei on Mainnet when measured, so 1M gas of limit costs 0.102 MON.
Forge sets limits at 130% of the estimate; the services (`@trendr/chain`) at 120%.
Monad also holds back part of each sender's balance as a reserve for in-flight gas (10 MON by default when this was written; confirm in Monad's docs), so fund every sending wallet above that.

| Wallet | Measured spend | Fund with |
|---|---|---|
| Deployer | 2.48 MON for the whole deploy (24.30M gas of limit) | 15 MON, plus `POOL_SEED` AUSD |
| Keeper | about 0.25 MON per `openSeries`; about 3.6 MON a day at twelve live trends (both windows, plus settlements) | 120 MON for a month |
| Relayer keys | about 0.035 MON per activation, 0.04 to 0.07 MON per relayed trade | 25 MON each, three keys |
| Market maker | about 0.04 MON per first order on a level; a re-quote `batchUpdate` (about 435k gas on Testnet) about 0.05 MON | 30 MON, plus 2,500 AUSD at default settings |
| Autopilot bot | none with `BOT_VENUE=api` | AUSD collateral on Perpl for its rules |
| Oracle broadcaster (mock mode) | about 9.5 MON a day at twelve live trends: 120 reports of 774,000 gas of limit | 100 MON, refilled by the topup service |
| CRE (production) | paid by the DON under Chainlink's terms | nothing in MON |
| Treasury | receives fees, sends nothing | a multisig, no MON |

AUSD:

- Perp pool seed: 20,000 AUSD (`POOL_SEED=20000000000`).
  At an index of 25 points or more the open-interest cap per side is the smaller of 5 times the pool and 100,000 AUSD, so 20,000 unlocks the full Mainnet cap; 5,000 gives 25,000 a side.
- Market maker: `SETS_PER_SERIES` times `MAX_SERIES` in complete sets plus `MARGIN_AUSD`, 2,500 AUSD at the defaults; plan 2,000 to 5,000 a day of active series.
- The deployer holds `POOL_SEED` when the deploy runs; nothing else needs AUSD.

### Measured gas

Deploy, on the fork with Mainnet settings (gas used, and the limit forge set, which Monad bills):

| Transaction | Gas used | Gas limit | MON at 102 gwei |
|---|---|---|---|
| TrendRegistry | 2,372,000 | 3,083,600 | 0.315 |
| CurationFees | 421,826 | 548,373 | 0.056 |
| OutcomeMarkets | 3,086,504 | 4,012,455 | 0.409 |
| OutcomeListing | 863,853 | 1,123,008 | 0.115 |
| AttentionPerp | 2,591,886 | 3,369,451 | 0.344 |
| KuruGraduationVenue | 1,215,622 | 1,580,308 | 0.161 |
| BondingCurve | 3,226,473 | 4,194,414 | 0.428 |
| PasskeyAccount (version 2) | 2,270,351 | 2,951,518 | 0.301 |
| PerplOrderGuard | 816,736 | 1,061,756 | 0.108 |
| TrendrLens | 1,889,072 | 2,455,793 | 0.250 |
| TrendrSpot | 935,423 | 1,216,049 | 0.124 |
| AUSD approve | 70,249 | 91,899 | 0.009 |
| AttentionPerp.depositPool | 123,760 | 163,749 | 0.017 |
| Total | 19,883,755 | 25,852,373 | 2.637 |

No transaction comes near Monad's per-transaction gas limit, and Anvil with `--network monad` estimated within about 1% of Mainnet's own `eth_estimateGas` for the same calls.

Operations, gas used on the fork:

| Action | Paid by | Gas used |
|---|---|---|
| CRE report creating 1 trend (oracle limit 380,000) | DON | 329,209 |
| CRE report creating 11 trends (oracle limit 2,680,000) | DON | 2,082,548 |
| CRE report with 1 update (oracle limit 202,000) | DON | 126,032 to 143,032 |
| CRE report with 12 updates (oracle limit 774,000) | DON | 559,123 |
| CRE report with 1 settlement request (oracle limit 210,000) | DON | 145,619 |
| `openSeries` | keeper | 2,043,624 to 2,077,917 |
| `settle` | keeper | 82,153 |
| `OutcomeListing.list` recording Kuru's markets | keeper | 167,995 |
| `graduate` | keeper | 352,558 |
| `createCurve` | user | 915,045 |
| `mint` (first, then warm) | user | 311,769, 226,781 |
| `redeemSets`, `redeemWinnings` | user | 161,943, 162,865 |
| perp `open`, `close` | user | 383,760 to 499,035, 253,474 to 270,461 |
| curve `buy`, `sell` | user | 282,923 to 418,011, 269,146 |
| TrendrSpot `buy`, `sell` of UP on Kuru | user | 532,207, 559,501 |
| 7702 delegation, `initialize` | relayer | 46,059, 235,618 |
| `executeWithSession` (approve and mint) | relayer | 464,752 on the series' first mint (version 1: 354,245 on a warm one; reading the balance after each call adds about 22,000) |
| `executeWithSession` (approve, Perpl `createAccount`, a guarded order) | relayer | 584,670 |
| `executeAsOwner` (passkey, P256) | relayer | 100,729 |
| Kuru `deployProxy` | Kuru | 1,266,933 to 1,312,137 |
| Kuru MarginAccount `deposit`, `addBuyOrder`, `addSellOrder` | market maker | 134,342 to 142,339, 317,068, 342,737 |
| `CurationFees.claim`, perp and curve `sweepProtocolFees` | anyone | 106,843, 95,292, 78,223 |

### External addresses (checked on the fork)

| Contract | Address | Check |
|---|---|---|
| AUSD | `0x00000000eFE302BEAA2b3e6e1b18d08D69a9012a` | `AUSD`, 6 decimals, ERC-1967 proxy, about 100.3M supply |
| Kuru Router | `0xd651346d7c789536ebf06dc72aE3C8502cd695CC` | `verifiedMarket`, `computeAddress` and `anyToAnySwap` match `IKuru.sol`; `deployProxy` owner-only |
| Kuru MarginAccount | `0x2A68ba1833cDf93fa9Da1EEbd7F46242aD8E90c5` | the Router's `marginAccountAddress()`; `deposit` and `getBalance` match |
| Kuru Router owner | `0x8B736DCe2071783Fd9DB0a423dad17cc8ed5788b` | a 3-of-5 Safe |
| Perpl Exchange | `0x34B6552d57a35a1D042CcAe1951BD1C370112a6F` | ERC-1967 proxy, version 1.7.5 |
| CRE KeystoneForwarder | `0x76c9cf548b4179F8901cda1f8623568b58215E62` | `KeystoneForwarder 1.0.0` |
| CRE MockKeystoneForwarder | `0x9eF6468C5f37b976E57d52054c693269479A784d` | `MockKeystoneForwarder 1.0.0` |
| Multicall3 | `0xcA11bde05977b3631167028862bE2a173976CA11` | `getChainId()` 143 |
| P256VERIFY precompile | `0x0000000000000000000000000000000000000100` | verifies a valid signature |
| AUSD/USDC/USDT0 stable pool | `0x942644106B073E30D72c2C5D7529D5C296ea91ab` | holds about 685,000 AUSD; the fork's AUSD source |
| Stable pool factory admin | `0xabc336d4C71ad275695744d32DdB1d8266Db1cbF` | an EOA that controls the pool's fee (up to 50%, at once) and A; no pause, no access to liquidity (`docs/aurora.md`) |

## Rehearse on a fork

Rehearse from a separate worktree: the deploy writes `contracts/deployments/143.json` and `contracts/broadcast/Deploy.s.sol/143/`, and `bun run generate` publishes any `143.json` it finds to every service.
Only ever pass a `http://127.0.0.1` RPC to a command that broadcasts during a rehearsal.

The automated rehearsal forks Mainnet in memory and cannot broadcast:

```bash
cd contracts
MONAD_MAINNET_FORK=true forge test --match-path test/fork/MainnetRehearsal.fork.t.sol -vv
# MAINNET_FORK_BLOCK=<block> pins a block.
```

It runs the real `Deploy.s.sol`, puts back whatever `deployments/143.json` held before (or nothing), and pins the Kuru behavior above, so it fails the day Kuru changes either; update this page when it does.
`MONAD_MAINNET_RPC_URL` forks a provider endpoint instead of the public RPC.
`.github/workflows/mainnet-fork.yml` runs it every night with the Aurora conversion fork test (`cd apps/relayer && bun run test:fork:mainnet`), taking the RPC from the `MONAD_MAINNET_RPC_URL` repository secret.

The step-by-step rehearsal on Anvil gives real receipts:

```bash
# Monad gas rules and the 0x0100 precompile come from --network monad (it rejects --hardfork).
anvil --fork-url https://rpc.monad.xyz --network monad --port 8645

R=http://127.0.0.1:8645
DEV0=0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266   # Anvil dev account 0: deployer and CRE broadcaster
POOL=0x942644106B073E30D72c2C5D7529D5C296ea91ab
AUSD=0x00000000eFE302BEAA2b3e6e1b18d08D69a9012a
cast rpc anvil_impersonateAccount $POOL --rpc-url $R
cast rpc anvil_setBalance $POOL 0x56BC75E2D63100000 --rpc-url $R
cast send $AUSD 'transfer(address,uint256)' $DEV0 100000000000 --from $POOL --unlocked --rpc-url $R

cd contracts
CONFIRM_MAINNET=yes CRE_MODE=mock CRE_BROADCASTER=$DEV0 TREASURY=0x70997970C51812dc3A010C7d01b50e0d17dc79C8 \
  POOL_SEED=20000000000 forge script script/Deploy.s.sol --rpc-url $R \
  --private-key 0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80 --broadcast --slow

step() { forge script script/MainnetRehearsal.s.sol --rpc-url $R --slow --non-interactive --sig "run(string)" "$@"; }
step create             # the report goes out through Anvil with the oracle's gas limit
step setup --broadcast
step trade --broadcast
export INDEX_POINTS=44; step report
step close --broadcast
step passkey --broadcast
step graduate --broadcast  # fills the curve; graduate refuses with ListingUnavailable and the curve waits
step probe              # read only: prints the outcome tokens and their predicted markets
```

Play Kuru's Safe with the addresses `probe` printed, then record and trade:

```bash
SAFE=$(cast call 0xd651346d7c789536ebf06dc72aE3C8502cd695CC 'owner()(address)' --rpc-url $R)
SIG='deployProxy(uint8,address,address,uint96,uint32,uint32,uint96,uint96,uint256,uint256,uint96)'
cast rpc anvil_impersonateAccount $SAFE --rpc-url $R
cast rpc anvil_setBalance $SAFE 0x56BC75E2D63100000 --rpc-url $R
cast send 0xd651346d7c789536ebf06dc72aE3C8502cd695CC "$SIG" 0 <UP token> $AUSD 100 10000 10 100 1000000000 10 0 100 --from $SAFE --unlocked --rpc-url $R
cast send 0xd651346d7c789536ebf06dc72aE3C8502cd695CC "$SIG" 0 <DOWN token> $AUSD 100 10000 10 100 1000000000 10 0 100 --from $SAFE --unlocked --rpc-url $R
step listed --broadcast
```

Then move the clock past the 24 hour expiry, report, and settle:

```bash
cast rpc evm_increaseTime 43200 --rpc-url $R && cast rpc evm_mine --rpc-url $R
export INDEX_POINTS=46; step report
cast rpc evm_setNextBlockTimestamp <series expiry + 60> --rpc-url $R && cast rpc evm_mine --rpc-url $R
export INDEX_POINTS=50; step report
step settle --broadcast
```

Stop Anvil and delete the worktree when done.

## Deploy

Run from a clean checkout at the release commit: verification needs the exact sources, and any later change to an imported file changes the metadata hash.
Keep the Mainnet deployer key in `contracts/.env` as `MAINNET_DEPLOYER_PRIVATE_KEY` and `MAINNET_DEPLOYER_ADDRESS`, next to `ETHERSCAN_API_KEY`.

1. Preflight.

```bash
cd contracts
git status --short .            # empty
test ! -e deployments/143.json  # no rehearsal output
forge build && forge test
MONAD_MAINNET_FORK=true forge test --match-path test/fork/MainnetRehearsal.fork.t.sol
source .env
cast chain-id --rpc-url monad_mainnet                                        # 143
cast balance $MAINNET_DEPLOYER_ADDRESS --ether --rpc-url monad_mainnet      # at least 15
cast call 0x00000000eFE302BEAA2b3e6e1b18d08D69a9012a 'balanceOf(address)(uint256)' $MAINNET_DEPLOYER_ADDRESS --rpc-url monad_mainnet   # at least POOL_SEED
```

2. Settings, every one explicit.

```bash
export CONFIRM_MAINNET=yes
export CRE_MODE=mock                                 # launch order step 1: the oracle on our key first
export CRE_BROADCASTER=<oracle broadcaster address>  # the key in apps/cre-oracle/.env.mainnet
export TREASURY=<treasury multisig>
export POOL_SEED=20000000000
# export PERPL_SESSION_MAX_LEVERAGE_HDTHS=1000      # session Perpl openings at up to 10x (the default)
# Production mode instead, once Chainlink grants deploy access (a new deployment):
# export CRE_MODE=production
# export CRE_WORKFLOW_OWNER=<workflow owner address from Chainlink>
# export CRE_WORKFLOW_NAME=0x<the 10 name bytes, 20 hex digits><44 zeros>   # 32 bytes in all
```

3. Dry run against Mainnet: a simulation that sends nothing and writes nothing.

```bash
forge script script/Deploy.s.sol --rpc-url monad_mainnet --sender $MAINNET_DEPLOYER_ADDRESS
```

Check the printed deployment: in mock mode `forwarder` is the MockKeystoneForwarder `0x9eF6...784d` and `creMock` is true (in production mode the KeystoneForwarder `0x76c9...5E62` and false), and `treasury` is the multisig.

4. Deploy and verify on Sourcify (the BlockVision instance used for Testnet).

```bash
forge script script/Deploy.s.sol --rpc-url monad_mainnet --private-key $MAINNET_DEPLOYER_PRIVATE_KEY \
  --broadcast --slow --verify --verifier sourcify --verifier-url https://sourcify-api-monad.blockvision.org/
```

5. Verify on Monadscan (Etherscan V2, the `monad_mainnet` entry in `foundry.toml`).

```bash
D=deployments/143.json
for pair in trendRegistry:src/TrendRegistry.sol:TrendRegistry curationFees:src/CurationFees.sol:CurationFees \
  outcomeMarkets:src/outcome/OutcomeMarkets.sol:OutcomeMarkets outcomeListing:src/outcome/OutcomeListing.sol:OutcomeListing \
  attentionPerp:src/perp/AttentionPerp.sol:AttentionPerp kuruGraduationVenue:src/curve/KuruGraduationVenue.sol:KuruGraduationVenue \
  bondingCurve:src/curve/BondingCurve.sol:BondingCurve passkeyAccount:src/account/PasskeyAccount.sol:PasskeyAccount \
  perplOrderGuard:src/account/guards/PerplOrderGuard.sol:PerplOrderGuard \
  trendrLens:src/lens/TrendrLens.sol:TrendrLens trendrSpot:src/spot/TrendrSpot.sol:TrendrSpot; do
  key=${pair%%:*}; contract=${pair#*:}
  forge verify-contract $(jq -r .$key $D) $contract --chain 143 --verifier etherscan \
    --guess-constructor-args --rpc-url monad_mainnet --watch
done
```

6. Keep `deployments/143.json` and `broadcast/Deploy.s.sol/143/` (both are tracked), then publish the addresses.

```bash
forge build
cd ../packages/contracts-ts && bun run generate
for s in ../../backend ../../apps/relayer ../../apps/keeper ../../apps/market-maker ../../apps/autopilot; do (cd $s && bun install); done
cd ../../apps/cre-oracle && pnpm sync-config --target mainnet --backend https://<backend-host>   # registry, lens, collector URLs
cd ../../indexer && pnpm mainnet:config                                                      # config.mainnet.yaml, src/lib/mainnet.ts
```

Commit the generated files with `143.json`; `pnpm sync-config --target mainnet --check` and `pnpm mainnet:config --check` fail while they are out of date.

## Service changes

Each service has a `.env.mainnet.example` next to its `.env.example` with the values that differ; start from `.env.example` and apply them.

- **backend** (`backend/.env.mainnet.example`): `CHAIN_ID=143`, Mainnet `MONAD_RPC_URLS`, production `FRONTEND_URL`, new `ORACLE_TOKEN` and `ADMIN_SESSION_SECRET`, `AURORA_API_KEY` (deposits go live only on 143 and only with a key), the Mainnet Autopilot sealing key and bot, no faucet key, Mainnet `STATUS_SERVICES`.
- **relayer** (`apps/relayer/.env.mainnet.example`): `CHAIN_ID=143`, new MON-only keys, the production origin, and budgets sized from the measured costs: 10M gas per account a day (about 1 MON), 40M an hour in all (about 4.1 MON), 30 activations an hour and 3 per client address.
  On Mainnet its owner policy also sponsors the Aurora conversion, exactly `approve` of USDC to the stable pool and the pool's `exchange` of USDC for AUSD paid to the account with a minimum out; sessions never convert.
  Session keys can open, close and trade, within the daily AUSD limit the relayer sponsors (`MAX_SESSION_DAILY_LIMIT`, real money on Mainnet); they never carry `AttentionPerp.addMargin`, which is owner-only in the contract, so adding margin is a passkey action, as are withdrawals.
  The limit is gross: every call's AUSD outflow counts, and what other calls in the batch bring in (closes, sales, redemptions) never pays for more.
  Session Perpl orders go through `PerplOrderGuard` (immediate opens and closes within 2% of Perpl's mark, openings at up to its leverage cap), so the autopilot's `SLIPPAGE_BPS` and copy slippage are capped at 1%, and rules and copies open at no more than the cap; higher leverage is a passkey trade in the app.
- **keeper** (`apps/keeper/.env.mainnet.example`): `CHAIN_ID=143`, a new key, and `SERIES_WINDOWS` and `LIST_WINDOWS` empty until step 7; then `SERIES_WINDOWS` set to the windows agreed with Kuru, and `LIST_WINDOWS` once Kuru deploys their markets (before that `list` only fails simulation and raises `failing:list` alerts).
- **market maker** (`apps/market-maker/.env.mainnet.example`): `CHAIN_ID=143`, a new key with AUSD and MON, and a new `STATE_FILE` (the file is not keyed by chain); it quotes only recorded markets, so it idles until Kuru lists.
- **autopilot** (`apps/autopilot/.env.mainnet.example`): `CHAIN_ID=143`, the Mainnet relayer, a new sealing pair, and the Mainnet bot with a Mainnet Perpl API key.
- **oracle** (`apps/cre-oracle`): `pnpm sync-config --target mainnet --backend https://<backend-host>` writes `registry` and `lens` from `143.json` and the backend's https `/v1/oracle/measurements` and `/v1/oracle/candidates` into `config.mainnet.json` (empty URLs turn every collector source off).
  In mock mode, put the broadcaster key and `CRE_BACKEND_TOKEN` (the backend's `ORACLE_TOKEN`) in `.env.mainnet` (`.env.mainnet.example`), dry-run with `pnpm cre:simulate:mainnet`, then run `CONFIRM_MAINNET=yes pnpm cre:loop:mainnet`; it reads only `.env.mainnet` (or exported variables), and refuses before the deploy, on a production-mode registry, and on a config that does not match the deployment.
  In production mode, upload the secrets in `secrets.yaml` to the Vault DON instead and deploy with the CRE CLI (`cre workflow deploy attention-index --target mainnet`).
- **frontend** (`frontend/.env.mainnet.example`): `NEXT_PUBLIC_CHAIN_ID=143`, the Mainnet backend, relayer and RPC list, `NEXT_PUBLIC_TRENDR_BOT_ADDRESS` (without it the app shows the Testnet bot) and `NEXT_PUBLIC_PASSKEY_RP_ID` set to the production domain for good; rebuild, since every value is inlined at build time.
- **admin** (`admin/.env.mainnet.example`): the Mainnet backend URL; add the panel's origin to the backend's `FRONTEND_URL`.
- **indexer** (`indexer/.env.mainnet.example`): a separate indexer with its own database, so the Testnet one never changes or resyncs.
  `pnpm mainnet:config` writes `config.mainnet.yaml` (config.yaml's contracts with one chain, 143, at the deployment's addresses and start block) and `src/lib/mainnet.ts` (the PasskeyAccount implementation); run it with `ENVIO_RPC_URL_143` and `pnpm start:mainnet`, and add the Mainnet bot wallet to the 143 entry in `src/lib/constants.ts`.
  HyperSync serves chain 143 with the same token; `indexer/README.md` has the steps.

## Smoke checks

Read-only checks right after the deploy (`D=contracts/deployments/143.json`, `R=monad_mainnet`):

```bash
cast call $(jq -r .trendRegistry $D) 'forwarder()(address)' --rpc-url $R        # mock: 0x9eF6468C5f37b976E57d52054c693269479A784d; production: 0x76c9cf548b4179F8901cda1f8623568b58215E62
cast call $(jq -r .trendRegistry $D) 'trustedOrigin()(address)' --rpc-url $R    # mock: the broadcaster; production: zero
cast call $(jq -r .trendRegistry $D) 'workflowOwner()(address)' --rpc-url $R    # production only
cast call $(jq -r .trendRegistry $D) 'workflowName()(bytes10)' --rpc-url $R     # production only
cast call $(jq -r .trendRegistry $D) 'stalenessLimit()(uint64)' --rpc-url $R   # 900
cast call $(jq -r .attentionPerp $D) 'pool()(uint256)' --rpc-url $R             # POOL_SEED
cast call $(jq -r .attentionPerp $D) 'openInterestCap(uint64)(uint256)' 25000000 --rpc-url $R   # 100000000000
cast call $(jq -r .outcomeListing $D) 'routerPermissioned()(bool)' --rpc-url $R # true
cast call $(jq -r .outcomeMarkets $D) 'windows()(uint32[])' --rpc-url $R        # [86400, 604800]
cast call $(jq -r .attentionPerp $D) 'treasury()(address)' --rpc-url $R         # the multisig
```

Once the services run:

- After the first oracle run (the mock loop, or the DON in production), `lastRunId()` is above zero and `trendCount()` grows; if the forwarder emits `ReportProcessed` with result false while `lastRunId` stays put, the broadcaster (mock), the workflow owner or name (production), or the gas is wrong.
- The keeper's `/health` is green; from step 7, the first trend's series exist for the configured windows (`latestSeries`).
- The backend's `/health` reports chain 143 and the registry's `lastRunId`, `/v1/faucet` answers unavailable, and the status page lists every service.
- With a small real account: sign up (one relayed activation), mint a 1 AUSD complete set by session, redeem it, and withdraw with the passkey.
- The indexer's `/healthz` is green and its rows carry chain 143.
- The app shows "Monad Mainnet", no faucet, and monadscan.com explorer links.

## Kill switches and rollback

The contracts are ownerless and immutable: nothing pauses them, upgrades them or withdraws from them.
Every switch is off-chain, and rollback means deploying a fixed set and moving the services, while users exit the old one.

- **Market maker**: set `KILL_SWITCH` (or create `KILL_SWITCH_FILE`) to pull every quote.
- **Autopilot**: engage the admin kill switch (`POST /v1/admin/autopilot/kill` with `{"engaged": true}`) or set `KILL_SWITCH` in its environment.
- **Relayer**: stop it, or drop `ACCOUNT_GAS_PER_DAY` and `ACTIVATIONS_PER_HOUR` to the minimum; passkey accounts hold no MON, so app trading stops with it.
- **App**: deploy a maintenance build; the backend's `BACKGROUND=off` stops the radar and collector loops.
- **Oracle**: stopping the mock loop (or pausing the DON workflow) freezes perps (opening and closing both need a fresh index within 15 minutes) and new series, but not minting, redeeming or curve trades.
  After 24 hours without a report anyone can retire a trend with `pokeLifecycle`, and its positions settle at the last index with `settleRetired`; a series with no observation within 15 minutes after expiry settles Void two days later.
  Use it only when the index itself is wrong.
- **Keeper**: keep it running through an incident: it liquidates, settles and retires; stop it only to stop opening series.

Exits on a retired deployment stay open: `redeemSets` always pays 1 AUSD a set, series settle from the registry, perps close while the index is fresh or settle once the trend retires, curations stay claimable, and curves sell while open.
To roll forward, deploy the fixed set with the steps above, regenerate `@trendr/contracts`, point the oracle at the new registry, add the new addresses to the indexer (keeping the old ones), and redeploy the services.
