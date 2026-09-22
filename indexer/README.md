# Trendr indexer

An [Envio HyperIndex](https://docs.envio.dev/docs/HyperIndex/overview) indexer that turns Trendr's on-chain activity on Monad into Postgres tables the backend reads directly.
History and every later gap come from HyperSync, so nothing is paged over RPC.
At the head it follows new blocks over RPC (`ENVIO_RPC_URL_10143`), because Monad makes 2.5 blocks a second and a free HyperSync token's budget is about 15 requests a minute.
Fallback RPCs (`ENVIO_RPC_FALLBACK_URL_10143`, then `ENVIO_RPC_LAST_RESORT_URL_10143`) take over when that RPC stalls.
[Following the head](#following-the-head) explains the envio patch this relies on.

## What it indexes

- TrendRegistry: trends, every attention index observation, status changes, settlement values and CRE oracle runs.
- OutcomeMarkets (current and previous Testnet deployments): series, mints, set redemptions, settlement and winnings.
- UP, DOWN and trend coin ERC-20s, registered dynamically from `SeriesOpened` and `CurveCreated`, for balances and holders.
- OutcomeListing and KuruGraduationVenue: the Kuru market of every Trendr token, registered dynamically, with its orders and fills.
- Kuru's Router: market parameters (`MarketRegistered`) and routed swaps, plus TrendrSpot swaps, so routed fills are credited to the account that swapped.
- AttentionPerp: positions, top ups, closes, liquidations, socialized losses and funding marks.
- BondingCurve: curves, trades, floor raises and graduation.
- CurationFees: accruals and claims.
- PasskeyAccount `Initialized`, matched on every address (wildcard), which identifies Trendr accounts (EIP-7702 EOAs).
  Any contract can emit the same event, so an address counts only if its code at that block delegates to a PasskeyAccount implementation listed in `src/lib/constants.ts` (one cached `eth_getCode` per account).
- Perpl's Exchange: accounts, collateral, positions and fills of Trendr accounts (passkey accounts and the Trendr bot wallets in `src/lib/constants.ts`) only.

Derived entities: `Account` (unified portfolio), `AccountStats` (track record and leaderboard), `AccountDayData`, `TrendStats` (volume per product, open interest, holders, funding rate), `TrendDayData` (daily volume, index candle and open interest), `TrendAccount`, `CurationEarnings`, `TrendCuration` and `Protocol` totals.
Units are documented at the top of `schema.graphql`.

## Run locally (no Docker, no Hasura)

Requirements: Node 22.15 or later, pnpm 10, and a Postgres database (locally the shared Homebrew Postgres, database `trendr_envio`).

```bash
cd indexer
pnpm install
cp .env.example .env   # then fill in ENVIO_API_TOKEN and the ENVIO_PG_* values
pnpm codegen
pnpm start             # envio start: migrates the database, syncs to the head and keeps following it
pnpm resync            # drop the indexer schema and resync from the start block
```

`envio start` is the production entry point and needs no Docker.
`ENVIO_HASURA=false` turns Hasura off, and `ENVIO_TUI=false` gives plain logs.
`envio dev` is not used because it starts Postgres and Hasura in Docker.
Health is served on `http://localhost:9898/healthz` and Prometheus metrics on `/metrics`.

Checks:

```bash
pnpm codegen && pnpm typecheck && pnpm format:check && pnpm test
```

Tests use Envio's `createTestIndexer` with simulated events and an in-memory store, so they need no network or database.

## Following the head

Envio switches a chain to realtime mode once it first catches up and records that in `envio_chains.ready_at`, which survives restarts.
Unpatched, realtime mode sends every query to the `for: realtime` RPC, gaps included: after a restart or an outage the RPC pages the backlog ten blocks per `eth_getLogs` plus a block read for nearly every block (Perpl's Exchange logs in most of them), which runs slower than the chain.
On 2026-10-12 that left the indexer 121,000 blocks (about 10 hours) behind, crawling at about 16 blocks a minute against Monad's 150, with the provider's 429s pushing queries onto HyperSync in 1 to 15 block slices that exhausted the free token as well.
Nor can HyperSync follow the head on its own: Envio polls once per partition per new block, the free token allows 15 requests a minute, and partitions already at the head starve the ones still catching up.

`patches/envio@3.14.0.patch` (applied by pnpm through `pnpm-workspace.yaml`) makes a query that starts more than 200 blocks behind the newest known height pick its source as a backfill does: HyperSync first, the RPCs as fallbacks.
Queries nearer the head use the realtime RPC and fail over to the fallback RPCs only, never to HyperSync, whose budget a few blocks would waste.
The threshold (80 s of blocks) is above the 60 s a rate-limited HyperSync request waits, so the gap that wait leaves goes back to the RPC.
HyperSync is used only for gaps, where one request covers about 3,000 blocks even through Perpl's volume; on 2026-10-12 it closed a 70,000 block gap in about 5 minutes.
An Envio upgrade must carry the patch forward (pnpm refuses to install when it no longer applies) or replace it with an upstream equivalent.

### Request volume

Following the head costs about 20 RPC requests a second (measured 20.6 on 2026-10-13, about 53M a month), far beyond any free tier:

- Envio sends one `eth_getLogs` per configured contract (13) for every range, on every new height it sees (15 a second).
- It reads most blocks with logs twice (Perpl's Exchange logs in nearly every block): 4.5 a second.
- It polls the height about once a second.

`polling_interval` does not change this, and the RPC client that fans out per contract is native code, so `ENVIO_RPC_URL_10143` needs an endpoint with that much capacity.

Envio fails over between RPCs in config order and never shares load between them, so when the head RPC stalls it moves to `ENVIO_RPC_FALLBACK_URL_10143` (default Monad Foundation's `rpc-testnet.monadinfra.com`), then `ENVIO_RPC_LAST_RESORT_URL_10143` (default Ankr's keyless endpoint).
Measured `eth_getLogs` range caps: Alchemy's free tier 10 blocks, Monad's public RPC, monadinfra, Ankr's keyless endpoint and Chainstack 100, Tatum 500, QuickNode and Ankr with a key 1,000.
`interval_ceiling: 100` suits every fallback.

Every Perpl Exchange event is fetched, not only Trendr accounts': its events carry the account id in their data (no indexed parameters), and Envio's `where` filters and the sources' log filters match only the address and indexed topics.
The handlers drop other accounts after one lookup, and nothing reads non-Trendr Perpl activity (market data comes from Perpl's API).

## Environment

| Variable | Purpose |
| --- | --- |
| `ENVIO_API_TOKEN` | HyperSync API token (required). |
| `ENVIO_PG_HOST`, `ENVIO_PG_PORT`, `ENVIO_PG_USER`, `ENVIO_PG_PASSWORD`, `ENVIO_PG_DATABASE` | Postgres connection. |
| `ENVIO_PG_SCHEMA` | Schema for the tables: `indexer`. `envio start -r` drops and recreates it, so it must not be shared with other services. |
| `ENVIO_PG_SSL_MODE` | `require` for a hosted database. |
| `ENVIO_HASURA` | `false`: no Hasura. |
| `ENVIO_TUI` | `false`: plain logs. |
| `ENVIO_INDEXER_PORT` | Port of `/healthz` and `/metrics` (default 9898). |
| `ENVIO_RPC_URL_10143` | RPC that follows the chain head. Defaults to the public Monad Testnet RPC. The cached view calls (Perpl markets, account code; `src/lib/rpc.ts`) try it first, then the public endpoints. |
| `ENVIO_RPC_URL_143` | The same for the Mainnet indexer (default: the public Monad Mainnet RPC). |
| `ENVIO_RPC_FALLBACK_URL_10143` | First fallback when the head RPC stalls (default: `https://rpc-testnet.monadinfra.com`). |
| `ENVIO_RPC_LAST_RESORT_URL_10143` | Second fallback (default: Ankr's keyless `https://rpc.ankr.com/monad_testnet`). A provider key used by nothing else keeps its quota for this. |
| `ENVIO_START_BLOCK_10143` | First block to index (default 69452198, the deployment's first block). See [Start block](#start-block). |
| `ENVIO_CONFIG` | `config.mainnet.yaml` for the Mainnet indexer (`pnpm start:mainnet` sets it). |

## Start block

`config.yaml` starts at `${ENVIO_START_BLOCK_10143:-69452198}`: by default the deployment's first block, so the full history is indexed.
A hosted indexer may start later by setting `ENVIO_START_BLOCK_10143`.
Anything created before that block (trends, series, Kuru markets, passkey account initializations, Perpl accounts, open positions) is then unknown, and events that refer to it are skipped.
Envio persists the start block, so changing it on an existing database needs `envio start --restart` (`pnpm resync`), a full resync.

## Tables

Tables live in the `indexer` schema (`ENVIO_PG_SCHEMA`), so the indexer can share a database with the backend without touching its tables.
Each entity is a table named exactly like the entity (quote it: `indexer."Trend"`), with snake_case columns.
Entities are per chain: every table has a `chain_id` column, the primary key is `(id, chain_id)`, and tables are partitioned by chain.
References are stored as `<field>_id` columns, for example `indexer."Series".trend_id`.
Addresses and ids are lowercase 0x hex.
BigInt columns are `numeric` in raw units; the `*_ausd`, `*_points` and `*_tokens` columns hold human units.
The `indexer._meta` view reports sync progress (`progressBlock`, `isReady`).

| Area | Tables |
| --- | --- |
| Trends | `Trend`, `IndexPoint`, `TrendStatusChange`, `Settlement`, `OracleRun`, `TrendStats`, `TrendDayData`, `TrendAccount` |
| Outcomes | `Series`, `Token`, `OutcomeTokenBalance` |
| Kuru | `KuruMarket`, `KuruOrder`, `KuruFill`, `SpotSwap` |
| Attention perps | `PerpPosition`, `FundingMark` |
| Curves | `Curve`, `CurveTrade`, `CoinBalance`, `Graduation` |
| Curation | `CurationAccrual`, `CurationEarnings`, `CurationClaim`, `TrendCuration` |
| Accounts | `Account`, `AccountStats`, `AccountDayData` |
| Perpl | `PerplAccount`, `PerplMarket`, `PerplPosition`, `PerplFill` |
| Totals | `Protocol` (id `trendr`) |

`KuruMarketRegistration`, `PendingRoute`, `PerplCursor`, `PerplOpenPosition` and `OutcomeCycle` are internal bookkeeping.
Tables prefixed `envio_` belong to Envio.

## Example queries

An account's portfolio summary:

```sql
select a.kind, a.outcome_holding_count, a.outcome_tokens_held, a.coin_holding_count,
       a.perp_open_position_count, a.perp_margin_locked, a.perpl_open_position_count, a.perpl_collateral,
       a.curation_claimable, s.volume_ausd, s.realized_pnl_ausd, s.win_rate
from indexer."Account" a
left join indexer."AccountStats" s on s.id = a.id and s.chain_id = a.chain_id
where a.chain_id = 10143 and a.id = lower($1);
```

Its outcome positions, marked at the last Kuru price:

```sql
select t.identifier, se.window_label, b.side, se.outcome, b.balance_tokens, b.position, b.cost_basis,
       m.last_price_ausd, b.realized_pnl_ausd
from indexer."OutcomeTokenBalance" b
join indexer."Series" se on se.id = b.series_id and se.chain_id = b.chain_id
join indexer."Trend" t on t.id = b.trend_id and t.chain_id = b.chain_id
left join indexer."KuruMarket" m on m.base_token_id = b.token_id and m.chain_id = b.chain_id
where b.chain_id = 10143 and b.account_id = lower($1) and (b.balance > 0 or b.position > 0);
```

Open attention perps and Perpl positions use `indexer."PerpPosition"` (`owner_id`, `status = 'OPEN'`) and `indexer."PerplPosition"` the same way.

Leaderboard by realized PnL:

```sql
select s.id as account, a.kind, s.realized_pnl_ausd, s.volume_ausd, s.closed_trades, s.wins, s.losses, s.win_rate
from indexer."AccountStats" s
join indexer."Account" a on a.id = s.id and a.chain_id = s.chain_id
where s.chain_id = 10143 and a.kind <> 'PROTOCOL'
order by s.realized_pnl desc
limit 50;
```

A trend's volume and open interest, then its daily buckets:

```sql
select t.identifier, s.volume_ausd, s.outcome_mint_volume, s.outcome_spot_volume, s.perp_volume, s.curve_volume,
       s.coin_spot_volume, s.perp_long_open_interest_ausd, s.perp_short_open_interest_ausd,
       s.perp_funding_rate_per_block, s.holder_count, s.trader_count
from indexer."TrendStats" s
join indexer."Trend" t on t.id = s.trend_id and t.chain_id = s.chain_id
where s.chain_id = 10143 and t.identifier = $1;

select to_timestamp(d.date)::date as day, d.volume_ausd, d.trade_count, d.index_open, d.index_high, d.index_low, d.index_close,
       d.perp_long_open_interest, d.perp_short_open_interest
from indexer."TrendDayData" d
where d.chain_id = 10143 and d.trend_id = $1
order by d.date;
```

A trend's funding history:

```sql
select f.block_number, to_timestamp(f.timestamp) as at, f.mark_points, f.funding_rate_per_block,
       f.long_qty, f.short_qty, f.cum_long, f.cum_short
from indexer."FundingMark" f
where f.chain_id = 10143 and f.trend_id = $1
order by f.block_number desc
limit 500;
```

Curation earnings by surfacer, and one surfacer's split by trend:

```sql
select e.id as surfacer, e.earned_ausd, e.claimed, e.claimable, e.accrual_count, e.trend_count
from indexer."CurationEarnings" e
where e.chain_id = 10143
order by e.earned desc;

select t.identifier, c.earned, c.accrual_count
from indexer."TrendCuration" c
join indexer."Trend" t on t.id = c.trend_id and t.chain_id = c.chain_id
where c.chain_id = 10143 and c.account_id = lower($1);
```

## Accounting rules

- Volumes are AUSD: complete-set mints, Kuru fill quote amounts, perp notional at open and at close, curve trades with fees, and Perpl notional of Trendr accounts' fills.
- Market totals count each fill once; account totals count it once for the maker and once for the taker.
- Realized PnL is cash based: perps pay out minus margin, top ups and fees; Perpl adds realized deltas and funding and subtracts fees; outcome tokens and coins use average cost, with a complete set costing half a unit per side.
- A closed trade is a round trip back to zero: a perp or Perpl position, both sides of an outcome series, or a coin.
- Routed Kuru fills (taker is Kuru's Router) are credited to the TrendrSpot or Router swap's trader at the amounts actually paid, Kuru fees included; direct takers are charged the market's taker fee on the fill.
- Perpl's `TakerOrderFilledV2` names no account; the taker's own position event comes right before it in every match, so position events of Trendr accounts leave a cursor the fill reads.
- Plain transfers move balances but not traded positions, so a holder is anyone with a wallet balance or an open traded position (which covers tokens escrowed behind Kuru orders).

## Mainnet

Mainnet (chain 143) runs as its own indexer from a generated config, so the Testnet indexer never changes or resyncs for it.
After the Mainnet deploy, `pnpm mainnet:config` reads `contracts/deployments/143.json` and writes:

- `config.mainnet.yaml`: `config.yaml`'s settings and contracts verbatim, with one chain, 143, at the deployment's addresses and start block (`ENVIO_START_BLOCK_143` may start later; Kuru's Router and Perpl's Exchange come from the deployment too).
- `src/lib/mainnet.ts`: the PasskeyAccount implementation Mainnet accounts delegate to.

Commit both with `143.json`; `pnpm mainnet:config --check` fails when they are out of date, and `pnpm test` checks them against the deployment.
Rerun it after any change to `config.yaml`'s contracts, then resync the Mainnet indexer.
Add the Mainnet Autopilot bot wallet to the 143 entry in `src/lib/constants.ts` once it exists.

Run it with its own database (or at least its own `ENVIO_PG_SCHEMA`), health port and RPC, from its own checkout or service:

```bash
pnpm mainnet:config                     # once, after the deploy
ENVIO_RPC_URL_143=https://<provider>/<key> pnpm start:mainnet    # ENVIO_CONFIG=config.mainnet.yaml envio start
ENVIO_CONFIG=config.mainnet.yaml pnpm resync                     # after a config change: resync from the start block
```

HyperSync serves chain 143 (`143.hypersync.xyz`) with the same token; a generated config with a recent start block, run against Mainnet on 2026-10-10, backfilled and reached the head within a minute.
`envio start` regenerates `.envio/types.d.ts` for the config it runs, so never start the Mainnet config in the directory of a running Testnet indexer (the types only matter to `tsc`, but the next Testnet `pnpm typecheck` would see Mainnet types until `pnpm codegen`).
The backend's Mainnet deployment reads the Mainnet indexer's database (`INDEXER_DATABASE_URL`, `INDEXER_SCHEMA`); rows carry `chain_id` 143.

## Container

The indexer runs from `indexer/Dockerfile`, built at the repository root, with the Postgres the backend also reads.

- The image installs production dependencies with the envio patch, runs codegen, sets `ENVIO_HASURA=false`, `ENVIO_TUI=false` and `ENVIO_PG_SCHEMA=indexer`, and starts `envio start` (never with `--restart`).
- The service sets `PORT` (9898), the `ENVIO_PG_*` variables from the Postgres service with `ENVIO_PG_SSL_MODE=require`, `ENVIO_RPC_URL_10143`, `ENVIO_API_TOKEN` and `ENVIO_RPC_LAST_RESORT_URL_10143`.
- Health check: `/healthz` with a 300 second timeout, since codegen and migrations run first.
- One replica, and a deploy that stops the old instance before starting the new one (a small volume does this on most platforms), because two indexers would double-count aggregates.
- The backend reads the same database (`INDEXER_SCHEMA=indexer`) with the queries above; it should treat the tables as read only.
- A schema or config change, or a new start block, needs `pnpm resync`, which resyncs from the start block.
- Mainnet is a second service with its own Postgres, run with `ENVIO_CONFIG=config.mainnet.yaml` and `ENVIO_RPC_URL_143` in place of `ENVIO_RPC_URL_10143`; the image copies only `config.yaml`, so a Mainnet image must also copy `config.mainnet.yaml`.
- A full resync spends most of its time waiting out HyperSync rate limits on a free token (about 15 requests a minute); a paid token removes most of that wait.
