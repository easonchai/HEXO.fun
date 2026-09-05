# 09 Backend: bootstrap command

Status: resolved
Type: task
Blocked by: 05

## Goal

One idempotent command that stands up a fresh pool on a cluster, per spec §3.6.

## Scope

- `pnpm --filter backend bootstrap` runs a Nest standalone application context.
- Steps, each skipped if already present: create hexUSDC mint (6 decimals, mint and freeze authority = authority key); authority ATA; treasury token account; buyback_reserve token account; `create_pool(POOL_ID, defaults from spec §7)`.
- Prints the resulting `HEXUSDC_MINT`, `PROGRAM_ID`, `POOL_ID`, pool PDA, vault addresses as `KEY=value` lines for `.env`.
- Optional `--epoch-seconds`, `--round-seconds` flags for a fast demo pool.

## Acceptance

- Run twice against localnet: second run creates nothing and prints the same values.
- Run against devnet with an airdropped authority: pool exists and `GET /pool` (ticket 08) serves it.
