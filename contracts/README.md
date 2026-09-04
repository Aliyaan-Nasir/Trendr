# Trendr contracts

Solidity 0.8.30, Foundry, compiled for Prague with `network = "monad"` so tests use Monad gas, precompiles and size limits.
All contracts are ownerless and non-upgradeable, with every parameter fixed at deploy or bounded in code.

| Contract | Role |
|---|---|
| `TrendRegistry` | Trends, attention index values and settlement values. The only writer is the Chainlink CRE forwarder (`IReceiver`). |
| `OutcomeMarkets` + `OutcomeToken` | UP/DOWN attention outcome tokens per trend and window: complete sets mint and redeem for exactly 1 AUSD, settled from the registry. |
| `OutcomeListing` | The one canonical Kuru market of every UP and DOWN token against AUSD, with fixed parameters; deployed by `list` on Testnet, recorded with `adopt` where only Kuru may deploy (Mainnet). |
| `AttentionPerp` | Isolated-margin perps on the attention index, up to 3x, per-block funding from long/short skew. |
| `BondingCurve` + `TrendCoin` | Launch-layer coin per trend on a constant-product curve whose floor ratchets with peak attention. |
| `KuruGraduationVenue` | Lists a graduated coin on its own Kuru market and seeds the AMM vault at the curve's final price. |
| `CurationFees` | Credits a share of fees to the account that first surfaced each trend. |
| `PasskeyAccount` | EIP-7702 delegate (version 2): passkey (P256) owner, session keys capped by expiry, a gross daily AUSD limit (each call's outflow counts) and permissions that may name a guard, sponsored batched execution; version 1 accounts move over once with `upgrade`. |
| `PerplOrderGuard` | The guard session Perpl orders name: immediate opens and closes only, priced within 2% of Perpl's on-chain mark (at most two minutes old), openings at up to a leverage cap fixed at deploy (10x by default). |
| `TrendrLens` | Batched read-only views for the CRE oracle, the keeper and the app. |
| `TrendrSpot` + `AttentionPricing` | Kuru spot for accounts: session `buy`/`sell` of UP and DOWN only within 0.10 AUSD of the attention-implied value; `buyWithLimit`/`sellWithLimit` (passkey batches) for any canonical market. |

## Tests

```bash
forge build
forge test                                   # unit, fuzz and invariant suites
forge test --match-path 'test/invariant/*'   # stateful invariants only
MONAD_FORK=true forge test --match-path 'test/fork/*'   # Monad Testnet fork: Kuru listing, 7702 flow
MONAD_MAINNET_FORK=true forge test --match-path test/fork/MainnetRehearsal.fork.t.sol   # Mainnet fork: Deploy and core flows (MONAD_MAINNET_RPC_URL forks a provider; runs nightly in mainnet-fork.yml)
INVARIANT_COVERAGE=true forge test --match-contract PerpInvariants -vv   # how often each path ran
python3 test/mutations/run.py                # plants each bug in mutations.json, expects a failure
forge fmt --check && forge lint
forge snapshot --check --match-path 'test/unit/*' --no-match-test testFuzz
```

## Deploy

`script/Deploy.s.sol` writes addresses to `deployments/<chainId>.json`; the Testnet deployment (`deployments/10143.json`) is live and verified on Sourcify and Monadscan, and nothing is on Mainnet yet.
`.env` (gitignored) holds `DEPLOYER_PRIVATE_KEY`, `DEPLOYER_ADDRESS` and `ETHERSCAN_API_KEY` for Monadscan.
Testnet runs the registry in CRE mock mode: the MockKeystoneForwarder delivers reports and `tx.origin` must be the broadcaster `cre workflow simulate --broadcast` uses.

```bash
source .env
CRE_BROADCASTER=$DEPLOYER_ADDRESS POOL_SEED=5000000000 forge script script/Deploy.s.sol --rpc-url monad_testnet --private-key $DEPLOYER_PRIVATE_KEY --broadcast --slow --verify --verifier sourcify --verifier-url https://sourcify-api-monad.blockvision.org/
```

Monad Mainnet deploys follow `docs/mainnet.md`, which also covers the rehearsal on an Anvil fork of Mainnet with `script/MainnetRehearsal.s.sol`.

Testnet replaces single layers with `script/RedeployOutcomes.s.sol` (`REDEPLOY=outcomes|listing|lens|spot|account|guard|config`, keeping the registry); `REDEPLOY=account` deploys a new PasskeyAccount and PerplOrderGuard, after which `packages/contracts-ts/src/legacy.ts` and the indexer's constants must list the previous PasskeyAccount so its accounts keep working until they upgrade.
`REDEPLOY=guard` deploys a new PerplOrderGuard alone (`PERPL_SESSION_MAX_LEVERAGE_HDTHS` sets its cap); sessions and Autopilot grants naming the previous guard keep its rules until the app renews them.
`test/legacy/PasskeyAccountV1.sol` keeps version 1's source for the upgrade and storage tests.

```bash
REDEPLOY=account forge script script/RedeployOutcomes.s.sol --rpc-url monad_testnet --private-key $DEPLOYER_PRIVATE_KEY --broadcast --slow --verify --verifier sourcify --verifier-url https://sourcify-api-monad.blockvision.org/
forge verify-contract <address> src/account/PasskeyAccount.sol:PasskeyAccount --chain 10143 --verifier etherscan --guess-constructor-args --rpc-url monad_testnet --watch
```

`script/Scenarios.s.sol` runs end-to-end scenarios against the live Testnet deployment, one broadcast per step (setup, trade, post, crash, liquidate, then retire two hours later).
Each step reads ids from chain state, because series ids and Kuru market addresses depend on the block they land in.

```bash
forge script script/Scenarios.s.sol --sig "run(string,string)" setup e2e-1 --rpc-url monad_testnet --broadcast --slow --non-interactive
```
