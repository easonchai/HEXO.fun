# @hexvault/api

Read-only Fastify HTTP API over the tables written by `@hexvault/indexer`.

## Run

    DATABASE_URL=postgres://postgres:postgres@localhost:5432/hexvault \
    PORT=8081 \
    node --experimental-strip-types src/index.ts

`docker compose up -d api` does the same inside the stack. There are **no root
package.json scripts for this service**; use the commands above, `tsx watch
src/index.ts` for a reload loop, or compose. `PORT` defaults to 8081 and
`DATABASE_URL` is required.

## Routes

| route                        | notes                                                  |
| ---------------------------- | ------------------------------------------------------ |
| `GET /pools`                 | pools with nested `limits` and `totals`                |
| `GET /pools/:address`        | 404 when unknown                                       |
| `GET /pools/:address/epochs` | prize + jackpot state per epoch                        |
| `GET /pools/:address/rounds` | `?epoch=<u64>` filters                                 |
| `GET /players/:pool/:owner`  | balances plus computed `entriesBalance`/`withdrawable` |
| `GET /prizes/:pool`          | committed/drawn/claimed prizes                         |
| `GET /jackpots/:pool`        | committed/drawn/claimed jackpots                       |
| `GET /snapshot/:pool/:epoch` | canonical root, total and per-player weights           |
| `GET /reconciliations`       | `?limit=` most recent check results                    |
| `GET /healthz`               | liveness, no database access                           |
| `GET /readyz`                | 503 until the indexer has ingested an event            |
| `GET /metrics`               | Prometheus text format                                 |

All monetary amounts are decimal strings of atomic units — never JS numbers.

`entriesBalance = principal - entriesSpentSinceRefresh + entriesRewardedSinceRefresh`
and `withdrawable = min(principal, entriesBalance)`, since entry tokens alone
are not withdrawable.

Errors are always JSON: `{ "error": "message" }`.
