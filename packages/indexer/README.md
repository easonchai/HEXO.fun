# @hexvault/indexer

Durable Postgres indexer for the HexVault Anchor program. Subscribes to
finalized logs, decodes Anchor events, projects them into relational tables and
reconciles the projection against on-chain token balances.

## Run

    DATABASE_URL=postgres://postgres:postgres@localhost:5432/hexvault \
    RPC_URL=http://127.0.0.1:8899 \
    node --experimental-strip-types src/index.ts

or `docker compose up -d indexer`. `RPC_URL` defaults to localnet, `PROGRAM_ID`
to the deployed HexVault program, and `IDL_PATH`/`MIGRATIONS_DIR` to the
repository paths. The root `pnpm exec tsx packages/indexer/src/index.ts` also
works on the host.

## Layout

| file                | responsibility                                                 |
| ------------------- | -------------------------------------------------------------- |
| `src/keccak.ts`     | vendored Keccak-256 (matches `solana_keccak_hasher`)           |
| `src/merkle.ts`     | Merkle-sum tree, proofs, and the verifier mirror of `utils.rs` |
| `src/events.ts`     | the 22 event names, cursor ordering, amount coercion           |
| `src/decode.ts`     | `Program data:` log line → decoded event                       |
| `src/projection.ts` | in-memory entries model (`ET = principal - spent + rewarded`)  |
| `src/store.ts`      | one-transaction batch writer + relational projection           |
| `src/snapshot.ts`   | canonical snapshot builder from the replayed event log         |
| `src/reconcile.ts`  | five reconciliation checks against RPC                         |
| `src/index.ts`      | subscription, catch-up poll, metrics, scheduling               |
| `migrations/`       | idempotent SQL, applied on every boot                          |

## Guarantees

- **Finalized only.** Both the subscription (`"finalized"`) and the catch-up
  poll filter on finalized confirmation status.
- **One transaction per batch.** Event rows, their projections and the cursor
  commit together, so a crash mid-batch leaves nothing half-written.
- **Replay safe.** `(slot, signature, event_index)` is the primary key; rows
  already present are skipped, so re-delivery cannot double-count.
- **Out-of-order rejected.** A batch whose first cursor is behind the stored
  cursor is refused instead of silently rewinding balances.

## Checks run by the reconciler

1. PT mint supply == principal vault balance
2. prize vault >= committed prize for unresolved epochs
3. jackpot vault >= committed jackpot for unresolved epochs
4. canonical snapshot root == on-chain committed root
5. cursor freshness

Results land in `reconciliation_runs` and are exported as metrics by the API.

## Tests

    pnpm test                          # unit tests, no Postgres required
    DATABASE_URL=... pnpm test         # also runs the Postgres integration suite
