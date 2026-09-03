-- HexVault indexer schema. Every statement is idempotent so migrations can be
-- re-applied on boot by any replica.

CREATE TABLE IF NOT EXISTS cursor (
  id            integer PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  slot          bigint  NOT NULL,
  signature     text    NOT NULL,
  event_index   integer NOT NULL,
  updated_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS events (
  slot          bigint      NOT NULL,
  signature     text        NOT NULL,
  event_index   integer     NOT NULL,
  name          text        NOT NULL,
  pool          text        NOT NULL,
  payload       jsonb       NOT NULL,
  block_time    bigint,
  ingested_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (slot, signature, event_index)
);

CREATE INDEX IF NOT EXISTS events_pool_slot_idx ON events (pool, slot, signature, event_index);
CREATE INDEX IF NOT EXISTS events_name_idx      ON events (name);

-- Only address / pool_id / accepted_mint are derivable from the PoolCreated
-- event; the remaining columns are filled in by an on-chain account sync, so
-- they start out NULL rather than blocking the insert.
CREATE TABLE IF NOT EXISTS pools (
  address                    text PRIMARY KEY,
  pool_id                    bigint NOT NULL,
  accepted_mint              text   NOT NULL,
  accepted_token_program     text,
  accepted_decimals          integer,
  principal_mint             text,
  entry_mint                 text,
  principal_vault            text,
  prize_vault                text,
  jackpot_vault              text,
  min_deposit                bigint,
  max_stake_per_tile         bigint,
  max_round_bonus_entries    bigint,
  min_epoch_seconds          bigint,
  max_epoch_seconds          bigint,
  round_close_buffer_seconds bigint,
  latest_epoch_id            bigint NOT NULL DEFAULT 0,
  paused                     boolean NOT NULL DEFAULT false,
  principal_minted           bigint NOT NULL DEFAULT 0,
  principal_withdrawn        bigint NOT NULL DEFAULT 0,
  prize_funded               bigint NOT NULL DEFAULT 0,
  jackpot_funded             bigint NOT NULL DEFAULT 0,
  updated_at                 timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS epochs (
  pool                text NOT NULL,
  epoch_id            bigint NOT NULL,
  starts_at           bigint NOT NULL,
  entry_cutoff_at     bigint NOT NULL,
  ends_at             bigint NOT NULL,
  prize_snapshot_at   bigint NOT NULL,
  claim_deadline      bigint NOT NULL,
  status              integer NOT NULL DEFAULT 0,
  prize_snapshot_root bytea,
  total_entry_weight  bigint NOT NULL DEFAULT 0,
  prize_amount        bigint NOT NULL DEFAULT 0,
  prize_target        bigint,
  jackpot_status      integer NOT NULL DEFAULT 0,
  jackpot_amount      bigint NOT NULL DEFAULT 0,
  jackpot_target      bigint,
  prize_claimed_by    text,
  jackpot_claimed_by  text,
  PRIMARY KEY (pool, epoch_id)
);

CREATE TABLE IF NOT EXISTS rounds (
  pool         text NOT NULL,
  epoch_id     bigint NOT NULL,
  round_id     bigint NOT NULL,
  address      text   NOT NULL,
  starts_at    bigint NOT NULL,
  ends_at      bigint NOT NULL,
  status       integer NOT NULL DEFAULT 0,
  winning_tile integer,
  bonus_entries bigint NOT NULL DEFAULT 0,
  total_stake  bigint NOT NULL DEFAULT 0,
  tile_stakes  jsonb  NOT NULL DEFAULT '[]'::jsonb,
  PRIMARY KEY (pool, epoch_id, round_id)
);

CREATE TABLE IF NOT EXISTS positions (
  pool           text NOT NULL,
  round_id       bigint NOT NULL,
  epoch_id       bigint NOT NULL,
  owner          text NOT NULL,
  round          text NOT NULL,
  tiles          bigint NOT NULL,
  stake_per_tile bigint NOT NULL,
  total_stake    bigint NOT NULL,
  reward_claimed boolean NOT NULL DEFAULT false,
  PRIMARY KEY (pool, round_id, owner)
);

CREATE TABLE IF NOT EXISTS players (
  pool                         text NOT NULL,
  owner                        text NOT NULL,
  principal                    bigint NOT NULL DEFAULT 0,
  entries_spent_since_refresh  bigint NOT NULL DEFAULT 0,
  entries_rewarded_since_refresh bigint NOT NULL DEFAULT 0,
  last_refresh_epoch           bigint NOT NULL DEFAULT 0,
  updated_at                   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (pool, owner)
);

CREATE TABLE IF NOT EXISTS snapshots (
  pool          text NOT NULL,
  epoch_id      bigint NOT NULL,
  cutoff_slot   bigint NOT NULL,
  root          bytea  NOT NULL,
  total_weight  bigint NOT NULL,
  player_count  integer NOT NULL,
  leaves        jsonb  NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (pool, epoch_id, cutoff_slot)
);

CREATE TABLE IF NOT EXISTS reconciliation_runs (
  id          bigserial PRIMARY KEY,
  checked_at  timestamptz NOT NULL DEFAULT now(),
  pool        text NOT NULL,
  check_name  text NOT NULL,
  ok          boolean NOT NULL,
  detail      jsonb NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS reconciliation_runs_pool_idx ON reconciliation_runs (pool, checked_at DESC);
