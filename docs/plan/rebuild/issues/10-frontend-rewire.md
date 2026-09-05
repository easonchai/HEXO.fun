# 10 Frontend: rewire to the new program and API

Status: ready-for-agent
Type: task
Blocked by: 03, 04, 08

## Goal

`apps/web` talks to the rebuilt program and the NestJS API. Screens are restyled in ticket 11; this ticket is plumbing.

## Scope

- Sync the new IDL; delete every action, type, and helper for prize/jackpot claims, Merkle proofs, entry refresh, mock randomness, multi-pool selection.
- `actions.ts`: `deposit`, `withdraw`, `buyPosition(tilesMask, stakePerTile)`, `settlePosition(roundId)`, `register(epochId)`. Each builds from the IDL, signs with the connected wallet, confirms at `confirmed`, then triggers a chain re-read.
- `read.ts`: own `Player` and open `Round` from RPC every 2 s and immediately on `RoundSettled` via `onLogs`. Derived `withdrawable = min(principal, entries)`.
- `api.ts`: typed clients for every route in spec §3.5, polled every 2 s where displayed; absence shown as a banner, never a crash.
- Env: `VITE_RPC_URL`, `VITE_API_URL`, `VITE_PROGRAM_ID`, `VITE_POOL_ID`, `VITE_PRIVY_APP_ID`. Remove `VITE_CLUSTER` branching.
- Position confirmation always shows Entries in, Entries after, withdrawable after.

## Acceptance

- `pnpm --filter web check` and existing unit tests pass; new test for `withdrawable`.
- Against localnet with the backend from 07 and 08 running: connect a burner, faucet, deposit, buy a position, watch it settle, withdraw the matched amount. All balances shown match `GET /players/:owner` and the on-chain Player.
