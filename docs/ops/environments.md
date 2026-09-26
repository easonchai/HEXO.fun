# Environments

Three environments plus a second devnet program, each with its own program keypair under `keys/`
(gitignored), chosen by a cargo feature at build time (ADR 0013). `declare_id!` in
`programs/hex_vault/src/lib.rs` picks the ID; `Anchor.toml` only lists dev (`[programs.localnet]`,
`[programs.devnet]`) and mainnet (`[programs.mainnet]`), since staging and devnew are not Anchor
clusters and `scripts/deploy.sh` passes their keypairs explicitly.

`devnew` is the fresh devnet deploy made after the `Pool`/`Epoch`/`Player` layout change
(`version` and `_reserved` padding, ADR 0013; commit 75e8766): the padded layout cannot land on
the original dev program without breaking every account already on it, so it runs on its own ID
and the original `dev` program and its pools are left untouched. Operationally it is a dev
environment (`docker-compose.dev.yml` reads `ENV_FILE`, so a stack can run from `.env.devnew`).

| | dev | devnew | staging | mainnet |
| --- | --- | --- | --- | --- |
| Program ID | `LFk9ba6QXuM9oYRRNGGPxMGzfo13X3DAr8ghSPz72C6` | `8JVqp7anmrrE5ZvJPnz9jimbZDHotMT8aq877Xgg7Aih` | `H2iWyng2orJpHNGGWhrR7rBQNDqixThpTpAwF4dnPXax` | `EwqRKGqnH7dGwL5ERMGQc2tsLKwT3duzKWPcCDphyPCH` |
| Cargo feature | none (default) | `devnew` | `staging` | `mainnet` (built with `solana-verify`) |
| Cluster | devnet (laptop and VPS) | devnet | devnet | mainnet-beta |
| Compose file | `docker-compose.dev.yml` (laptop) / `docker-compose.yml` (VPS) | `docker-compose.dev.yml` with `ENV_FILE=.env.devnew` | `docker-compose.staging.yml` (`include:`s `docker-compose.yml`; `--env-file .env.staging` required) | `docker-compose.yml` (`--env-file .env.mainnet` required) |
| Env file | `.env` | `.env.devnew` | `.env.staging` | `.env.mainnet` |
| Backend host | laptop: `127.0.0.1:8080`; VPS: `api-hexo.elvtd.io` | _fill in_ | `API_HOST` in `.env.staging`: _fill in_ | `API_HOST` in `.env.mainnet`: _fill in_ |
| Vercel scope | Existing `hexofun-beta.vercel.app` project (predates this split): _fill in whether it moves to the `dev`-branch Preview below_ | _fill in_ | Preview, scoped to the `dev` branch (`apps/web/.env.staging.example`) | Production, scoped to `main`: _fill in the project/domain_ |
| Live pool IDs | Several ad hoc pools exist today (`.env`, `.env.dev`, `.env.vps`, `.env.vps1`); ticket 15 retires `.env.vps` and `.env.vps1` once staging is up. _Fill in the pool this environment settles on._ | Fresh pools from 1 on this program; _fill in_ | Not bootstrapped yet (ticket 15 is pending); `.env.staging.example`'s `POOL_ID=1` is a placeholder | Not deployed yet; `.env.mainnet.example`'s `POOL_ID=1` is a placeholder |

Devnet RPC keys, mainnet RPC keys, and every real secret live only in the gitignored `.env*`
files, never in `.env*.example` or in this doc.

## Adding a pool without touching old ones

A pool's PDA seed is `["pool", pool_id]` alone, global across the whole program rather than
scoped to any authority, so a new pool never collides with an existing one on the same program.
Adding a pool means:

1. Pick an unused `POOL_ID`.
2. `pnpm --filter @hexvault/backend bootstrap` against that ID (creates `Pool`, its vaults, and
   the House `Player`; reuses an existing mint if you pass one). On a test mint the signer
   controls, bootstrap also seeds the Treasury and Buyback reserve as token accounts owned by the
   Operator hot key. On a mint it does not control (real USDC on mainnet) it refuses to do that
   and requires `--treasury <token account>` and `--buyback-reserve <token account>`: the Admin
   multisig's own USDC accounts (CONTEXT.md "Treasury"), which bootstrap checks exist and hold
   the accepted mint, logging each one's owner. Squads gives one associated token account per
   mint, so the second one is a separate token account owned by the vault.
3. Point a backend stack's env file at the new `POOL_ID` (and, if it is a fresh mint, the new
   `ACCEPTED_MINT`), then recreate that stack.
4. Point the matching frontend build's `VITE_POOL_ID` at it and redeploy.

Every other pool on that program is untouched: bootstrap only writes new accounts. Since
`Pool`, `Epoch` and `Player` now carry `version` and reserved padding (ADR 0013), a field added
in a later upgrade no longer forces a fresh pool the way it used to; a fresh pool is for a new
deployment (dev/demo reset, a new environment) or for a change that genuinely cannot be
append-only (see below), not for routine growth.

## When a new program ID is warranted

Per-environment program IDs (this doc's table) exist so a devnet upgrade cannot break staging or
mainnet, and so mainnet never reuses a keypair that ever ran on devnet. Within one environment, a
new program ID (and therefore a fresh set of pools) is warranted only when an upgrade cannot be
made append-only:

- An existing field is removed, reordered or resized, rather than a new one appended.
- An account's meaning changes incompatibly (not just a new interpretation of a zero value with a
  `version` bump).

An additive field taken from `_reserved`, a new instruction, a new event or error variant, or an
admin parameter change never needs a new program ID; that is the point of ADR 0013's upgrade
policy. See [`docs/ops/deploy.md`](deploy.md#upgrade-policy-adr-0013).
