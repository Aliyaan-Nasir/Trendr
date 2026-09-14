# The keeper. Build from the repository root, which holds the local packages it depends on:
#   docker build -f apps/keeper/Dockerfile .
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
COPY apps/keeper/package.json apps/keeper/bun.lock apps/keeper/
WORKDIR /repo/apps/keeper
RUN bun install --frozen-lockfile --production
COPY apps/keeper/src src

ENV NODE_ENV=production
USER bun
EXPOSE 4200
CMD ["bun", "src/index.ts"]
