# 02 Program: pool, custody, and the touch rule

Status: ready-for-agent
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
