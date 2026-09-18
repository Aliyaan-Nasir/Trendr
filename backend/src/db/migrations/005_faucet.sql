-- Testnet AUSD sent to beta testers, one drip per account per day.
CREATE TABLE IF NOT EXISTS faucet_drips (
  id            BIGSERIAL   PRIMARY KEY,
  account       TEXT        NOT NULL,
  amount        NUMERIC     NOT NULL,
  tx_hash       TEXT        NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS faucet_drips_account ON faucet_drips (account, created_at DESC);
