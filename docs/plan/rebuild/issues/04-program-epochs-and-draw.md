# 04 Program: epochs, registration, draw, payout

Status: ready-for-agent
Type: task
Blocked by: 02

## Goal

Implement `begin_epoch`, `register`, `fund_jackpot`, `close_registration`, `draw`, `payout` (player and House split), `rollover_epoch` from spec §2.3.

## Scope

- Contiguous epochs: `starts_at` of N+1 equals `ends_at` of N; `previous_epoch_start` maintained for the touch rule.
- `register` weight cases exactly as spec §2.3; zero weight returns Ok without registering.
- ORAO CPI with seed keccak("epoch", pool, epoch_id); `test-vrf` fulfill path shared with 03.
- `draw`: `u128::from_le_bytes(r[0..16]) % registered_weight`.
- `payout`: verifies interval; House split 50/30/20 using integer math with the remainder staying in the vault; creates nothing (the operator passes an existing winner ATA).
- Events: `EpochBegan`, `Registered`, `JackpotFunded`, `EpochDrawn`, `JackpotPaid`, `EpochRolledOver`.

## Acceptance (`tests/03-epochs.test.ts`)

- Player A deposits 100 at epoch start, B deposits 100 at half epoch: registered weights are 2:1 within one second of clock tolerance.
- Idle player through a whole epoch registers `principal × epoch_len`.
- Player touched in N+1 before registering for N registers `frozen_weight`, and a deposit in N+1 does not change it.
- Player who withdraws everything mid-epoch still registers their earned weight.
- Registering twice for the same epoch fails; registering for the current epoch fails.
- `close_registration` with zero registered weight → RolledOver, jackpot stays.
- Draw and payout to a player: winner's USDC increases by `jackpot_amount`; principal vault untouched.
- House wins (force by making House the only registrant via a forfeited pot): buyback gets 50%, treasury 20%, vault keeps 30%.
- `rollover_epoch` after timeout leaves the vault balance intact; the next `close_registration` commits the larger amount.
- `begin_epoch` before `ends_at` fails.
- Invariant sweep at the end: `Σ principal == vault == total_principal`; `Σ entries + carry_pot == total_principal + house.entries`.
