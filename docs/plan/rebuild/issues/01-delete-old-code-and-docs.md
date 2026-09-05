# 01 Delete the old code and docs

Status: ready-for-agent
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
