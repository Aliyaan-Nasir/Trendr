#!/bin/sh
# Starts the oracle loop in a container (apps/cre-oracle/Dockerfile).
#
# `cre workflow simulate` needs a signed-in CRE CLI. CRE_API_KEY does that headlessly once the
# account has deploy access. Until then the CLI uses a browser session from `cre login`, kept in
# ~/.cre/cre.yaml, which the CLI refreshes in place: CRE_SESSION_B64 (base64 of that file, from a
# login made for this container alone) seeds it, and a volume at /data keeps the refreshed session
# across restarts. A new CRE_SESSION_B64 replaces the kept session; an unchanged one leaves it be.
set -eu

mkdir -p /data/cre
if [ -z "${CRE_API_KEY:-}" ] && [ -n "${CRE_SESSION_B64:-}" ]; then
  # .seed remembers the seed already applied (it holds what cre.yaml holds, beside it).
  if [ "$CRE_SESSION_B64" != "$(cat /data/cre/.seed 2>/dev/null || true)" ]; then
    umask 077
    printf '%s' "$CRE_SESSION_B64" | base64 -d > /data/cre/cre.yaml.tmp
    mv /data/cre/cre.yaml.tmp /data/cre/cre.yaml
    printf '%s' "$CRE_SESSION_B64" > /data/cre/.seed
    echo '{"level":"info","msg":"seeded the CRE CLI session from CRE_SESSION_B64"}'
  fi
fi

target="${CRE_TARGET:-testnet}"
# The workflow reads the backend's collector and candidate queue at the URLs in its config, which
# point at localhost for local runs: ORACLE_BACKEND_URL (the backend's public https origin) replaces
# them in this container's copy.
if [ -n "${ORACLE_BACKEND_URL:-}" ]; then
  bun scripts/sync-config.ts --target "$target" --backend "$ORACLE_BACKEND_URL"
fi

# The CLI reads keys from .env when present and from the environment otherwise.
set -- --target "$target"
if [ -n "${LOOP_EVERY_SEC:-}" ]; then set -- "$@" --every "$LOOP_EVERY_SEC"; fi
exec bun scripts/loop.ts "$@"
