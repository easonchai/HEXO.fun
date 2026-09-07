# 05 Backend scaffold: NestJS, Prisma, chain module, Dockerfile

Status: resolved
Type: task
Blocked by: 03, 04

## Goal

Create `apps/backend` as a NestJS 11 app with Prisma 6 on Postgres and a `chain` module that loads the IDL, the authority keypair, and exposes typed program calls. No business logic yet.

## Scope

- `apps/backend/` in the pnpm workspace; `nest-cli.json`, `tsconfig`, `prisma/schema.prisma` with the models from spec §3.2, first migration.
- `ConfigModule` validating every env var in spec §3.1 at boot (fail fast, list what is missing).
- `ChainModule`: `Connection`, Anchor `Program` from `../../target/idl/hex_vault.json` copied at build (same sync approach as the web app), `Keypair` from `AUTHORITY_KEYPAIR`, PDA helpers, a `send(ix[])` helper that signs, sends, confirms at `confirmed`, and maps Anchor error codes to names.
- `GET /healthz`.
- `Dockerfile` (multi-stage, see spec §5) and `pnpm --filter backend start:dev`.
- Vitest configured.

## Acceptance

- `docker build apps/backend` succeeds and the container boots against a Postgres, applies migrations, serves `/healthz`.
- `pnpm --filter backend check` passes.
- A smoke test instantiates `ChainModule` with a fake connection and derives the Pool PDA for `POOL_ID`.

## Comments

All three acceptance items verified locally (check passes, the two-test vitest
smoke suite passes, `docker build -f apps/backend/Dockerfile .` — context is
the repo root, not `apps/backend`, see Dockerfile's top comment — produces an
image that boots against a real Postgres container, applies the one migration,
and serves `/healthz`).

One blocker outside this ticket's scope: `pnpm-workspace.yaml`'s `allowBuilds`
map doesn't list `prisma`, `@prisma/client`, `@prisma/engines`, or `@swc/core`
(all newly needed by `apps/backend`), and a **fresh** `pnpm install` (empty
store — a clean clone, CI, or `docker build`) hits pnpm's build-script
approval gate and exits non-zero (`ERR_PNPM_IGNORED_BUILDS`) before those
packages' postinstall scripts run. It's silent on a dev machine that already
has them installed, which is why this only shows up on a clean checkout. Two
pre-existing entries (`keccak`, `@reown/appkit`, from apps/web) already need
the same approval and are unrelated to this ticket. Someone with permission to
edit `pnpm-workspace.yaml` needs to run `pnpm approve-builds` once (I verified
the fix works: approving those six packages let a from-scratch `docker build`
succeed end to end) and commit the result. I did not touch that file per my
scope; I did use it locally, gated behind `git checkout -- pnpm-workspace.yaml`
after each check, purely to verify the Dockerfile itself is correct.

Also pinned `@swc/core` to `1.16.1` rather than the newest `1.16.2`: this repo's
pnpm build also enforces a `minimumReleaseAge` supply-chain policy, and `1.16.2`
was published too recently to pass it at the time of this ticket.

`apps/backend/src/idl/hex_vault.json` is a checked-in snapshot synced from
`target/idl/hex_vault.json` (via `scripts/sync-idl.mjs`, same approach as
`apps/web`) at the moment this ticket was done. The program is being rewritten
concurrently, so this snapshot is expected to go stale immediately — re-run
`pnpm --filter @hexvault/backend sync-idl` once the program lands. `ChainModule`
never trusts the checked-in file's `address` field; it always overrides it
with the env-resolved `PROGRAM_ID` before constructing the Anchor `Program`.
