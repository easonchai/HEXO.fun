# 01 Delete the old code and docs

Status: resolved
Type: task
Blocked by: none

## Goal

Remove everything the rebuild replaces so no agent or human reads stale design.

## Delete

- `packages/cli`, `packages/indexer`, `packages/api`
- `scripts/` (all)
- `infra/`
- `tests/` (the old Anchor suite; ticket 02 recreates the directory)
- `.hexvault/`
- `apps/web/src/lib/merkle.ts`, `snapshotProof.ts`, `keccak.ts` and their tests
- `docker-compose.yml` contents (ticket 12 rewrites it), `.env.example` contents

The old docs, `docs/plan/audit-fixes/`, and the README were already removed or rewritten during planning.

## Update

- `pnpm-workspace.yaml`: `apps/*` only, plus `programs` if referenced
- root `package.json` scripts: drop `test:program`, keep `check`, `test:unit`, `format:check`
- `README.md` "State of the repo" section: drop the paragraph about the old code once it is gone

## Acceptance

- `pnpm install` and `pnpm run check` succeed for the remaining workspace (`apps/web` may fail typecheck until ticket 10; note it in the PR).
- `rg -i "merkle|snapshot authority|prize vault" --glob '!docs/adr/**' .` returns nothing outside `node_modules` and `target`.

## Comments

Done in `bde6a49`. Two deviations from the ticket:

- `scripts/test-program-local.sh` was moved to `tests/run-local.sh` rather than
  deleted. The 02-04 acceptance criteria all need a localnet runner, and
  rewriting a working one is waste. It gained a `HEXVAULT_RPC_PORT` override so
  several suites can run side by side, which parallel agents need. `Anchor.toml`
  `[scripts] test` now points at it; the root `test:program` script is gone as
  the ticket asked.
- `.hexvault/` was gitignored, so it was removed from disk only.

The acceptance grep still reports hits in `programs/hex_vault/src/lib.rs`, which
ticket 02 rewrites, and in `README.md` / `CONTEXT.md`, where the words appear in
a "do not use this vocabulary" sense.
