# Attention contracts on Kuru

This note describes the asset class Trendr brings to Kuru's spot order book, how it is issued, settled and redeemed, how its markets get liquidity from the first block, the legal and operational posture, and the roadmap.
Everything described as live runs on Monad Testnet today; addresses are in `contracts/deployments/10143.json`.

## The asset class

An attention contract is a fully collateralized binary claim on whether public attention to a topic rises.
For every trend and window (24 hours and 7 days) there is a pair of ERC-20 tokens, UP and DOWN.
UP pays 1 AUSD if the trend's attention index at expiry is above its level when the series opened; DOWN pays 1 AUSD otherwise, including a tie.
The price of UP is therefore the market's probability that attention to the topic grows over the window.

Examples of underlyings: a company (topic:openai), an event (topic:world-cup), a token narrative (crypto:mon), a person or a cultural moment.
None of these has a tradable instrument today, and none can be priced from a traditional market.

## Who it is for

The first user is the narrative trader: someone who already trades on attention by following X and Telegram, and today expresses a view on a narrative by buying a memecoin or a major on momentum.
They want to trade the narrative itself, with a defined maximum loss, from their phone.
An UP or DOWN token gives exactly that: the most a position can lose is what was paid for it, and the payoff depends only on attention, not on a token's liquidity or a team's behaviour.

Secondary users are market makers and arbitrageurs (the complete-set structure gives them a riskless anchor, below) and teams that want to hedge or measure attention to their launch.

## Issuance and redemption

Tokens are created only by `OutcomeMarkets.mint`, which takes exactly 1 AUSD per complete set (one UP and one DOWN).
`redeemSets` burns a complete set for exactly 1 AUSD at any time before or after settlement.
After settlement, `redeemWinnings` pays 1 AUSD per winning token; a void series pays 0.5 AUSD per token of either side.
AUSD backs every outstanding set at all times; the invariant is checked by stateful fuzzing (`OutcomeInvariants`) and a planted bug that breaks it is caught.

There is no issuer discretion: the contracts are ownerless and non-upgradeable, every parameter is fixed at deployment, and nobody can mint unbacked tokens, pause redemptions or change a settled outcome.

## Settlement source

The attention index is computed by a Chainlink CRE workflow (`apps/cre-oracle`) from Elfa (X and Telegram), Bluesky posts, GDELT news coverage, Wikipedia pageviews and, for crypto trends, Nansen smart-money flows, with Hacker News as a boost.
The method is documented in `apps/cre-oracle/docs/index-method.md`: each source is normalized, clipped and deseasonalized, then weighted.
Every node computes the index independently and the values are aggregated by median consensus before a single signed report reaches `TrendRegistry` on Monad.
The registry clamps any single move, rejects stale or replayed reports, and records every observation as a checkpoint.

A series settles on the first observation at or after its expiry, if it arrives within the settlement tolerance (10 minutes on Testnet, 15 on Mainnet).
If no observation arrives in time, anyone can settle it as void after two days and every token redeems for half.
If a trend is retired before expiry, its series settle at the final index.
Settlement needs no trusted party: `OutcomeMarkets.settle` is permissionless and reads the registry.

## Market structure on Kuru

Each UP and each DOWN token has exactly one canonical Kuru market against AUSD, recorded in `OutcomeListing`.
Parameters are fixed for prices between 0 and 1 AUSD: 0.001 AUSD price steps, 0.01 token sizes, a one-token minimum order, a 10 basis point taker fee and no maker fee.
On Testnet `OutcomeListing.list` deploys both markets through the Kuru Router when a series opens; the keeper does this for every 24 hour and 7 day series.
On Kuru Mainnet, where only Kuru deploys markets, Kuru deploys them with the same parameters and anyone records them with `OutcomeListing.adopt`, which checks the pair and every parameter through the Router.

Trades from the app go through `TrendrSpot`, which routes only through these canonical markets and requires a minimum output, so a user's trading session can never route funds through a market someone else controls.

## Liquidity and initial market formation

The complete set is the anchor: an UP and a DOWN together are always worth exactly 1 AUSD.
That makes the two books of a series one market, and it gives liquidity providers a riskless hedge that ordinary spot markets lack.

Trendr runs a market maker from the first block of every series (`apps/market-maker`, live on Testnet):

- It mints inventory as complete sets (100 sets per series on Testnet) and quotes both sides of both books.
- It prices UP as the probability that the index ends above its opening level, from the trend's own history in the registry's checkpoints, so quotes move with attention and with time to expiry.
- Its quotes start 3 cents either side of fair value with a second level a cent further out, skew against net inventory, and stop adding to a side at the inventory limit.
- Its asks on UP and DOWN always sum to more than 1 AUSD and its bids to less, so it never offers a complete set below its redemption value.
- It takes any complete-set arbitrage other traders leave (buying both sides below 1 AUSD and redeeming, or minting and selling both above), which keeps the books consistent with each other.
- It pulls its quotes five minutes before expiry, on a stale index or on a kill switch, and after settlement withdraws and redeems everything.

Initial market formation for a new series follows the same order every time: the oracle observes the trend, the keeper opens the series and lists its two markets, the market maker mints inventory and quotes, and users can trade within seconds of the series opening.

Planned capital at Mainnet launch is 2,000 to 5,000 AUSD per day of active series, from the protocol treasury, sized so that each book shows at least 20 tokens a side within 3 cents of fair value.
Third-party makers are welcome on equal terms: the books are ordinary Kuru markets, fair value is computable from public on-chain data, and complete sets give every maker the same hedge.
Protocol fees from perps and curves fund the market making budget; outcome trading on Kuru pays Kuru's own fees and nothing to Trendr.

## Legal and operational posture

This section records how the product is designed; it is not legal advice, and the launch plan includes review by counsel in each target jurisdiction.

Design choices that matter:

- Fully collateralized: every token is backed 1:1 by AUSD held by an ownerless contract; there is no leverage, no margin call and no counterparty credit risk in the outcome tokens.
- No securities exposure in the underlying: the contracts reference a published attention index, not the price, performance or profits of any company or asset.
- Documented, deterministic settlement source: the index method is public, the oracle is decentralized through CRE consensus, and settlement rules (including ties, voids and retirement) are fixed in code.
- No custody: users hold tokens in their own passkey accounts; Trendr cannot move user funds.

Operational controls planned for Mainnet:

- Geofencing of the app (not of the contracts) for jurisdictions where event contracts on attention are restricted, including the United States until a regulated route exists.
- Sanctions screening of addresses at the app and relayer, which already decides which transactions it sponsors.
- Topic policy, already live: no series on individuals' private lives, on violence or on tragedies; the AI review checks every candidate against it automatically before a trend is listed.
- Terms of use and in-app risk disclosure stating the maximum loss, the settlement source and the void and retirement rules before the first trade.
- Monitoring and alerts on oracle staleness, keeper lag and market maker inventory, with a kill switch for the market maker.

## Roadmap

- Now (Testnet): canonical markets listed automatically, market maker quoting every listed series, gas-free trading from passkey accounts, settlement live.
- Mainnet launch: Kuru-deployed canonical markets recorded by `adopt`, a funded market maker on the 24 hour and 7 day windows, and geofenced access.
- Next: more windows (1 hour for fast-moving events), more sources in the index (such as YouTube), range contracts (attention above a level, not just above the open), and a maker program with shared fee rebates.
- Later: native Android and iOS apps, more venues for the same contracts, and an attention data API for teams.

Targets for the first quarter after Mainnet launch: 20 active trends at any time, 50,000 AUSD of weekly outcome volume on Kuru, at least two independent makers, and spreads under 4 cents on every listed book.
