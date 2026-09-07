# 04 Program: epochs, registration, draw, payout

Status: resolved
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

## Comments

Done in `4f6324f`. `tests/03-epochs.test.ts`: 10 passed, every acceptance
case. The House-win split runs through the real forfeiture path from ticket 03
rather than a workaround.

`begin_epoch` reads and writes the current Epoch through raw borrowed data
(`Epoch::try_deserialize` / `try_serialize`) instead of `Account::try_from`. The
account does not exist on the first call, so it has to be `UncheckedAccount`,
and `UncheckedAccount` is invariant over its lifetime, which collides with the
elided lifetimes the `#[program]` macro generates in `lib.rs`. `test_vrf.rs`
already uses the same pattern.

Epoch transitions in the suite poll until they stop erroring rather than
sleeping for a computed duration, because the validator clock does not track
`Date.now()` closely enough to time a transition from an on-chain deadline.

Spec invariant 2 was wrong and is corrected in `spec.md`. It read
`Σ player.entries + ... == total_principal + house.entries`, which double-counts
the House. The sweep here checks `Σ entries (House included) + carry_pot ==
total_principal` against a real nonzero House balance.
