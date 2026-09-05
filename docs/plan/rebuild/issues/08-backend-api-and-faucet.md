# 08 Backend: read API, status, faucet

Status: ready-for-agent
Type: task
Blocked by: 06

## Goal

The HTTP surface the frontend uses, per spec §3.5.

## Scope

- Controllers for every route in spec §3.5. All `BigInt`/`Decimal` fields serialized as decimal strings; a global interceptor handles it.
- `/players/:owner`: `liveWeight = weightAcc + entries × (now − lastUpdate)` computed at request time if `epochId == currentEpochId`, else `principal × (now − currentEpochStart)`; `odds = liveWeight / Σ liveWeight` over all players as a string percentage with two decimals.
- `/epochs/current`: while the previous epoch is Registering or Drawing include `{ drawing: { epochId, registeredCount, eligible, status } }`.
- `/feed`: events filtered to `Deposited`, `Withdrawn`, `PositionBought`, `RoundSettled`, `PositionSettled` (reward > 0), `JackpotPaid`, `EpochRolledOver`.
- `/status`: `OperatorState`, cursor age seconds, `rpcOk` from a cached `getSlot`.
- `POST /faucet`: validate `owner` is a pubkey; check `FaucetClaim`; `createAssociatedTokenAccountIdempotent` + `mintTo` `FAUCET_AMOUNT`; upsert claim; 429 with `retryAfterSeconds` when inside the interval. Rate limit the route by IP as well (`@nestjs/throttler`, 10/min).
- CORS from `CORS_ORIGIN` only.

## Acceptance

- Supertest suite against a seeded Postgres: every route returns the documented shape; no JSON number exceeds 2^53; `/faucet` second call within the hour returns 429.
- Manual: `curl` each route on localnet after ticket 07's end-to-end run.
