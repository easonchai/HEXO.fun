# 08 Backend: read API, status, faucet

Status: resolved
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

## Comments

Landed in `3d14b51`. 24 tests against a seeded Postgres. The manual curl item
is still open: it needs ticket 07's localnet run, which is a separate harness.

### The contract tickets 10 and 11 consume

Written down here so the frontend wave does not have to read the controller.
Source of truth stays `apps/backend/src/api/`.

Every `u64` and `u128` arrives as a **decimal string**, never a JSON number.
One global interceptor does it, so this holds for nested fields too. Row shapes
below name the Prisma model in `apps/backend/prisma/schema.prisma`.

| Route | 200 shape |
| ----- | --------- |
| `GET /pool` | `{ pool: Pool, currentEpoch: Epoch \| null, openRound: { id, epochId, startsAt, endsAt, status, pot } \| null }` |
| `GET /epochs?limit=20` | `Epoch[]`, newest id first |
| `GET /epochs/current` | `Epoch & { drawing: { epochId, registeredCount, eligible, status } \| null }` |
| `GET /rounds?limit=50` | `Round[]`, newest first, each with `winningTile`, `pot`, `tileTotals` |
| `GET /rounds/:id` | one `Round` |
| `GET /players/:owner` | `Player & { liveWeight, odds }` |
| `GET /leaderboard?limit=20` | `[{ owner, principal, entries, isHouse, liveWeight, odds }]`, by `liveWeight` descending |
| `GET /feed?limit=50` | `[{ slot, signature, index, name, data, blockTime }]`, newest first |
| `GET /status` | `{ operator: OperatorState \| null, cursor: { lastSlot, lastSignature, ageSeconds }, rpcOk, slot }` |
| `POST /faucet {owner}` | 201 `{ owner, tokenAccount, amount, signature, nextRequestAt }` |

Things worth knowing before wiring a screen to these:

- `limit` is capped at 100 on every list route. A non-integer or one below 1 is
  a 400, not a clamp.
- `odds` is a percentage string with two decimals, `"12.34"`, not a fraction.
  It is `"0.00"` when total Weight is zero, so a fresh pool renders rather
  than dividing by zero.
- `openRound` on `/pool` is the newest round with status Open or Requested,
  and it is a summary, not the full `Round`. Use `/rounds/:id` for
  `tileTotals`.
- `drawing` on `/epochs/current` is non-null only while the **previous** epoch
  is Registering (1) or Drawing (2). That is the Jackpot screen's progress bar.
  `eligible` counts players with non-zero Weight for that epoch, so
  `registeredCount / eligible` is a real fraction.
- `/status.cursor.ageSeconds` is `null` when the indexer has never synced,
  which is different from `0`. The header status pill should treat null as
  "starting", not "fresh".
- `/feed` names are PascalCase, matching spec §2.6: `RoundSettled`, not
  `roundSettled`. `PositionSettled` appears only when `reward > 0`.
- 404 bodies are written for a person to read, for example "No Player account
  for that wallet yet. Deposit to open one." Show the message rather than
  inventing copy.
- The faucet returns 429 with `retryAfterSeconds` inside the interval, and is
  throttled to 10 per minute per IP on top of that. No other route shares that
  budget, so 2 s polling is safe.
