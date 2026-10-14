# Trendr CRE oracle

A Chainlink CRE workflow that measures attention for every live trend, discovers new trends, and sends one signed report per run to TrendRegistry on Monad.
The index formula is in [docs/index-method.md](docs/index-method.md).

<a href="https://youtu.be/jtUkh8LfNBA"><img src="https://img.shields.io/badge/Watch-Chainlink%20CRE%20demo-FF0000?style=for-the-badge&logo=youtube&logoColor=white" alt="Watch the Chainlink CRE demo"></a>

## Run

```bash
cp .env.example .env          # add the broadcaster key and any source keys
pnpm setup                    # bun install in attention-index/
pnpm test && pnpm typecheck
pnpm cre:simulate             # dry run against Monad Testnet
pnpm cre:simulate --broadcast # real Testnet transaction through the MockKeystoneForwarder
pnpm cre:loop                 # broadcast every minute, standing in for the DON on Testnet
```

On Testnet the registry accepts reports only when the transaction comes from its trusted broadcaster, so `CRE_ETH_PRIVATE_KEY` must be that key.
Testnet reads every source through the backend collector (free API keys cannot answer every run), so the backend must be running and `CRE_BACKEND_TOKEN` must equal its `ORACLE_TOKEN`.
Sources in direct mode without a key are skipped.
After a broadcast, check the forwarder's `ReportProcessed` result or the registry's `lastRunId`, because the forwarder does not revert when `onReport` fails.

## Mainnet

After a deploy, `pnpm sync-config --target mainnet --backend https://api.trendr.bid` writes the registry and lens from `contracts/deployments/143.json` (and the collector and candidate URLs) into `config.mainnet.json`; `--check` only verifies.
Mainnet runs every minute with a 12 minute heartbeat (Testnet: 7 minutes), inside the registry's 15 minute staleness limit even when one run fails; `scripts/targets.test.ts` checks that against `Deploy.s.sol`.
While the Mainnet registry runs in mock mode, `CONFIRM_MAINNET=yes pnpm cre:loop:mainnet` broadcasts in place of the DON from `.env.mainnet` (see `.env.mainnet.example`), never from `.env`.
It refuses to run before the deploy, on a production-mode registry, or with a config that does not match the deployment.
`pnpm cre:simulate:mainnet` dry-runs the Mainnet config with the same `.env.mainnet`.
In production mode the CRE DON reports instead (`cre workflow deploy attention-index --target mainnet`); `docs/mainnet.md` has the runbook.

## Container

`Dockerfile` (built from the repository root) runs the same loop as `pnpm cre:loop`, with the CRE CLI pinned and the workflow compiled at build time.
`scripts/container-start.sh` seeds the CLI session from `CRE_SESSION_B64` (or uses `CRE_API_KEY`) on a volume at `/data`, and rewrites the collector and candidate URLs to `ORACLE_BACKEND_URL` (https://api.trendr.bid in production).
With `PORT` set (4600 in production) the loop serves `GET /live` for the deploy check and `GET /health`, which fails once runs stop succeeding.

## Layout

- `attention-index/main.ts`: cron trigger and handler wiring.
- `attention-index/src/workflow.ts`: one run, from chain reads to the report.
- `attention-index/src/measure.ts`, `src/sources/`: node-mode measurement and the API adapters.
- `attention-index/src/plan.ts`: sampling, deviation and heartbeat decisions.
- `attention-index/config.testnet.json`, `config.mainnet.json`: per-network settings.
- `scripts/loop.ts`, `scripts/sync-config.ts`, `scripts/health.ts`: the broadcast loop, the config sync and the loop's HTTP endpoints.
