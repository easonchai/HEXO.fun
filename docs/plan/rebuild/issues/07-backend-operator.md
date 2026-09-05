# 07 Backend: operator module

Status: ready-for-agent
Type: task
Blocked by: 06

## Goal

The two-second tick that runs the protocol, per spec §3.4. This replaces the CLI and the demo script entirely.

## Scope

- `@nestjs/schedule` interval, single-flight guard.
- Each tick: read Pool, current Epoch, previous Epoch, open Round from chain (`getMultipleAccounts`), then evaluate the eight steps in spec §3.4 in order; send at most one transaction per tick, except registration and position settlement which batch up to 8 instructions per transaction.
- Step 2 yield funding: `jackpot = max(JACKPOT_FLOOR, totalPrincipal × APR_BPS × epochLen / (10_000 × 31_536_000))`; if the authority's hexUSDC balance is short, `mintTo` self first (authority is mint authority) in the same transaction, then `fund_jackpot`, then `close_registration`.
- Step 4 payout: derive winner from Postgres, build `createAssociatedTokenAccountIdempotent` + `payout` in one transaction.
- ORAO fulfilled check: fetch the randomness account and inspect the fulfilled discriminant; expose as a helper shared with tests.
- Write `OperatorState` after every tick: `lastTickAt`, `lastAction`, `lastError` (cleared on success), `registeredCount`/`registeredTotal` while registering.
- Expected program errors (already settled, already registered, round not closed) log at debug, not error.

## Acceptance

- Unit tests with a fake chain state object and a recording `send`: for each of the eight steps, the state that should trigger it triggers exactly that instruction and nothing else; a healthy mid-round state sends nothing.
- Yield formula test: 1,000 hexUSDC principal, 5% APR, one-day epoch → 136,986 atomic units, floored to 10,000,000.
- Localnet end-to-end with `test-vrf` and a helper that auto-fulfills: start operator, deposit from two wallets, buy positions; within three minutes rounds open, settle, positions close; shorten `epoch_seconds` to 180 via `set_params` → the next epoch registers both players, funds the jackpot, draws, and pays one of them. Assert the winner's hexUSDC balance rose by the jackpot.
