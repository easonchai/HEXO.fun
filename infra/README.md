# infra

Local runtime plumbing. Nothing here builds the Solana program.

## What the containers run

`indexer` and `api` both use the stock `node:22-alpine` image with the whole
repository bind-mounted at `/app`, and start with:

    node --experimental-strip-types packages/<service>/src/index.ts

Two consequences worth knowing:

- **No `pnpm install` and no build step inside the container.** The workspace's
  `node_modules` comes from the host. That is why plain `node` is used instead
  of `tsx`: `tsx` shells out to esbuild, and the host install only carries the
  darwin binary, so it cannot run on alpine.
- **The IDL is read at runtime** from `target/idl/hex_vault.json`, so it must
  exist on the host before the indexer starts.

## Building the program artifact (host)

The `.so` is built outside Docker — the container has no Anchor toolchain:

    anchor build

That produces:

    target/deploy/hex_vault.so     # mounted by the optional `chain` service
    target/idl/hex_vault.json      # read by the indexer

## Local chain (optional profile)

    docker compose --profile chain up -d

starts `solana-test-validator` with the program pre-loaded:

    --bpf-program 6aDFSdwXESHF7UXJRCkHogNtUTbDPajmLupsfvzTSGvB /app/target/deploy/hex_vault.so

The build must be re-run on the host whenever the program changes; compose only
mounts the existing artifact. Point the indexer at it with
`RPC_URL=http://host.docker.internal:8899` (the default in `.env.example`).

Devnet works too — set `RPC_URL` to any devnet endpoint, but note the program
and its IDL still have to come from this repository.

## Services

| service   | purpose                                         | ports     |
| --------- | ----------------------------------------------- | --------- |
| `db`      | postgres:16-alpine, volume `hexvault-pg`        | 5432      |
| `indexer` | applies migrations, then ingests finalized logs | -         |
| `api`     | read-only Fastify HTTP API                      | 8081      |
| `chain`   | solana-test-validator (`--profile chain`)       | 8899 8900 |

## Common commands

    docker compose up -d db              # database only (used by vitest)
    docker compose up -d indexer api     # full index + serve
    docker compose logs -f indexer
    docker compose down                  # add -v to drop the database volume
