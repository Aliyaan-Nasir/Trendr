-- Trend Autopilot, copy-trading and attention history. Re-applied on every start: idempotent.

-- TrendRegistry checkpoints (attention index history), mirrored for charts and backtests.
CREATE TABLE IF NOT EXISTS index_points (
  trend_id      TEXT             NOT NULL,
  observed_at   BIGINT           NOT NULL,
  points        DOUBLE PRECISION NOT NULL,
  PRIMARY KEY (trend_id, observed_at)
);
-- How many of a trend's checkpoints are mirrored (checkpoints are append-only).
CREATE TABLE IF NOT EXISTS index_sync (
  trend_id      TEXT        PRIMARY KEY,
  identifier    TEXT        NOT NULL,
  synced        INTEGER     NOT NULL DEFAULT 0,
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Rules. The owner is the account address; the bot's rules belong to the bot wallet.
CREATE TABLE IF NOT EXISTS autopilot_rules (
  id            BIGSERIAL   PRIMARY KEY,
  owner         TEXT        NOT NULL,
  rule          JSONB       NOT NULL,
  rule_hash     TEXT        NOT NULL,
  status        TEXT        NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'enabled', 'paused', 'stopped')),
  -- api: the Trendr bot through Perpl's signed API; session: a user's account through a granted session key.
  venue         TEXT        NOT NULL CHECK (venue IN ('api', 'session')),
  backtest_id   BIGINT,
  status_reason TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS autopilot_rules_owner ON autopilot_rules (owner, updated_at DESC);
CREATE INDEX IF NOT EXISTS autopilot_rules_enabled ON autopilot_rules (status) WHERE status = 'enabled';

CREATE TABLE IF NOT EXISTS autopilot_backtests (
  id            BIGSERIAL   PRIMARY KEY,
  owner         TEXT        NOT NULL,
  rule          JSONB       NOT NULL,
  rule_hash     TEXT        NOT NULL,
  result        JSONB       NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS autopilot_backtests_owner ON autopilot_backtests (owner, created_at DESC);

-- Session keys accounts granted to Autopilot: Perpl-only permissions with a daily AUSD cap. The
-- private key is sealed to the executor's public key; the API server cannot open it.
CREATE TABLE IF NOT EXISTS autopilot_grants (
  owner         TEXT        PRIMARY KEY,
  session_key   TEXT        NOT NULL,
  sealed_key    TEXT        NOT NULL,
  status        TEXT        NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'active', 'revoked', 'expired')),
  valid_until   BIGINT      NOT NULL DEFAULT 0,
  daily_limit   NUMERIC     NOT NULL DEFAULT 0,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Positions Autopilot or copy-trading opened. A rule has at most one position not closed.
CREATE TABLE IF NOT EXISTS autopilot_positions (
  id            BIGSERIAL        PRIMARY KEY,
  owner         TEXT             NOT NULL,
  rule_id       BIGINT,
  follow_id     BIGINT,
  market        TEXT             NOT NULL,
  side          TEXT             NOT NULL CHECK (side IN ('long', 'short')),
  status        TEXT             NOT NULL CHECK (status IN ('opening', 'open', 'closing', 'closed', 'failed')),
  size          DOUBLE PRECISION NOT NULL DEFAULT 0,
  entry_price   DOUBLE PRECISION,
  margin_ausd   DOUBLE PRECISION NOT NULL DEFAULT 0,
  leverage      DOUBLE PRECISION NOT NULL DEFAULT 1,
  opened_at     TIMESTAMPTZ,
  closed_at     TIMESTAMPTZ,
  exit_price    DOUBLE PRECISION,
  pnl_ausd      DOUBLE PRECISION,
  fees_ausd     DOUBLE PRECISION NOT NULL DEFAULT 0,
  close_reason  TEXT,
  signal        JSONB            NOT NULL DEFAULT '{}',
  created_at    TIMESTAMPTZ      NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ      NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS autopilot_positions_rule ON autopilot_positions (rule_id, created_at DESC);
CREATE INDEX IF NOT EXISTS autopilot_positions_owner ON autopilot_positions (owner, created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS autopilot_positions_one_live_per_rule ON autopilot_positions (rule_id) WHERE rule_id IS NOT NULL AND status IN ('opening', 'open', 'closing');

-- Every order, keyed by an idempotency intent so a retry never sends twice. request_id is the
-- Perpl request id (strictly increasing per account).
CREATE TABLE IF NOT EXISTS autopilot_orders (
  id            BIGSERIAL        PRIMARY KEY,
  intent        TEXT             NOT NULL UNIQUE,
  owner         TEXT             NOT NULL,
  position_id   BIGINT           REFERENCES autopilot_positions(id) ON DELETE SET NULL,
  market        TEXT             NOT NULL,
  action        TEXT             NOT NULL CHECK (action IN ('open', 'close', 'reduce')),
  side          TEXT             NOT NULL CHECK (side IN ('long', 'short')),
  size          DOUBLE PRECISION NOT NULL,
  worst_price   DOUBLE PRECISION NOT NULL,
  leverage      DOUBLE PRECISION NOT NULL DEFAULT 1,
  request_id    BIGINT           NOT NULL,
  status        TEXT             NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sent', 'filled', 'unfilled', 'failed')),
  attempts      INTEGER          NOT NULL DEFAULT 0,
  tx_hash       TEXT,
  fill_price    DOUBLE PRECISION,
  fill_size     DOUBLE PRECISION,
  fee_ausd      DOUBLE PRECISION,
  pnl_ausd      DOUBLE PRECISION,
  error         TEXT,
  created_at    TIMESTAMPTZ      NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ      NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS autopilot_orders_open ON autopilot_orders (status) WHERE status IN ('pending', 'sent');

-- Append-only audit log of every decision, order and failure.
CREATE TABLE IF NOT EXISTS autopilot_audit (
  id            BIGSERIAL   PRIMARY KEY,
  at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  owner         TEXT        NOT NULL,
  rule_id       BIGINT,
  follow_id     BIGINT,
  event         TEXT        NOT NULL,
  detail        JSONB       NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS autopilot_audit_rule ON autopilot_audit (rule_id, at DESC);
CREATE INDEX IF NOT EXISTS autopilot_audit_owner ON autopilot_audit (owner, at DESC);

-- Global switches (the kill switch), set by admins.
CREATE TABLE IF NOT EXISTS autopilot_control (
  key           TEXT        PRIMARY KEY,
  value         JSONB       NOT NULL,
  updated_by    TEXT,
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Copy-trading: a follower mirrors a leader's Perpl positions within its own limits.
CREATE TABLE IF NOT EXISTS follows (
  id            BIGSERIAL   PRIMARY KEY,
  follower      TEXT        NOT NULL,
  leader        TEXT        NOT NULL,
  settings      JSONB       NOT NULL,
  status        TEXT        NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'paused', 'stopped')),
  status_reason TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (follower, leader),
  CHECK (follower <> leader)
);
CREATE INDEX IF NOT EXISTS follows_leader ON follows (leader) WHERE status = 'active';

-- The last holdings seen per leader and market, to diff the next snapshot against.
CREATE TABLE IF NOT EXISTS leader_holdings (
  leader        TEXT             NOT NULL,
  market        TEXT             NOT NULL,
  side          TEXT             CHECK (side IN ('long', 'short')),
  size          DOUBLE PRECISION NOT NULL DEFAULT 0,
  margin_ausd   DOUBLE PRECISION NOT NULL DEFAULT 0,
  seen_at       TIMESTAMPTZ      NOT NULL DEFAULT now(),
  PRIMARY KEY (leader, market)
);

-- The last Perpl request id used per account. Ids stay small and sequential (seeded from the
-- account's lfr on the API path): Perpl's forwarder rejects large ids.
CREATE TABLE IF NOT EXISTS perpl_request_ids (
  owner         TEXT        PRIMARY KEY,
  last_id       BIGINT      NOT NULL,
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Where to look for an order's on-chain result, and why it was placed (a close's reason).
ALTER TABLE autopilot_orders ADD COLUMN IF NOT EXISTS from_block BIGINT;
ALTER TABLE autopilot_orders ADD COLUMN IF NOT EXISTS reason TEXT;
