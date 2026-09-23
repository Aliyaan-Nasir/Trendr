# Trendr app

The Trendr trading app, live on Monad Testnet.
People sign in with a passkey (Mera, EIP-7702) and trade attention: Up/Down outcome series on Kuru, attention perps, trend coins on bonding curves and Perpl perps, with gas paid by the Trendr relayer.
It also hosts Autopilot rules, copy trading, the portfolio, social calls and the public status page.
Built with Next.js 16, React 19 and Tailwind CSS 4.
The [root README](../README.md) explains the project as a whole.

## Setup

```bash
npm ci
cp .env.example .env.local
```

Every `NEXT_PUBLIC_` value is inlined at build time, so set them before building.
Leave optional values commented out rather than empty: an empty value replaces the default.

| Variable | Meaning |
|---|---|
| `NEXT_PUBLIC_CHAIN_ID` | 10143 (Testnet, the default) or 143 (Mainnet); contract addresses come from `@trendr/contracts`. |
| `NEXT_PUBLIC_BACKEND_URL` | The Trendr API, called by the browser and by the share pages on the server. |
| `NEXT_PUBLIC_RELAYER_URL` | The relayer that pays gas for activation and trades. |
| `NEXT_PUBLIC_APP_URL` | The app's own origin, for metadata, share links and share cards. |
| `NEXT_PUBLIC_RPC_URLS` | Optional read endpoints, comma-separated; reads fall over from one to the next. |
| `NEXT_PUBLIC_WS_URLS` or `NEXT_PUBLIC_WS_URL` | Optional head stream endpoints; a dropped stream moves to the next. |
| `NEXT_PUBLIC_PASSKEY_RP_ID` | Optional passkey relying party; defaults to the page's host. In production it is the registrable domain (`trendr.bid`) and never changes. |
| `NEXT_PUBLIC_TRENDR_BOT_ADDRESS` | Optional Autopilot bot wallet; required on Mainnet. |

Mainnet values are in `.env.mainnet.example`; `docs/mainnet.md` has the runbook.

## Commands

```bash
npm run dev           # http://localhost:3000
npm run build
npm run start
npm run lint
npx tsc --noEmit
npm test              # unit tests (Bun)
```

A second dev server needs its own build directory: `NEXT_DIST_DIR=.next-3002 npx next dev -p 3002`.

## Browser tests

`npx playwright test` runs the specs against a local stack (`e2e/stack.ts`).

The live specs run against Monad Testnet and the running backend and relayer.
Each run signs up new passkey accounts, which the relayer pays for in Testnet MON.
Run them against a production build, because a dev server reloads the page whenever a file changes:

```bash
NEXT_DIST_DIR=.next-e2e npm run build
NEXT_DIST_DIR=.next-e2e npx next start -p 3003
E2E_BASE_URL=http://localhost:3003 npx playwright test -c playwright.live.config.ts
E2E_BASE_URL=http://localhost:3003 npx playwright test -c playwright.trend.config.ts
E2E_BASE_URL=http://localhost:3003 npx playwright test -c playwright.portfolio.config.ts
```

`E2E_BACKEND_URL`, `E2E_RPC_URL`, `E2E_TREND` and `E2E_FUNDER_PRIVATE_KEY` (a Testnet wallet with AUSD, for the Perpl step) tune the trend spec.

## Layout

- `app/`: routes.
- `src/features/`: one folder per screen (home, trend, portfolio, autopilot, copy, leaders, callers, deposit, settings, status, share).
- `src/lib/account/`: passkey accounts, sessions and the relayer client.
- `src/lib/trade/`: transaction calls, reads and `useTx`.
- `src/lib/api/`: the backend client, which signs in again on a 401 and explains a 429 with when to try again.
- `src/lib/chain/`: the read client with RPC failover and the head stream.
