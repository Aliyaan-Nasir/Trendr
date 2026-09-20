# Trendr top-up

Keeps every Trendr sending wallet (oracle broadcaster, keeper, relayer keys, market maker, Autopilot bot, backend faucet) funded with MON from one treasury wallet.
Monad bills the full gas limit, so these wallets burn MON steadily (Testnet: oracle about 21 MON a day, market maker 12, keeper 7) and each service goes unhealthy below its own `MIN_BALANCE`.

## How it decides

- Every `CHECK_INTERVAL_SEC` it reads the treasury and every target, and refills a target that is below `min` up to `target` (nothing happens between the two).
- Targets are served in the order `TARGETS` lists them; when the treasury runs short, the first one it cannot fully cover gets what is left and the rest wait.
- The treasury never goes below its floor: `TREASURY_RESERVE_MON` plus Monad's reserve balance (`MONAD_RESERVE_MON`, 10 MON on Monad), because a transfer that leaves the sender under 10 MON reverts and still pays gas.
- One key sends, one transfer at a time: each transfer is simulated, sent with exactly 21000 gas to a plain wallet or an estimated limit (capped at `DELEGATED_GAS_CAP`) to one with code such as an EIP-7702 delegation, and counts as funded only once its receipt succeeds.
- A target waits `COOLDOWN_SEC` after a transfer, and a failed transfer backs off from 2 minutes doubling to an hour.
- `maxPerTransfer` and `maxPerDay` (a rolling 24 hours) cap each target; a capped target alerts once and resumes as the window moves.
- More than `MAX_REFILLS_PER_HOUR` full refills in an hour means a drain or a bug: the target is halted, alerts once, and stays halted until released with `POST /targets/<name>/release` and `Authorization: Bearer $ADMIN_TOKEN`.
- Alerts (log, plus Slack or Discord with `ALERT_WEBHOOK_URL`) fire once per condition, remind at 15 minutes doubling to 12 hours while it holds, and send one recovery note.
  A low treasury stays alerted until it can cover one more refill of every target, so a partial refill does not flap it.
  Before that, a runway alert fires when the treasury lasts fewer than `RUNWAY_ALERT_DAYS` days at the burn observed over the last day.
- Every transfer is written to the ledger before it is sent, so a crash mid-send still counts toward the caps and the cooldown.

## State

With `DATABASE_URL`, the ledger, halts and alert state live in one row of its own table (`topup_state`, created idempotently), and only the holder of a Postgres advisory lock sends, so a rolling deploy never runs two senders.
Use a direct session connection, not a transaction pooler, for that lock.
Without it, state goes to `STATE_FILE` (written atomically), which suits one local instance; in a container it is lost with the container unless a volume is mounted at `/data`.
Postgres is the choice for a hosted deploy: caps and alert state survive redeploys without a volume.

## Endpoints

- `GET /live`: 200 while the process serves; the platform's deploy check.
- `GET /health`: the treasury balance, floor, burn and runway in days at the observed burn, each target's balance, state and caps, and active alerts; 503 when the treasury is below its floor or checks stop succeeding.
- `POST /targets/<name>/release`: resumes a halted target (off unless `ADMIN_TOKEN` is set).

## Commands

```sh
bun install
bun run test          # unit tests; the Postgres store test needs TEST_DATABASE_URL
bun run test:e2e      # Anvil end to end (needs anvil)
DRY_RUN=1 bun run start   # logs what it would send, keeps its own state, sends nothing
```

## Deploying

The image builds from the repository root because the service depends on `packages/chain` (`docker build -f apps/topup/Dockerfile .`).
Set `TREASURY_PRIVATE_KEY` through the platform's secret store, never in a file that is uploaded or committed.

Service settings: health check path `/live` with a 120 second timeout, restart always, and 30 seconds of draining so a transfer in flight settles.
Keep one replica; a second one would only stand by on the lock, which also makes the brief overlap of a redeploy safe.
The deploy check uses `/live`, not `/health`: a deploy check runs only at deploy time, and a treasury awaiting funds must not block a deploy.
No public domain is needed; add one only to watch `/health` from outside.

| Variable | Needed | Notes |
|---|---|---|
| `TREASURY_PRIVATE_KEY` | yes | From the platform's secret store; never in a file that is uploaded or committed. |
| `CHAIN_ID`, `RPC_URL` | yes | `RPC_URLS` adds endpoints to load-balance across. |
| `TARGETS` | yes | `name:address:min:target:maxPerTransfer:maxPerDay` in MON, highest priority first. |
| `DATABASE_URL` | recommended | A direct Postgres connection (see State). |
| `ALERT_WEBHOOK_URL` | recommended | Slack or Discord. |
| `ADMIN_TOKEN` | recommended | Enables releasing a halted target; at least 24 characters. |
| `ALLOW_MAINNET` | Mainnet only | `1`; see `.env.mainnet.example` for Mainnet caps. |
| Tuning | no | `CHECK_INTERVAL_SEC`, `TREASURY_RESERVE_MON`, `MONAD_RESERVE_MON`, `COOLDOWN_SEC`, `MAX_REFILLS_PER_HOUR`, `MIN_TRANSFER_MON`, `RUNWAY_ALERT_DAYS`, `DELEGATED_GAS_CAP`, `RPC_MAX_RPS`, `LOG_LEVEL`. |

Set `PORT` (4500), `CHAIN_ID` (10143) and `RPC_MAX_RPS` (5) on the service as well; the image sets `STATE_FILE`.
Fund the treasury before or after deploying: until it holds more than its floor, `/health` reports 503 and a low-treasury alert fires once.
