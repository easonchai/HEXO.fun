# 05 Backend scaffold: NestJS, Prisma, chain module, Dockerfile

Status: ready-for-agent
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
