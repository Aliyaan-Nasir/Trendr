# The top-up service. Build from the repository root, which holds the local package it depends on:
#   docker build -f apps/topup/Dockerfile .
FROM oven/bun:1.4.2-slim

WORKDIR /repo
# @trendr/chain is a local file: dependency (../../packages/chain). Bun resolves it to its real
# path, so its own imports (viem) resolve from packages/chain/node_modules, as in development.
COPY packages/chain/package.json packages/chain/bun.lock packages/chain/
RUN cd packages/chain && bun install --frozen-lockfile --production
COPY packages/chain/src packages/chain/src
COPY apps/topup/package.json apps/topup/bun.lock apps/topup/
WORKDIR /repo/apps/topup
RUN bun install --frozen-lockfile --production
COPY apps/topup/src src

# State goes to Postgres when DATABASE_URL is set; otherwise to this file (mount a volume at /data
# to keep it across deploys).
RUN mkdir -p /data && chown bun:bun /data
ENV NODE_ENV=production STATE_FILE=/data/topup-state.json
USER bun
EXPOSE 4500
CMD ["bun", "src/index.ts"]
