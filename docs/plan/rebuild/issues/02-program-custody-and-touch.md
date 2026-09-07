# 02 Program: pool, custody, and the touch rule

Status: resolved
Type: task
Blocked by: none

## Goal

Rewrite `programs/hex_vault/src/lib.rs` from scratch under a new program ID with the accounts in spec §2.1 and the custody instructions in spec §2.3, including the `touch` rule in §2.2. Rounds and epochs are stubs in this ticket (accounts defined, instructions land in 03 and 04).

## Scope

- New keypair, `declare_id!`, `Anchor.toml` updated. Old program ID removed everywhere.
- Accounts: `Pool`, `Epoch`, `Round`, `Player`, `Position` with exact fields and seeds from spec §2.1. `Epoch`/`Round` may have no instructions yet but must have their final layout so the IDL does not churn.
- Instructions: `create_pool` (creates both vaults and the House Player), `set_params`, `set_pause`, `deposit` (init_if_needed Player), `withdraw`.
- `touch()` as a shared helper, unit-tested in Rust with these cases: active in previous epoch, idle through previous epoch, first-ever touch, same-epoch accrual, principal change in the same instruction does not affect `frozen_weight`.
- Events: `Deposited`, `Withdrawn`, `Paused`, `PoolCreated`, `ParamsSet`.
- Cargo feature `test-vrf` declared (empty for now).

## Acceptance

- `cargo test -p hex_vault --lib` passes touch cases.
- `tests/01-custody.test.ts` (new localnet suite, Anchor mocha or vitest as the old one used): deposit mints equal principal and entries; withdraw enforces both bounds; withdraw works while paused; deposit fails while paused and below minimum; vault balance equals `total_principal` after a sequence; a foreign pool's vault is rejected by seeds.
- `anchor build` emits the IDL; `apps/web/scripts/sync-idl.mjs` still copies it.

## Comments

Done in `4d201b4`. `cargo test -p hex_vault --lib`: 15 passed.
`tests/01-custody.test.ts` on localnet: 6 passed.

Two things the ticket did not spell out, decided here:

- The program is split into `custody.rs`, `rounds.rs`, `epochs.rs` behind a
  `lib.rs` that only declares instructions and delegates. That is what let
  tickets 03 and 04 run at the same time without either one touching `lib.rs`.
  `rounds.rs` and `epochs.rs` shipped with this ticket as signature-only stubs
  carrying their final accounts, so the IDL does not churn.
- `Pool` gained two fields the field list in spec 2.1 omits but 2.3 and 2.5
  require: `open_round_id` (the one-round-at-a-time gate) and
  `vrf_network_state` (pinned at pool creation).

The `test-vrf` randomness path does not go through ORAO at all. `test_fulfill`
writes a `RandomnessV2`-shaped account at a PDA of this program, and
`vrf::randomness_address` returns that address under the feature and ORAO's
request PDA without it. The devnet build never compiles the feature.
