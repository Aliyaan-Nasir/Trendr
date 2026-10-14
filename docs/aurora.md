# Aurora Intents in Trendr

Trendr's collateral is AUSD on Monad Mainnet, and most people who want to trade hold something else on another chain.
Aurora Intents (built on NEAR Intents and 1Click) moves value from about 35 chains into Monad, and `packages/aurora` (`@trendr/aurora`) is Trendr's integration with it.
This page explains what each Aurora product does in Trendr, the exact endpoints, the deposit and refund lifecycle, the AUSD conversion, what was verified live and what still needs a real deposit.

<a href="https://youtu.be/NZQp8klvgY4"><img src="https://img.shields.io/badge/Watch-Aurora%20Intents%20demo-FF0000?style=for-the-badge&logo=youtube&logoColor=white" alt="Watch the Aurora Intents demo"></a>

## What each product does in Trendr

**Swap API (one-time deposit).**
The app quotes any supported asset on any supported chain into USDC on Monad, paid to the user's Trendr account.
A live quote returns a one-time deposit address; the user sends to it from any wallet or exchange, and Aurora swaps and delivers.
The refund address is always the user's own address on the chain they send from.
The same API carries withdrawals: USDC leaves the Trendr account for any asset on any chain, and a failed withdrawal refunds to the Trendr account on Monad.

**Intents Deposits with persistent addresses.**
Each user gets a permanent deposit address per source chain (one shared address for every EVM chain) that routes anything supported into USDC on Monad at their Trendr account.
The client and types are built, but Aurora must approve Trendr's key first: creation answered HTTP 403 ("Persistent deposit address creation is not enabled for this API key").

**Intents Connect (deposit and execute).**
The user signs once from their source wallet, deposits, and an intermediary account on Monad that their wallet controls runs Trendr's steps on arrival.
Trendr's recipes swap the bridged USDC to AUSD and then pay AUSD to the Trendr account, mint an outcome complete set to it, or open an AttentionPerp position for it with `openFor`.

## The package

- `AuroraClient`: tokens (cached), quotes (dry and live, all four swap types), deposit submission, status and `waitForSwap`, transaction history, incidents, and persistent addresses (create, deposits, lookup, list).
- `depositQuoteRequest` and `withdrawalQuoteRequest`: Trendr's quote requests with the refund policy built in.
- `TokenList`, `monadAsset`, `monadAssetDrift`, `MONAD_ASSETS`: Monad USDC, USDT0 and MON lookups, checked against the live list.
- `depositFromQuote`, `withDepositTx`, `withStatus`, `withClock`, `nextPollMs`, `describeDeposit`, `transferRequirements`: the deposit state machine and its user copy.
- `IntentsConnectClient`: supported tokens, intermediary, quote-backed and steps-only executions (dry and live), signature submit, deposit hash, listing, deletion and `waitForExecution`.
- `planBridgeIn` and `checkCreatedExecution`: the three-round sizing and the checks to run before the user signs.
- Recipes: `depositAusdSteps`, `mintOutcomeSetSteps`, `openPerpSteps`, `fundUsdcSteps`, `sweepSteps`, over a chosen AUSD venue (`CURVE_AUSD_VENUE` or `KURU_CLOB_VENUE`).
- Steps: `approveStep`, `transferStep`, `callStep`, `validateSteps`, `encodeStep`.
- Signing: `checkIntentPayload`, `signIntentPayload`, `toIntentsSignature`, `deleteExecutionMessage`.
- Venues: `curveQuote` and `curveSwapCalls` for the stable pool, `readKuruBook`, `readKuruMarketState`, `quoteKuruBuy`, `quoteKuruSell` and `kuruSwapCalls` for Kuru.
- `feeSplit`: Aurora's fee rules.

Every response is validated with zod, every call has a per-attempt timeout, and errors are typed (`AuroraHttpError`, `AuroraRateLimitError`, `AuroraTimeoutError`, `AuroraNetworkError`, `AuroraResponseError`, `AuroraInputError`, `ConnectStepError`, `ConnectPlanError`, `SigningPayloadError`).
Error messages never contain the API key; paths show it as `{apiKey}`.

## Endpoints used

Swap API, base `https://intents-api.aurora.dev`, key as a path segment:

- `GET /api/tokens/{apiKey}`
- `POST /api/quote/{apiKey}`
- `POST /api/deposit/submit/{apiKey}`
- `GET /api/status/{apiKey}?depositAddress=...&depositMemo=...`
- `GET /api/transactions/{apiKey}`
- `GET /api/incidents/{apiKey}`
- `POST /api/persistent-deposit-address/{apiKey}`
- `GET /api/persistent-deposit-status/{apiKey}?type=received|success|failed&address=...`
- `GET /api/persistent-deposit-address-data/{apiKey}?address=...`
- `GET /api/persistent-deposit-addresses/{apiKey}`

Intents Connect, base `https://intents-connect-api.aurora.dev` (the SDK uses `https://intents-connect-alpha-api.aurora.dev`; both answered identically):

- `GET /api/v1/supported_tokens`
- `GET /api/v1/executions/{wallet}/intermediary`
- `POST /api/v1/executions/{wallet}` (needs `x-api-key`)
- `POST /api/v1/executions/{wallet}/steps`
- `POST /api/v1/executions/{wallet}/submit`
- `POST /api/v1/executions/deposit/submit`
- `GET /api/v1/executions/{wallet}?id=...&status=...`
- `DELETE /api/v1/executions/{wallet}/{executionId}`

The Aurora key is not secret by Aurora's own docs, but the Intents Connect create calls should still go through a backend proxy so the key is not spent by third parties against Trendr's rate limits.

## Monad assets

Aurora supports Monad Mainnet (chain 143) only; there is no Monad Testnet.

| Symbol | Aurora asset id | Contract | Decimals |
| - | - | - | - |
| USDC | `nep245:v2_1.omni.hot.tg:143_2dmLwYWkCQKyTjeUPAsGJuiVLbFx` | `0x754704Bc059F8C67012fEd69BC8A327a5aafb603` | 6 |
| USDT0 | `nep245:v2_1.omni.hot.tg:143_4EJiJxSALvGoTZbnc8K7Ft9533et` | `0xe7cd86e13AC4309349F30B3435a9d337750fC82D` | 6 |
| MON | `nep245:v2_1.omni.hot.tg:143_11111111111111111111` | native | 18 |

AUSD (`0x00000000eFE302BEAA2b3e6e1b18d08D69a9012a`) is not an Aurora asset, so every deposit lands as USDC and is converted on Monad.

## Deposit lifecycle

1. The app requests a dry quote and shows the amount out, the minimum, the fees and the time estimate.
2. On confirmation it requests a live quote, which returns the deposit address, the deadline (when refunds begin) and `timeWhenInactive` (when the address stops accepting deposits).
3. The deposit address is shown only with its transfer requirements directly underneath (`transferRequirements`): the one supported asset and network, the amount rule for the swap type, the memo if any, the deadline, the loss-of-funds warning and where a refund goes.
4. If the app sends the deposit itself it calls `submitDeposit` with the transaction hash, which speeds up detection.
5. The backend polls `GET /api/status` every 6 seconds (Aurora asks for 5 to 10) and folds each answer into the stored `DepositState` with `withStatus`.
6. The deposit ends `succeeded` (with the Monad transaction hashes and the settled amount out) or `refunded` (with the refunded amount, the reason and the refund transactions).

| Aurora status | Trendr phase | Meaning |
| - | - | - |
| `PENDING_DEPOSIT` | `awaiting_deposit` | Waiting for the deposit |
| `KNOWN_DEPOSIT_TX` | `deposit_detected` | Deposit seen, not yet confirmed |
| `INCOMPLETE_DEPOSIT` | `incomplete_deposit` | Less than required arrived; the user can send the rest before the deadline, else it is refunded |
| `PROCESSING` | `processing` | Swap and delivery running |
| `SUCCESS` | `succeeded` | USDC delivered on Monad |
| `REFUNDED` | `refunded` | Deposit returned to the refund address |
| `FAILED` | `failed` | Aurora could not complete it; open a support case |
| (deadline passed, nothing sent) | `expired` | The address must not be used; a late deposit is still tracked and refunded |

State updates are monotonic, so a stale or out-of-order status never moves a deposit backwards, and a settled deposit never changes again.
`FAILED` stops polling but can still be refined to `REFUNDED` or `SUCCESS`, because that answer tells the user where their money is.
An expired quote is still watched once a minute until `timeWhenInactive`, so a late deposit is not lost.
`DepositState` is plain JSON, so the backend stores one per deposit and resumes after a restart.
For a `failed` deposit, `describeDeposit` returns the deposit address and transaction hashes that Aurora's support form asks for (https://aurora.dev/intents-support).

For `EXACT_INPUT`, less than the quoted amount is refunded at the deadline and more is swapped with the excess refunded.
For `EXACT_OUTPUT`, the user sends between `minAmountIn` and `maxAmountIn`.
For `FLEX_INPUT`, any amount above `minAmountIn` is swapped as long as `minAmountOut` holds.
`ANY_INPUT` (what persistent addresses use) needs `depositType` `INTENTS`; Aurora rejects it with `ORIGIN_CHAIN`.

## Refunds

- Deposits refund to `refundTo` on the origin chain (`refundType` `ORIGIN_CHAIN`), and `depositQuoteRequest` requires it to be a valid address on that chain (exact checks for EVM and Solana; Aurora validates other chains and rejects bad ones with "refundTo is not valid").
- The refund address must be the wallet the user sends from, never an exchange deposit address, which may not credit a refund.
- A refund costs `quote.refundFee` in the origin asset; live dry quotes showed 0.0024 USDC from Base, 0.0053 USDC from Arbitrum and 0.29 USDC from Solana for a 10 USDC deposit.
- Withdrawals refund to the Trendr account on Monad.
- `DepositState.outcome` models the result explicitly: `success` (Monad transactions, amount out), `refund` (amount, reason, refund address, refund transactions) or `failure`.
- Aurora reports the deposit and any refund together in `originChainTxHashes`; the state machine treats every origin transaction seen before the refund as a deposit and the rest as refunds, and keeps all of them for support.
- Intents Connect bridge-ins refund to the origin wallet on the origin chain: the public status of an Aurora test execution showed its 1Click quote with `refundTo` set to the origin wallet and `refundType` `ORIGIN_CHAIN`.
- If an Intents Connect step fails after the bridge (`OPERATION_FAILED`), the USDC stays in the intermediary, which only the origin wallet controls; `sweepSteps` builds the steps-only execution that moves it (and any surplus AUSD) to the Trendr account.
- The persistent address API takes no refund address, and its docs do not say where a failed swap's funds go; this is an open question for Aurora.

## Converting USDC to AUSD

Kuru Mainnet lists an AUSD/USDC order book (`0x699AbC15308156E9a3AB89Ec7387e9CfE1c86A3b`, base AUSD, quote USDC, price precision 1e8, size precision 1e6, no taker fee, minimum order 10 AUSD), and Router.verifiedMarket confirms it.
On 2026-10-09 and 2026-10-10 that market was `SOFT_PAUSED` (`marketState()` returned 1), which allows only cancels, deposits and withdrawals.
A simulated `anyToAnySwap` of USDC to AUSD through it reverted with `MarketStateError()`, while the same simulation through Kuru's active WETH/USDC market succeeded.
Its book also held only about 264 AUSD of asks (1.46 at 1.000836 USDC, 258.78 at 1.004884, 3.73 at 1.010324) and about 1,342 AUSD of bids, and Kuru's WBTC/AUSD market was soft-paused too; MON/AUSD was active but held about 5 USD.
Kuru's exchange API still listed AUSD/USDC as `TRADING`, so check `readKuruMarketState` rather than the listing.

The AUSD liquidity on Monad sits in a stable pool, `0x942644106B073E30D72c2C5D7529D5C296ea91ab` ("3pool", symbol AUSDCT0, version 7.0.0, a Curve StableSwap-NG style pool of AUSD, USDC and USDT0).
It held about 626k AUSD, 556k USDC and 1.12M USDT0, and quoted 1,000 USDC at 1,000.13 AUSD and 100,000 USDC at 99,987 to 100,001 AUSD.
Kuru's own aggregator (Kuru Flow) routed about 78% of a 1,000 USDC to AUSD swap through it and the rest through the Uniswap v4 pool manager, and paid the AUSD to the caller.
Its `exchange(i, j, dx, min_dy, receiver)` pays any receiver, so the AUSD can go straight to the Trendr account; a simulated 20 USDC exchange paid 20.0026 AUSD to the receiver.
Its source is not on Sourcify and Curve's public API does not list Monad, but Monadscan has it verified (below).

**Who controls the pool** (read-only calls against Mainnet on 2026-10-10, plus calls traced on a local fork):

- Monadscan has the verified source: `CurveStableSwap` by Curve.Fi, `@custom:version 7.0.0`, Vyper 0.3.10, the Curve StableSwap-NG code.
  It was created at block 37,567,492 (2025-11-23) by `0xa05a8bf1eda5bbc2b3acaf03d04f77bd7d66cc47` through the factory `0x8271e06E5887FE5ba05234f5315c19f3Ec90E8aD` (`CurveStableSwapFactory` 1.0.0, deployed at block 35,641,454 by `0x6b72a628099255b9492a815a39f0bf57d4d444e5`, 34 pools).
- The pool has no owner of its own and no `factory()` getter; its admin functions ask the factory, so its controller is `factory.admin()`, `0xabc336d4C71ad275695744d32DdB1d8266Db1cbF`, a plain EOA (no code, nonce 2, about 0.97 MON), not a multisig; `future_admin` is unset.
- That key can, at any time and in one transaction: set the swap fee up to 50% (`set_new_fee`, `MAX_FEE` 5e9 of 1e10, no delay; a fork test set it and a 1,000 USDC quote fell from 1,000.14 to 500.09 AUSD), ramp A up or down by at most 10x over at least a day (`ramp_A`, `stop_ramp_A`), change the price oracle's averaging window (`set_ma_exp_time`), and through the factory redirect admin fees (`set_fee_receiver`) or hand over the admin role.
- Admin fees (50% of swap fees) go to the factory's `fee_receiver`, `0x193110Ce1542d7371e1515BD6A2E470fDefc310D`, a Curve.Fi `Vault` whose owner is the same EOA; `withdraw_admin_fees` is callable by anyone and pays only that vault.
- There is no pause or kill switch (`kill_me` and `is_killed` do not exist) and no admin path to liquidity: deposits and withdrawals stay open to LPs, so the risk to Trendr users is price, not custody.
- Current parameters: fee 0.005% (5e5), off-peg multiplier 10, admin fee 50%, A 1,000 (no ramp), all three coins at rate 1e30 (plain 6-decimal tokens).

So every conversion carries a minimum out from a fresh quote, never below 0.99 AUSD per USDC, and the app refuses to convert while the pool pays less (a raised fee shows up there first).

**In the app.**
Once a deposit lands, the deposit page shows the account's USDC with the pool's quote and converts all of it in one passkey prompt: `usdcToAusdCalls` in `@trendr/contracts` approves exactly the amount to the pool and calls `exchange(1, 0, amount, minOut, account)`, where `minOut` is the quote less 0.3% and never under 0.99 AUSD per USDC (`conversionMinOut`).
It is an owner (passkey) batch, not a session trade: a session key's daily limit counts only AUSD leaving the account, so a session allowed to swap could sell every USDC deposit at any price, and sessions carry exactly the standard trading permissions.
The relayer sponsors it on Mainnet only, and only exactly: `approve` on USDC with the pool as spender, and on the pool only `exchange` from USDC (index 1) to AUSD (index 0) with a minimum out above zero and the account as receiver; any other USDC or pool call, and the same calls from a session, are refused before any gas (`apps/relayer/src/policy.ts`).
On a Mainnet fork, through the real relayer and a fresh PasskeyAccount, 25 USDC converted to 24.997 AUSD with 284,447 gas used and a 344,530 limit (about 0.035 MON), the account holding no MON and no allowance left (`apps/relayer/test/e2e.mainnet-fork.test.ts`).
`curveSwapCalls` in this package builds the same pair for Intents Connect steps and other venues' comparisons.
Kuru Flow (entrypoint `0xb3e6778480b2E488385E8205eA05E20060B813cb`, selector `0xce1e7030`) also works from the session with the calldata its API returns, but its ABI is unpublished, so it cannot be an Intents Connect step and a session permission cannot check its recipient.
USDT0 deposits can convert in the same pool (coin index 2), so a USDT0 deposit does not need a USDC hop.

## Intents Connect for Monad

Monad is a supported source and destination, and Monad USDC, USDT0 and MON appear in both the `in` and `out` token lists.
An EVM step is `{ to, functionSignature, parameters, value, metadata }`; the service ABI-encodes the parameters, runs the steps in order from the intermediary, appends a USDC fee transfer, and rejects step sets that never call the destination token.
On a bridge-in the recipient is always the intermediary, so the final destination (the Trendr account) goes inside a step: the pool's `receiver`, OutcomeMarkets `mint(seriesId, amount, to)` or AttentionPerp `openFor(owner, ...)`.
`planBridgeIn` runs the documented three rounds: a dry create without steps for the gross minimum, a dry create with steps for the measured fee and the post-fee minimum, then steps rebuilt at that minimum (less a 10 bps reserve) for the live create.
The live dry run for 20 USDC from Base gave a guaranteed 19.89 USDC, a network fee of 0.0021 USDC (stable pool recipe; 0.0029 USDC for the Kuru recipe), a spend of 19.87 USDC and at least 19.81 AUSD, about 37 seconds.
Those planned steps, simulated on Mainnet from the intermediary credited with the bridged USDC, paid 19.874 AUSD to the Trendr account.
The dry run priced the Kuru recipe as well even though that market is paused, so a dry run does not prove the steps succeed; simulate them as the live test does.
`checkCreatedExecution` then checks the live create before the user signs: the quote still covers the spend (`QUOTE_MOVED` otherwise), our steps are echoed unchanged plus exactly one fee transfer in USDC, and the payload is for this wallet, unexpired and in the expected signing standard.

**What gets signed.**
The origin wallet signs `details.payload.payload_json` verbatim with EIP-191 `personal_sign`, and the API takes `secp256k1:` plus base58 of `r || s || v` with v as 0 or 1 (`toIntentsSignature`).
The payload is a NEAR Intents message to `intents.near`: `signer_id` (the wallet), a nonce, a deadline, and one `auth_call` per destination transaction asking the chain-signatures proxy (`proxy-signer-dev.near` in every payload seen) to sign a 32-byte digest for the intermediary derived from the wallet (`path`).
The service checks the signature with ecrecover against `signer_id`, so it must be an EOA signature; ERC-1271 and the passkey's own P-256 signature are not accepted.
In the recommended flow the user's source wallet (MetaMask, Phantom, and so on) is the origin, and the Trendr account is only the recipient, so the passkey signs nothing.
When the Trendr account itself is the origin (for example an out-operation from Monad), it signs with its EIP-7702 EOA key, which Mera derives from the passkey's PRF output; that is one passkey ceremony and the same key that signed the 7702 delegation.
Deleting an execution (to free the one-per-wallet lock) signs the literal `delete_execution:{executionId}` the same way.

**What it cannot do today.**
- AUSD is not a 1Click asset, so every recipe bridges USDC and swaps on Monad.
- Kuru's AUSD/USDC book is soft-paused, so the Kuru recipe would end `OPERATION_FAILED`; use the stable pool venue.
- OutcomeMarkets and AttentionPerp are not on Mainnet yet, so the mint and perp recipes are encoded and tested but cannot run until Trendr deploys there.
- Perpl accounts belong to `msg.sender` (`createAccount`, `depositCollateral`), so an intermediary cannot open a Perpl position for the Trendr account.
- A wallet can have one live execution at a time (HTTP 409 until it finishes or is deleted).
- The signing payloads name `proxy-signer-dev.near`, and the API reference does not say whether the steps and the fee transfer execute atomically.
- There is no Monad Testnet support, so every end-to-end run is on Mainnet.

## Fees

Trendr's integrator fee is set per key in Aurora's Client Portal, at most 500 bps.
Trendr keeps 60% of it, and Aurora takes 40% but at least 2 bps on stablecoin swaps and 10 bps on others (`feeSplit`).
Quotes for Trendr's key carried a single 2 bps app fee, which is Aurora's floor on a stablecoin route, so the key's integrator fee is currently 0 and Trendr earns nothing.
Fees accrue per swap, and Aurora can configure Fees Collection to pay them out in one asset (USDC recommended) to one address once they reach 1,000 USD.
Other costs the user sees: the withdraw fee to Monad (about 0.00066 USDC, already in `amountOut`), the refund fee if refunded, the Intents Connect network fee on Monad (about 0.002 to 0.003 USDC), and the stable pool's swap fee.

## Rate limits

Limits are per key and per endpoint: 100 requests per 10 seconds and 2,000 per hour, and rejected requests count toward the hourly quota.
The client waits out `Retry-After` on HTTP 429 (a rejected request is not processed, so even a live quote is safe to retry), adds backoff and jitter, and surfaces an hourly block as `AuroraRateLimitError` instead of sleeping for an hour.
Network errors, timeouts and 5xx are retried only for idempotent calls (reads, dry runs, deposit submission and persistent address creation), never for a live quote or a live execution.
The token list is cached for five minutes and status is polled at 6 seconds, as Aurora asks.

## Verified live

All of this was read-only or a dry run, against Monad Mainnet and Aurora's production APIs on 2026-10-09 and 2026-10-10.
No live quote, execution or persistent address was created, nothing was signed, and no funds moved.

- The token list (202 tokens on 36 chains) and the three Monad assets.
- Dry quotes into Monad USDC from Base, Arbitrum (exact input and exact output), Solana, Ethereum (ETH) and Bitcoin, all four swap types, and the documented error shapes (minimum amount 0.15 USDC, invalid refund address, unknown key, `ANY_INPUT` with `ORIGIN_CHAIN`).
- Time estimates of 27 to 49 seconds from EVM chains on 2026-10-09 and about 30 minutes on 2026-10-10, and 13 minutes from Bitcoin, so the app must show the live estimate.
- The status shape of a real live quote (a public, unfunded Aurora test quote), unknown-address errors, incidents and transaction history.
- Persistent address creation: HTTP 403 for Trendr's key, so nothing was created.
- Intents Connect: supported tokens, intermediary derivation, quote-backed dry runs of both AUSD recipes, a steps-only dry run of the sweep, executions listing (including real signing payloads) and the 401 without a key.
- Kuru's market parameters, state, book and a reverting swap simulation; the stable pool's coins, balances and quotes; a simulated exchange paying a receiver; and the planned recipe simulated end to end on Monad.

## Checked with the first Mainnet deposits

- A live quote and a funded deposit, to see `KNOWN_DEPOSIT_TX`, `PROCESSING` and `SUCCESS` with real Monad transaction hashes.
- A deliberately short deposit, to see `INCOMPLETE_DEPOSIT` and the refund transaction and reason as Aurora reports them.
- A live Intents Connect create, a signature from an EVM wallet and a deposit, to run a recipe on chain and confirm the fee transfer and step atomicity.
- A persistent address (after Aurora enables it for the key) and a deposit to it, including a failed one to learn where refunds go.

## Open questions for Aurora and Kuru

- Persistent addresses: enable them for Trendr's key, and say where a failed persistent-address swap's funds go.
- Intents Connect: are the steps and the fee transfer one atomic transaction, is `proxy-signer-dev.near` the production signer, and can a pending steps-only execution hold a wallet's lock indefinitely (one was still `OPERATION_PENDING` after seven weeks on a test wallet).
- Kuru: why AUSD/USDC is soft-paused, and whether the Kuru Flow entrypoint ABI can be published.
- The stable pool: its admin is a single EOA that can raise the fee to 50% instantly; ask whoever runs the factory (Curve or a Monad partner) whether the admin moves to a multisig with a timelock.

## Commands

- Unit tests (recorded fixtures, no network): `cd packages/aurora && bun install && bun test`
- Typecheck: `cd packages/aurora && bunx tsc --noEmit`
- Live dry runs: `cd packages/aurora && AURORA_API_KEY=... bun run test:live`
- The in-app conversion on a Mainnet fork (needs anvil and forge): `cd apps/relayer && RELAYER_MAINNET_FORK=1 bun test test/e2e.mainnet-fork.test.ts` (`MONAD_MAINNET_RPC_URL` and `MAINNET_FORK_BLOCK` optional).
- Re-record fixtures: `cd packages/aurora && AURORA_API_KEY=... bun run record` (add `RECORD_PERSISTENT=1` only once the key is approved, since that creates a real, unfunded address)
