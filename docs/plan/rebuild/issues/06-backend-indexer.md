# 06 Backend: indexer module

Status: resolved
Type: task
Blocked by: 05

## Goal

Mirror program accounts into Postgres and ingest finalized events, per spec §3.3.

## Scope

- Account sync every 2 s: `getProgramAccounts` per account type using the 8-byte discriminator `memcmp` filter, decode with the Anchor account coder, upsert with Prisma in one transaction per type. Delete `Position` rows whose accounts no longer exist.
- Event ingest: `connection.onLogs(programId, ..., "finalized")` plus boot-time catch-up via `getSignaturesForAddress` from `Cursor.lastSignature`. Decode with the Anchor event coder. `Event` composite PK makes replays idempotent. Cursor advances in the same transaction as the insert.
- Reconnect the websocket on close with backoff; log once per state change.
- `IndexerService` query helpers used by the operator: players eligible to register for epoch N, unsettled positions for a round.
- Metric fields on `OperatorState` or a separate row: last synced slot, cursor age.

## Acceptance

- Postgres integration test: feed three synthetic finalized log batches (one duplicated) → exactly the unique events stored, cursor at the last signature.
- Unit test: decoding each event in spec §2.6 from a captured `Program data:` line.
- Against localnet with the program from 02 to 04 running a scripted deposit and round: `Player`, `Round`, `Position` rows appear within 4 s, and the `Position` row disappears after `settle_position`.
