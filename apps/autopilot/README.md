# Trendr Autopilot executor

The service that runs Autopilot rules and copy-trading on Perpl.
A rule reads like a sentence: when a trend's attention jumps, optionally with smart money confirming, open a Perpl position with a stop-loss, a take-profit, a maximum hold and loss caps.
The app backtests a rule on the real index history before it can be enabled, and the user's passkey grants Autopilot a Perpl-only session key, sealed in the browser to this executor's public key.
The executor watches the index, opens and closes positions within those limits, and mirrors a followed trader's Perpl positions onto followers within their own caps.
It trades through Perpl's signed API or directly on the exchange contract, under the same rules, and every session order passes `PerplOrderGuard` on chain.
The rule engine and copy settings live in [`packages/autopilot`](../../packages/autopilot), and the [root README](../../README.md) explains the project as a whole.

<a href="https://vimeo.com/1235662103"><img src="https://img.shields.io/badge/Watch-Perpl%20demo-1AB7EA?style=for-the-badge&logo=vimeo&logoColor=white" alt="Watch the Perpl demo"></a>

## Run

```bash
bun install
bun run dev        # health on port 4400
bun run test
bun run typecheck
```

Copy `.env.example` to `.env` and fill in the keys first.
