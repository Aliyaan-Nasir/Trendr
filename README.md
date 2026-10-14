<div align="center">

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="assets/readme/hero-light.png">
  <source media="(prefers-color-scheme: light)" srcset="assets/readme/hero-dark.png">
  <img src="assets/readme/hero-light.png" width="960" alt="Trendr: trade what the world is talking about. An attention index card reads 72.40, up 8.6% in 24 hours, with UP at 0.64 and DOWN at 0.36 AUSD.">
</picture>

### Trendr turns what the internet is talking about into markets you can trade from any device, on Monad.

<a href="https://trendr.bid"><img src="https://img.shields.io/badge/Website-trendr.bid-6E54FF?style=for-the-badge" alt="Website"></a> <a href="https://app.trendr.bid"><img src="https://img.shields.io/badge/Launch%20app-app.trendr.bid-836EF9?style=for-the-badge" alt="Launch app"></a> <a href="https://x.com/trendrnow"><img src="https://img.shields.io/badge/X-@trendrnow-6E7681?style=for-the-badge&logo=x&logoColor=white" alt="X"></a> <a href="#deployed-contracts-on-monad-testnet"><img src="https://img.shields.io/badge/Contracts-Monadscan-4C4496?style=for-the-badge" alt="Contracts"></a>

<img src="https://img.shields.io/badge/Monad-Testnet%20live-6E54FF?style=flat-square" alt="Monad Testnet live"> <img src="https://img.shields.io/badge/contracts-verified-2EA043?style=flat-square" alt="Contracts verified"> <img src="https://img.shields.io/badge/Mainnet-waitlist%20open-D29922?style=flat-square" alt="Mainnet waitlist open"> <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-3DA639?style=flat-square" alt="MIT license"></a>

<img src="https://img.shields.io/badge/Solidity-5E5E5E?style=flat-square&logo=solidity&logoColor=white" alt="Solidity"> <img src="https://img.shields.io/badge/Foundry-6E7681?style=flat-square" alt="Foundry"> <img src="https://img.shields.io/badge/Chainlink%20CRE-375BD2?style=flat-square&logo=chainlink&logoColor=white" alt="Chainlink CRE"> <img src="https://img.shields.io/badge/Next.js-555555?style=flat-square&logo=nextdotjs&logoColor=white" alt="Next.js"> <img src="https://img.shields.io/badge/Bun-F9F1E1?style=flat-square&logo=bun&logoColor=black" alt="Bun"> <img src="https://img.shields.io/badge/PostgreSQL-4169E1?style=flat-square&logo=postgresql&logoColor=white" alt="PostgreSQL"> <img src="https://img.shields.io/badge/Envio-FF5A1F?style=flat-square" alt="Envio"> <img src="https://img.shields.io/badge/TypeScript-3178C6?style=flat-square&logo=typescript&logoColor=white" alt="TypeScript">

<sub>Built for Monad Metropolis, Track 01</sub>

<a href="#what-is-trendr">Overview</a> · <a href="#try-it">Try it</a> · <a href="#features">Features</a> · <a href="#how-it-works">How it works</a> · <a href="#deployed-contracts-on-monad-testnet">Contracts</a> · <a href="#mainnet-ready">Mainnet</a> · <a href="#run-it-locally">Run it locally</a> · <a href="#tests">Tests</a>

</div>

https://github.com/user-attachments/assets/88de66c4-3c00-44a9-a875-8f4a582881d3

<div align="center">

<a href="https://youtu.be/sdKZvvC8EGU"><img src="https://img.shields.io/badge/Watch-Technical%20demo-FF0000?style=for-the-badge&logo=youtube&logoColor=white" alt="Watch the technical demo"></a> <a href="https://youtu.be/VmYvADNbI5k"><img src="https://img.shields.io/badge/Watch-Pitch-FF0000?style=for-the-badge&logo=youtube&logoColor=white" alt="Watch the pitch"></a>

</div>

## What is Trendr

A radar watches X, Telegram, Bluesky, CoinGecko, GeckoTerminal and Wikipedia for topics that are taking off, and an AI review decides automatically which become trends.
A Chainlink CRE workflow measures each trend's attention from Elfa, GDELT, Wikipedia, Nansen, Bluesky and Hacker News and writes a 0 to 100 attention index to Monad.
Every trend then gets markets on that index: Up/Down outcome series on Kuru, attention perps and a trend coin on a bonding curve, next to Perpl perps on the underlying asset.
Users sign up with a passkey, never see a seed phrase or a gas fee, and trade with one prompt a week thanks to guarded session keys.
The contracts are live and verified on Monad Testnet, and the app, the website and every service behind them are hosted and running against them.

## Try it

| Where | Link |
|---|---|
| **App** | [app.trendr.bid](https://app.trendr.bid), on a phone, tablet or computer (Monad Testnet) |
| **Website** | [trendr.bid](https://trendr.bid) |
| **Technical demo** | [youtu.be/sdKZvvC8EGU](https://youtu.be/sdKZvvC8EGU): the whole app, end to end |
| **Pitch** | [youtu.be/VmYvADNbI5k](https://youtu.be/VmYvADNbI5k): the problem, the product and the business |
| **Status** | [app.trendr.bid/status](https://app.trendr.bid/status): the services, the oracle's freshness and the chain head |
| **API** | [api.trendr.bid/v1/trends](https://api.trendr.bid/v1/trends): the live trends and their index |

In about two minutes:

1. Open the app and choose **Sign in**, then **Create account**: one passkey prompt creates the account and a week-long trading session, with no gas to pay.
2. Choose **Add funds**, then **Get test AUSD** for Testnet AUSD from the faucet.
3. Open any trend and buy **Up** or **Down**, open an attention perp, or buy its trend coin; each trade confirms in about a second with a Monadscan link.
4. Watch **Portfolio** value the positions live, post a call on the trend, or set up an **Autopilot** rule and backtest it.

## Features

| Feature | What it does |
|---|---|
| <sub>**TRADE&nbsp;ATTENTION**</sub> | |
| **Up/Down series on Kuru** | Fully collateralized UP and DOWN tokens per trend for 24 hours and 7 days, each with one canonical Kuru order book against AUSD; a complete set always redeems for 1 AUSD. |
| **Attention perps** | Isolated-margin perps on the index itself, up to 3x, with per-block funding from long/short skew. |
| **Trend coins** | One coin per trend on a constant-product bonding curve whose floor ratchets with peak attention, graduating to its own Kuru market. |
| **Perpl perps** | Trade the asset behind a trend (BTC, ETH, SOL, MON and more) on Perpl from the same account. |
| <sub>**AUTOMATE&nbsp;AND&nbsp;FOLLOW**</sub> | |
| **Autopilot** | Rules like "attention up 40% in 4 hours and smart money buying, go long 3x" that open Perpl positions with stop-loss, take-profit and loss limits, backtested on the real index history. |
| **Copy&#8209;trading** | Follow Perpl leaders with ratio or fixed margin, a leverage cap, a daily loss cap and slippage protection. |
| <sub>**SOCIAL**</sub> | |
| **Calls** | Public Up or Down predictions on a trend, signed by a caller identity that stays unlinkable from the trading account, ranked by hit rate on a leaderboard. |
| **Curation reward** | The account that first surfaced a trend earns a share of its perp and curve fees, on chain in `CurationFees`. |
| **Share cards** | Images for calls and for PnL, where attention-perp results are verified from the on-chain close event. |
| <sub>**ACCOUNT&nbsp;AND&nbsp;DEVICES**</sub> | |
| **Mera passkeys** | One passkey derives the account, its trading session key, a caller identity, a vault key and a Perpl API key. |
| **Gas-free** | A relayer pays for every allowlisted Trendr call. |
| **PWA and push** | Installable on phone and desktop, with Web Push for Autopilot and copy-trading activity, calls and markets. |
| **Any&#8209;chain deposits** | Aurora Intents brings value from about 35 chains into AUSD (Mainnet, see [docs/aurora.md](docs/aurora.md)). |
| **Mainnet waitlist** | An email form in the app and on the website; nothing is sent until Mainnet launches. |

## How it works

### System architecture

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="assets/readme/architecture-light.png">
  <source media="(prefers-color-scheme: light)" srcset="assets/readme/architecture-dark.png">
  <img src="assets/readme/architecture-light.png" width="960" alt="System architecture. Top row: signals (Elfa, Bluesky, Wikipedia, GDELT, Nansen, and Hacker News as a boost) feed the backend radar and collector; the radar also reads what is trending on Elfa, Bluesky, CoinGecko and GeckoTerminal, each candidate reviewed by Gemini, OpenAI or Kimi, and the backend passes candidates and readings to the Chainlink CRE workflow, which sends a signed report to TrendRegistry on Monad. Middle row: the Trendr PWA sends a signed batch to the relayer, which executes it on the EIP-7702 PasskeyAccount, which trades on the markets (Up/Down on Kuru, attention perps, trend coins, Perpl perps). TrendRegistry feeds the markets the index and settlement. Bottom: keeper, market maker, Autopilot, top-up, Envio indexer and admin panel keep the markets running.">
</picture>

Trends start in the **backend** radar: Elfa trending tokens, CoinGecko's most-searched coins, GeckoTerminal's trending pools, Bluesky's trending topics, Wikipedia's most-read articles and pasted links become candidates, reviewed by Gemini, then OpenAI, then Kimi, and approved or rejected automatically.
The backend collector reads each trend's attention from Elfa, GDELT, Wikipedia, Nansen, Bluesky and Hacker News at the pace each source allows.
The **CRE workflow** pulls the approved queue, measures it and decides under consensus which candidates become trends; only its forwarder can write to `TrendRegistry`.
Bun **services** run everything around the contracts: the keeper opens, lists, settles, liquidates and graduates, the market maker quotes Kuru from the first block, Autopilot trades rules and copies, top-up refills every service wallet, and the Envio indexer builds portfolios and track records.

### A trade's life

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="assets/readme/trade-life-light.png">
  <source media="(prefers-color-scheme: light)" srcset="assets/readme/trade-life-dark.png">
  <img src="assets/readme/trade-life-light.png" width="960" alt="A trade's life in six steps on one track: 1 the passkey signs once and Mera derives the account and a session key (7 days, 500 AUSD a day); 2 the session key signs each trade in the browser with no prompt; 3 the relayer checks policy and budgets and pays the gas; 4 the PasskeyAccount on Monad checks expiry, scope, guard and the gross daily limit; 5 the trade routes through TrendrSpot on Kuru or PerplOrderGuard on Perpl; 6 a toast confirms it with a Monadscan link and the indexer updates the portfolio.">
</picture>

One passkey prompt creates the account and a session key; from then on the session key signs each trade in the browser, the relayer pays the gas, and the account on chain checks the session's expiry, scope, price guard and daily limit before the trade reaches Kuru or Perpl.

### From attention to an index

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="assets/readme/index-pipeline-light.png">
  <source media="(prefers-color-scheme: light)" srcset="assets/readme/index-pipeline-dark.png">
  <img src="assets/readme/index-pipeline-light.png" width="960" alt="From attention to an index: sources (Elfa mentions, Bluesky mentions, GDELT articles, Wikipedia views, Nansen net flow, and Hacker News mentions as a boost only) are read by the backend collector at each API budget's pace; the Chainlink CRE workflow clips, deseasonalizes and log-scales them, renormalizes weights and takes the median across nodes; TrendRegistry stores the index with 6 decimals as checkpoints; the keeper opens 24 hour and 7 day Up/Down series that settle on the first observation after expiry, or void after 2 days.">
</picture>

The index method, with every formula and budget, is in [apps/cre-oracle/docs/index-method.md](apps/cre-oracle/docs/index-method.md).
Until Chainlink grants deploy access, Testnet runs the same workflow with `cre workflow simulate --broadcast` every minute through Chainlink's MockKeystoneForwarder, and the registry trusts only that broadcaster.

### Accounts and guards

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="assets/readme/security-light.png">
  <source media="(prefers-color-scheme: light)" srcset="assets/readme/security-dark.png">
  <img src="assets/readme/security-light.png" width="960" alt="Accounts and guards: a session key's call passes gate 1 (expiry and a target and selector allowlist), gate 2 (price guards: TrendrSpot within 0.10 AUSD of the attention value, PerplOrderGuard within 2% of a fresh mark with a 10x cap) and gate 3 (a gross daily AUSD limit that inflows never offset). The passkey owner, verified on chain through the P256 precompile, grants sessions and alone can withdraw, add margin, trade coins and limit orders, grant Autopilot keys, upgrade and approve follows. The relayer and backend add activation tickets, gas budgets and a batch policy.">
</picture>

A session key can only make allowlisted calls at anchored prices within a gross daily limit, and everything that moves funds out, changes a session or grants Autopilot a key needs the passkey itself; the full list is under [Security model](#security-model).

## Deployed contracts on Monad Testnet

Chain id 10143, start block 69452198, addresses from [contracts/deployments/10143.json](contracts/deployments/10143.json).
Every Trendr contract is verified on Monadscan and Sourcify, ownerless and non-upgradeable ([contracts/README.md](contracts/README.md)).

| Contract | Role | Address |
|---|---|---|
| TrendRegistry | Trends, index checkpoints and settlement values; only the CRE forwarder writes | [`0xa24F779B6ae73bD7d6d1a2fE47B9EF9EA7bD805c`](https://testnet.monadscan.com/address/0xa24F779B6ae73bD7d6d1a2fE47B9EF9EA7bD805c) |
| OutcomeMarkets | UP/DOWN tokens per trend and window, complete sets for 1 AUSD | [`0x8eaa2Dd6B3890Ead77BA9f555378eD11310C3EBF`](https://testnet.monadscan.com/address/0x8eaa2Dd6B3890Ead77BA9f555378eD11310C3EBF) |
| OutcomeListing | The canonical Kuru market of each UP and DOWN token | [`0x774AffCB8f4B095100B3C46bF562214BF30e9E7E`](https://testnet.monadscan.com/address/0x774AffCB8f4B095100B3C46bF562214BF30e9E7E) |
| AttentionPerp | Isolated-margin perps on the index | [`0xeEC85F72e63EE5DAF66d285182241244110E0C84`](https://testnet.monadscan.com/address/0xeEC85F72e63EE5DAF66d285182241244110E0C84) |
| BondingCurve | Trend coins on curves | [`0x597e4ad49b2430Ed8D4543eb46f94189231534DF`](https://testnet.monadscan.com/address/0x597e4ad49b2430Ed8D4543eb46f94189231534DF) |
| KuruGraduationVenue | Lists a graduated coin on Kuru and seeds its vault | [`0x7D9e0b3145882e513Ee24D912DB1f4479DDBC7d3`](https://testnet.monadscan.com/address/0x7D9e0b3145882e513Ee24D912DB1f4479DDBC7d3) |
| CurationFees | Fee share for the account that surfaced a trend | [`0x529d9B1e685BD943053Dc356D40a368639646168`](https://testnet.monadscan.com/address/0x529d9B1e685BD943053Dc356D40a368639646168) |
| PasskeyAccount v2 | EIP-7702 delegate: passkey owner, guarded sessions, gross daily limit | [`0xa3023591e43085c782444937F96f2B82E98B2524`](https://testnet.monadscan.com/address/0xa3023591e43085c782444937F96f2B82E98B2524) |
| PerplOrderGuard | Session Perpl orders within 2% of mark, at most 10x | [`0xC102deFE8E35dE8B73016CAe9806141456f2d09b`](https://testnet.monadscan.com/address/0xC102deFE8E35dE8B73016CAe9806141456f2d09b) |
| TrendrSpot | Kuru spot routing through canonical markets only | [`0x8daBA0D411D3530819B5FD1520A79050c0FEb374`](https://testnet.monadscan.com/address/0x8daBA0D411D3530819B5FD1520A79050c0FEb374) |
| TrendrLens | Batched read-only views for the oracle, keeper and app | [`0xC7171c3cfe1efFBBa8e387334a03231267121d5A`](https://testnet.monadscan.com/address/0xC7171c3cfe1efFBBa8e387334a03231267121d5A) |
| AUSD (external, Agora) | Settlement collateral | [`0xa9012a055bd4e0eDfF8Ce09f960291C09D5322dC`](https://testnet.monadscan.com/address/0xa9012a055bd4e0eDfF8Ce09f960291C09D5322dC) |
| Kuru Router (external) | Kuru market deployment and swaps | [`0x7EFbE105Ca7415dE98F96622173458ac1c054630`](https://testnet.monadscan.com/address/0x7EFbE105Ca7415dE98F96622173458ac1c054630) |
| Perpl Exchange (external) | Perpl perpetuals | [`0x1964C32f0bE608E7D29302AFF5E61268E72080cc`](https://testnet.monadscan.com/address/0x1964C32f0bE608E7D29302AFF5E61268E72080cc) |
| CRE MockKeystoneForwarder (external, Chainlink) | Delivers the oracle's reports to TrendRegistry | [`0xB9F79d863261869B234c481D1f9A7af84AeAd192`](https://testnet.monadscan.com/address/0xB9F79d863261869B234c481D1f9A7af84AeAd192) |
| Treasury (Testnet wallet) | Receives protocol fees | [`0xda55F7263b7e4D9B36b2F542EEC99fc3b5Dfae7a`](https://testnet.monadscan.com/address/0xda55F7263b7e4D9B36b2F542EEC99fc3b5Dfae7a) |

## Mainnet ready

Trendr is built and rehearsed for Monad Mainnet: the full deploy runs every night on a fork of Mainnet with the real AUSD, Kuru, Perpl, Chainlink CRE forwarders and the P256 precompile, and the Mainnet configs, Aurora deposits and service settings are already in the code.
Next, Trendr keeps running on Testnet while it onboards its first users from the waitlist into a beta, then goes live on Mainnet one product at a time: the contracts and the oracle first, then attention perps, trend coins, Perpl trading and Aurora deposits, and Up/Down on Kuru last, since Kuru's Safe deploys each series' markets.
[docs/mainnet.md](docs/mainnet.md) has the runbook, the measured MON budget and what the rehearsal found.

## Tech stack

| Layer | Tools |
|---|---|
| **Chain** | Monad (Testnet 10143, Mainnet 143), AUSD settlement, EIP-7702 accounts with the P256 precompile |
| **Contracts** | Solidity 0.8.30, Foundry, OpenZeppelin, Slither |
| **Oracle** | Chainlink CRE TypeScript SDK (QuickJS WASM), Bun |
| **App and admin** | Next.js 16, React 19, Tailwind CSS 4, viem, Mera passkeys, Lightweight Charts |
| **Website** | Next.js 15 |
| **Backend and services** | Bun, Hono, viem, Postgres, zod |
| **Indexer** | Envio HyperIndex, HyperSync for history and RPC at the head |
| **Hosting** | Railway for the services and Postgres, Vercel for the app, admin panel and website, Cloudflare DNS |

## Repository map

| Path | What it holds |
|---|---|
| [`contracts/`](contracts) | Foundry contracts with unit, fuzz, fork and invariant suites, deploy scripts and the Testnet address book |
| [`apps/cre-oracle/`](apps/cre-oracle) | The Chainlink CRE workflow behind the attention index |
| [`apps/relayer/`](apps/relayer), [`apps/keeper/`](apps/keeper), [`apps/market-maker/`](apps/market-maker), [`apps/autopilot/`](apps/autopilot), [`apps/topup/`](apps/topup) | The services around the contracts: gas sponsor, keeper, Kuru market maker, Autopilot executor and wallet top-up |
| [`backend/`](backend) | Radar, collectors, AI review, auth, social, push, faucet and the admin system view |
| [`indexer/`](indexer) | Envio HyperIndex for portfolios, leaderboards and track records |
| [`frontend/`](frontend), [`admin/`](admin), [`landing-page/`](landing-page) | The app, the admin panel and the website |
| [`packages/`](packages) | Shared TypeScript: contract bindings, chain helpers, Perpl, Autopilot and Aurora |
| [`docs/`](docs) | Mainnet runbook, Aurora deposits and the Kuru notes for attention contracts |

## Security model

| Guard | What it does |
|---|---|
| **Guarded sessions** | A session key expires (7 days by default, at most 30 through the relayer) and can only call allowlisted targets and selectors, optionally with a pinned recipient. |
| **Price guards** | `TrendrSpot` refuses session trades more than 0.10 AUSD from the attention-implied value, and `PerplOrderGuard` refuses orders more than 2% from a Perpl mark older than two minutes, or above 10x. |
| **Gross daily limit** | Every call's AUSD outflow counts against the session's daily limit, and inflows never offset it. |
| **Owner only** | Withdrawals, adding margin, trend coins, limit orders, Perpl cancels, new sessions and Autopilot keys need the passkey, verified on chain. |
| **Owner approvals** | Following a trader, enabling an Autopilot rule and linking a caller identity need a passkey signature over a single-use backend nonce. |
| **Activation tickets** | The relayer pays to activate a new account only with a backend-signed ticket, limited per IP and per hour. |
| **Relayer budgets** | Gas per account per day, total gas per hour, activations per hour and a cooldown after repeated reverts. |
| **Autopilot keys** | A Perpl-only session key, sealed in the browser to the executor's public key; the API stores only ciphertext. |
| **Audits and tests** | Slither in CI (fails on medium), 32 planted mutations that the suite must catch, 5 invariant suites with 32 invariants and coverage reporting (`INVARIANT_COVERAGE=true`), and a nightly Mainnet fork rehearsal. |

## Run it locally

**Prerequisites**: Bun 1.4.2, Node 22.15 or newer, pnpm 10.7, Foundry 1.8.1, Postgres, and the CRE CLI 1.35.0 signed in with `cre login` for the oracle.
Each service needs its own Testnet key with some MON.

**Environment**: copy every `.env.example` to `.env` (`.env.local` in `frontend/` and `admin/`) and fill in the keys.
The backend example names three databases: `trendr`, `trendr_test` and `trendr_envio`.

**Start order**, after `bun install` (or `pnpm install` for the indexer and oracle, `npm ci` for the web apps) in each folder:

| Order | Service | Command | Port |
|---|---|---|---|
| 1 | Postgres | your local server | 5432 |
| 2 | Backend (runs migrations on start) | `cd backend && bun run dev` | 4000 |
| 3 | Indexer | `cd indexer && pnpm start` | 9898 (health) |
| 4 | Relayer | `cd apps/relayer && bun run dev` | 4100 |
| 5 | Keeper | `cd apps/keeper && bun run dev` | 4200 |
| 6 | Market maker | `cd apps/market-maker && bun run dev` | 4300 |
| 7 | Autopilot | `cd apps/autopilot && bun run dev` | 4400 |
| 8 | Top-up | `cd apps/topup && bun run dev` | 4500 |
| 9 | Oracle loop | `cd apps/cre-oracle && pnpm setup && pnpm cre:loop` | |
| 10 | App | `cd frontend && npm run dev` | 3000 |
| 11 | Admin | `cd admin && npm run dev` | 3001 |

The landing page also defaults to port 3000, so run it on its own or with `-p`.

**Other commands**

```bash
cd contracts && forge build && forge test          # contracts
cd packages/contracts-ts && bun run generate       # after a contract change, then bun install in each service
cd apps/cre-oracle && pnpm cre:simulate            # one dry run; add --broadcast for a real Testnet report
cd backend && npx tsc --noEmit                     # backend typecheck
cd frontend && npm run build                       # app production build
```

## Tests

Counted from a run of each suite on 2026-10-13; the live suites ran against the hosted app at app.trendr.bid.

| Suite | Tests |
|---|---|
| contracts | 207 forge tests: unit, fuzz and invariants, plus 4 fork rehearsal tests (Testnet and Mainnet forks) and 32 planted mutations |
| backend | 286 |
| relayer | 95, plus 10 end-to-end on Anvil |
| aurora | 99, plus 6 against live Aurora APIs |
| CRE oracle | 73 |
| topup | 52, plus 3 end-to-end on Anvil |
| autopilot | 32 |
| indexer | 24 |
| market maker | 22 |
| keeper | 20 |
| packages | 86 (`autopilot` 29, `contracts-ts` 31, `chain` 19, `perpl` 7) |
| frontend | 80 unit tests; 16 Playwright on Anvil; live Testnet Playwright suites: trend 1, live 6, portfolio 17 |
| admin | 26 Playwright |

CI runs every component's suite on each push (contracts, backend, app, admin, website, indexer, oracle, Aurora, relayer, keeper, market maker, Autopilot and top-up), a scan for verified secrets, and a nightly Mainnet fork rehearsal ([.github/workflows](.github/workflows)).

## Sources and credits

| Partner | Used for |
|---|---|
| [Monad](https://www.monad.xyz) | The chain |
| [Chainlink CRE](https://docs.chain.link/cre) | The attention index workflow |
| [Kuru](https://www.kuru.io) | Order books for outcome tokens and graduated coins |
| [Perpl](https://perpl.xyz) | Perpetuals and the trading API |
| [Agora AUSD](https://www.agora.finance) | Settlement collateral |
| [Aurora Intents](https://aurora.dev) | Any-chain deposits |
| [Envio](https://envio.dev) | The indexer |
| [Mera](https://www.npmjs.com/package/@category-labs/mera) | Passkey accounts |
| [Elfa](https://www.elfa.ai) | Mentions on X and Telegram, and trending topics |
| [Wikimedia pageviews](https://wikitech.wikimedia.org/wiki/Data_Platform/AQS/Pageviews) | Article views and most-read lists |
| [Nansen](https://www.nansen.ai) | Smart-money flows |
| [GDELT](https://www.gdeltproject.org) | Worldwide news coverage |
| [Bluesky](https://docs.bsky.app) | Posts and trending topics |
| [Hacker News](https://hn.algolia.com/api) | Stories and comments, through Algolia's search API |
| [CoinGecko](https://www.coingecko.com) and [GeckoTerminal](https://www.geckoterminal.com) | Most-searched coins and trending pools for the radar |
| [Gemini](https://ai.google.dev), [OpenAI](https://platform.openai.com) and [Kimi](https://platform.moonshot.ai) | Candidate review |
| Claude and Codex | AI coding tools that helped build Trendr |

Demo activity: a few project-owned Testnet accounts made test transactions so the markets, leaderboards and threads show the product in use.

Built by aliyaan.

## License

MIT, see [LICENSE](LICENSE).
