-- The on-chain Round PDA is seeded by [pool, epoch_id, round_id], so round
-- ids only repeat *within* an epoch, not across epochs. Keying positions by
-- (pool, round_id, owner) let round 1 of epoch 2 overwrite round 1 of
-- epoch 1's row for the same owner. epoch_id has always been a NOT NULL
-- column on this table; only the key was missing it.
ALTER TABLE positions DROP CONSTRAINT IF EXISTS positions_pkey;
ALTER TABLE positions ADD CONSTRAINT positions_pkey PRIMARY KEY (pool, epoch_id, round_id, owner);
