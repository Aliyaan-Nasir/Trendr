# The market maker. Build from the repository root, which holds the local packages it depends on:
#   docker build -f apps/market-maker/Dockerfile .
FROM oven/bun:1.4.2-slim

WORKDIR /repo
# Local file: dependencies are copied into the app's node_modules together with their own
# node_modules (viem), so each one is installed and complete before the app installs.
COPY packages/chain/package.json packages/chain/bun.lock packages/chain/
RUN cd packages/chain && bun install --frozen-lockfile --production
COPY packages/chain/src packages/chain/src
COPY packages/contracts-ts/package.json packages/contracts-ts/bun.lock packages/contracts-ts/
RUN cd packages/contracts-ts && bun install --frozen-lockfile --production
COPY packages/contracts-ts/src packages/contracts-ts/src
COPY apps/market-maker/package.json apps/market-maker/bun.lock apps/market-maker/
WORKDIR /repo/apps/market-maker
RUN bun install --frozen-lockfile --production
COPY apps/market-maker/src src

# The order ids it rests on Kuru live in STATE_FILE (Kuru cannot list orders by owner): losing the
# file strands those orders, so mount a volume at /data to keep it across deploys.
RUN mkdir -p /data && chown bun:bun /data
ENV NODE_ENV=production STATE_FILE=/data/mm-state.json
USER bun
EXPOSE 4300
CMD ["bun", "src/index.ts"]
