# HexVault

A Solana devnet prototype for an active, no-loss-principal savings lottery with isolated
multi-pool custody and a sponsor-funded jackpot.

> **Prototype only. Do not deposit real assets.** This repository is not an audit, a
> financial product, or a promise of yield. Mainnet deployment requires an independent
> audit, multisig/timelock governance, legal review, operational runbooks, and a production
> randomness provider. See the [launch checklist](docs/launch-checklist.md).

## Product model

Users deposit the accepted asset of a pool (test USDC on devnet). The program records two
non-transferable, 1:1 accounting balances:

- **Principal Token (PT):** the user's claim on deposited assets.
- **Entry Token (ET):** an epoch-scoped game balance. One dollar of deposit creates one PT
  and one ET.

Within an epoch, ET may be spent on 36-tile hex-board positions per round. Losing entries
are gone, so the matching principal cannot be withdrawn until entries are refreshed to
match principal at the next epoch. Each epoch runs a weight-proportional prize draw over a
committed Merkle-sum snapshot of entries, funded only from the segregated prize escrow, and
optionally a second, domain-separated **jackpot** draw funded only from its own escrow.
ET is never transferable or redeemable, and **no principal or ET ever funds fees, jackpots,
buybacks, burns, or staking** — v1 takes no fee at all (see the
[launch decision](docs/launch-decision.md)).

## Intended stack

- **On-chain:** Rust with Anchor, Solana/Agave, Token-2022 non-transferable receipts; one
  program, many isolated [`Pool`](docs/architecture-pools-epochs.md) instances (immutable
  accepted asset, receipt mints, and principal/prize/jackpot vaults per pool).
- **Indexer:** durable PostgreSQL indexer (`packages/indexer`) — finalized-only event
  ingest, transactional cursor, canonical snapshot recomputation, five reconciliation
  checks; read API in `packages/api`.
- **CLI:** `packages/cli` (`hexvault`) drives the full operator lifecycle, exports
  Merkle-sum snapshots, and reconciles on-chain state.
- **Web:** `apps/web` is the full designed UI (hexagon arena, animated rounds,
  vault/prizes screens) driven by live chain state: Privy or any standard
  wallet, deposits, board positions, claims and withdrawals, with a browser
  e2e harness (`scripts/e2e-web.sh`).
- **Randomness:** ORAO VRF v2 (pull model) for round/prize/jackpot settlement —
  slot-hash-mixed seeds, program-bound request accounts, fulfilled-only settle
  (docs/vrf-randomness.md). A test-only mock authority remains for localnet,
  hard-rejected when `production_mode` is set (I-02 residual: provider review).

## Repository layout

```text
programs/hex_vault/     Anchor program (protocol + jackpot)
packages/indexer/       Postgres event indexer, snapshot + reconciliation
packages/api/           Fastify read API over the indexer store
packages/cli/           hexvault operator CLI (pool/epoch/round/prize/jackpot)
apps/web/               minimal functional localnet UI
tests/                  51-test local-validator integration suite
scripts/                e2e lifecycle script and test validator runner
docs/                   product, risk, architecture, and operational specs
```

## Development and validation

The current scope is a **devnet protocol prototype**, exercised end to end on localnet:
`scripts/e2e.sh` runs the complete lifecycle (initialize → pool → epoch → deposits →
round → settlement → snapshot → prize + jackpot draws → claims → rollover) against an
isolated validator with the indexer and API live, and verifies indexed events, canonical
snapshot root equality with the on-chain commit, and vault solvency.

### Verify locally

```sh
pnpm install --frozen-lockfile
pnpm run check          # tsc across all workspace packages
pnpm run test:unit      # 78 tests (indexer skips Postgres tests without DATABASE_URL)
pnpm run test:program   # 51 integration tests on an isolated local validator
pnpm run format:check
cargo fmt --all -- --check
cargo test -p hex_vault --lib
git diff --check
```

With Docker: `docker compose up -d db`, then `DATABASE_URL=postgres://postgres:postgres@localhost:5432/hexvault`
enables the indexer's nine Postgres integration tests; `docker compose --profile chain up`
adds a validator + indexer + API stack (see `infra/README.md`).

`pnpm run test:program` builds the program, starts a temporary validator, and runs
`tests/`. It requires a fresh local test key at `~/.config/solana/id.json`; never use a
funded mainnet wallet.

## Documentation map

- [`docs/product-requirements.md`](docs/product-requirements.md) — product requirements.
- [`docs/protocol.md`](docs/protocol.md) — protocol spec and invariants.
- [`docs/architecture-pools-epochs.md`](docs/architecture-pools-epochs.md) — multi-pool
  isolation and configurable epoch schedules.
- [`docs/jackpot-design.md`](docs/jackpot-design.md) — jackpot custody, draw, rollover.
- [`docs/launch-decision.md`](docs/launch-decision.md) — ET-only v1; the 20/50/30
  allocation and Lane B are deferred behind their own gates.
- [`docs/hex-tokenomics-memo.md`](docs/hex-tokenomics-memo.md) — why HEX must not exist yet.
- [`docs/gap-analysis.md`](docs/gap-analysis.md) — audit of the previous code state.
- [`docs/implementation-plan.md`](docs/implementation-plan.md) — phased plan.
- [`docs/localnet-ui-and-cli-plan.md`](docs/localnet-ui-and-cli-plan.md) — CLI + UI plan.
- [`docs/security.md`](docs/security.md) — invariants and threat model.
- [`docs/preliminary-security-review.md`](docs/preliminary-security-review.md) — findings.
- [`docs/maintenance.md`](docs/maintenance.md) — contributor and operations guide.
- [`docs/launch-checklist.md`](docs/launch-checklist.md) — test/audit/legal/launch gates.
