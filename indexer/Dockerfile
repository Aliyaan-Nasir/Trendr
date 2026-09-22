# The Envio indexer. Build from the repository root, like every service image:
#   docker build -f indexer/Dockerfile .
# `envio start` needs Node and Postgres only: no Docker and no Hasura (`envio dev` is the command
# that starts containers, and it is never used here).
FROM node:22.22.1-slim

RUN npm install -g pnpm@10.7.0
WORKDIR /app
RUN chown node:node /app
USER node
COPY --chown=node:node indexer/package.json indexer/pnpm-lock.yaml indexer/pnpm-workspace.yaml ./
# The envio patch (README.md, "Following the head"): gaps go to HyperSync, the realtime RPC keeps the head.
COPY --chown=node:node indexer/patches patches
# Node strips the handlers' types itself; typescript (a dev dependency) would only add envio's
# optional handler type check to every start, which CI already runs.
RUN pnpm install --frozen-lockfile --prod
COPY --chown=node:node indexer/config.yaml indexer/schema.graphql indexer/tsconfig.json indexer/envio-env.d.ts ./
COPY --chown=node:node indexer/src src
# `envio start` runs codegen again on every start, so .envio/ stays writable by node.
RUN pnpm codegen

# Plain logs, no Hasura, and a schema of its own (`envio start --restart` drops ENVIO_PG_SCHEMA).
# NODE_ENV stays unset: with NODE_ENV=production envio also demands Hasura's endpoint and secret
# and its write throttles, even with Hasura off. Set every ENVIO_PG_* variable explicitly instead,
# because their development fallbacks (port 5433, no TLS) are wrong for a hosted database.
ENV ENVIO_TUI=false ENVIO_HASURA=false ENVIO_PG_SCHEMA=indexer
EXPOSE 9898
# /healthz and /metrics listen on the platform's PORT. Never add --restart here: it drops the schema
# and resyncs from the start block.
CMD ["sh", "-c", "ENVIO_INDEXER_PORT=${ENVIO_INDEXER_PORT:-${PORT:-9898}} exec node_modules/.bin/envio start"]
