# 03 Program: rounds

Status: resolved
Type: task
Blocked by: 02

## Goal

Implement the round instructions from spec §2.3: `create_round`, `buy_position` with weight pre-credit, `request_round_randomness` (ORAO CPI), `settle_round` with forfeit to the House, `settle_position` with rent refund, `void_round` with carry.

## Scope

- ORAO VRF v2 CPI (`orao-solana-vrf` crate, `request_v2`), seed = keccak("round", pool, round_id). Network state pubkey passed as an account and pinned in `Pool` or config.
- `test-vrf` feature: `test_fulfill(subject_seed, bytes)` writes a fake fulfilled randomness account the settle path accepts. Not compiled without the feature.
- Tile selection `u64::from_le_bytes(r[0..8]) % 36`; document the bias bound in a comment.
- `Pool.open_round_id` gate: one Open/Requested round at a time.
- Events: `RoundOpened`, `PositionBought`, `RoundSettled`, `RoundVoided`, `PositionSettled`.

## Acceptance (`tests/02-rounds.test.ts`, localnet with `test-vrf`)

- Two players stake on different tiles; the winning tile's player receives the whole pot; loser's Entries are gone; total Entries conserved.
- Three players, two on the winning tile with different stakes: rewards are pro rata and `Σ rewards <= pot`.
- Nobody on the winning tile: House Entries increase by the pot; status Forfeited.
- Buy after `ends_at - close_buffer` fails; second position by the same player fails; empty tile mask fails; stake exceeding Entries fails.
- Pre-credit: a player who stakes all Entries at round start has the same weight at round end as one who held them (assert `weight_acc` equal within the round).
- Void after `vrf_timeout`: `carry_pot` equals the pot; next round starts with that pot.
- `settle_position` closes the account and refunds rent to the owner for winners, losers, and voided rounds.
- `create_round` fails while paused, while another round is open, and when it would end after the epoch (requires a stub `begin_epoch` or a test helper that sets epoch fields; coordinate with 04 if simpler to land together).

## Comments

Done in `3cbbf6e`. `tests/02-rounds.test.ts`: 8 passed. Every acceptance case
ran, including the epoch-bound `create_round` case, because ticket 04's
`begin_epoch` landed while this was in flight.

`settle_position` gained a constraint tying `position.owner` to `player.owner`.
Without it a caller could pass their own Player account alongside someone else's
Position, take that position's reward, and still close the real owner's account
and refund them the rent. Found while implementing, not in the ticket.

Round timing in the suite comes from the validator's own clock, not `Date.now()`.
A test validator's slot-derived clock lags wall time under load, which made
settlement look early.

The real ORAO CPI is still `todo!()`. See `../progress.md` for the three linked
problems in that path and what was verified about each.
