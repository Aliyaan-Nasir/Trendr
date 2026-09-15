# The backend API. Build from the repository root, which holds the local packages it depends on:
#   docker build -f backend/Dockerfile .
# It applies every migration (each is idempotent) before it listens.
FROM oven/bun:1.4.2-slim

WORKDIR /repo
# Local file: dependencies are copied into the app's node_modules together with their own
# node_modules (viem, zod), so each one is installed and complete before the app installs.
COPY packages/aurora/package.json packages/aurora/bun.lock packages/aurora/
RUN cd packages/aurora && bun install --frozen-lockfile --production
COPY packages/aurora/src packages/aurora/src
COPY packages/autopilot/package.json packages/autopilot/bun.lock packages/autopilot/
RUN cd packages/autopilot && bun install --frozen-lockfile --production
COPY packages/autopilot/src packages/autopilot/src
COPY packages/chain/package.json packages/chain/bun.lock packages/chain/
RUN cd packages/chain && bun install --frozen-lockfile --production
COPY packages/chain/src packages/chain/src
COPY packages/contracts-ts/package.json packages/contracts-ts/bun.lock packages/contracts-ts/
RUN cd packages/contracts-ts && bun install --frozen-lockfile --production
COPY packages/contracts-ts/src packages/contracts-ts/src
COPY packages/perpl/package.json packages/perpl/bun.lock packages/perpl/
RUN cd packages/perpl && bun install --frozen-lockfile --production
COPY packages/perpl/src packages/perpl/src
COPY backend/package.json backend/bun.lock backend/
WORKDIR /repo/backend
RUN bun install --frozen-lockfile --production
COPY backend/src src

ENV NODE_ENV=production
USER bun
EXPOSE 4000
CMD ["bun", "src/index.ts"]
