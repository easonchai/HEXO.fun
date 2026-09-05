# 10 Frontend: rewire to the new program and API

Status: resolved
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

## Comments

The plumbing is done and the three commands pass. **This ticket stays open**:
the localnet end-to-end acceptance above has not been run, because it needs
tickets 07 and 08, which are not merged. Everything below is what the next
agent needs to match or finish.

### Verified

`pnpm --filter @hexvault/web check` 0, `test` 32 passed in 6 files, `build` 0.
The acceptance grep returns nothing outside `src/idl/hex_vault.json`, whose two
hits ("snapshotted at close_registration", "1:1 claim on deposited USDC") are
the program's own Rust doc comments in the generated IDL, byte-identical to
`target/idl/`.

### The API shapes, reconciled against the landed ticket 08

`api.ts` was first written from spec §3.5 alone, because ticket 08 had not
merged. It landed while this ticket was in flight (`3d14b51`), so the client
was re-read against `apps/backend/src/api/` and corrected. The backend is right
in every case below; only the frontend changed.

Four differences from a plain reading of §3.5:

1. `GET /pool` returns `{ pool, currentEpoch, openRound }`, not
   `{ pool, epoch, round }`, and `openRound` is a summary of six fields
   (`id`, `epochId`, `startsAt`, `endsAt`, `status`, `pot`) with no
   `tileTotals` and no `winningTile`. That is `RoundSummaryDto` in `api.ts`.
2. `GET /epochs/current` nests progress under `drawing`, which is null unless
   the previous epoch is Registering or Drawing:
   `{ epochId, registeredCount, eligible, status }`. There is no flat
   `eligibleCount`.
3. `GET /leaderboard` sends six fields per row, not the whole Player:
   `owner`, `principal`, `entries`, `isHouse`, `liveWeight`, `odds`.
4. `odds` is a percentage **string** with two decimals, `"12.34"`, not a
   fraction and not a number. `oddsPercent` in `api.service.ts` produces it.

Three nullability corrections in `GET /status` and `RoundDto`:
`operator` is null until the operator has run one tick, `cursor.ageSeconds` is
null when the indexer has never synced (deliberately not 0), the response also
carries `slot`, and `RoundDto.winningTile` is null until the round settles.

`POST /faucet` returns `{ owner, tokenAccount, amount, signature, nextRequestAt }`
on success and, on 429, a body carrying `retryAfterSeconds` alongside the Nest
error envelope. `requestFaucet` returns a third variant
`{ ok: false, retryAfterSeconds }` for it. `screens/Vault.tsx` shows the wait on
the button; ticket 11 turns it into a live countdown.

Where the client stays tolerant on purpose:

- **`status`** is typed `number | string` (`StatusValue` in `lib/protocol.ts`)
  and rendered through `labelEpochStatus` / `labelRoundStatus`, which accept
  the u8, its decimal string, or the name. The backend sends the u8 as a JSON
  number, since Prisma types it `Int`.
- **`EventDto.name`** is compared through `eventKey()` in `chain.ts`, which
  lower-cases the first letter, so the API's `RoundSettled` and a decoded log's
  `roundSettled` both match.
- **`EventDto.data`** field names: the client reads `amount`, `owner`, `tiles`,
  `total`, `reward`, `winner`, `forfeited`, and accepts `winningTile` or
  `winning_tile` and `jackpotAmount` or `jackpot_amount`.

`GET /feed` sends `Deposited`, `Withdrawn`, `PositionBought`, `RoundSettled`,
`JackpotPaid`, `EpochRolledOver`, and `PositionSettled` when its reward is
non-zero. `activityRows.ts` now renders all seven; `EpochRolledOver` had no
case and was silently dropping rows, which would have made the feed show fewer
entries than the API returned. A test pins the whole list.

### Deleted

- `src/screens/Prizes.tsx` and the EXPLORE tab (ticket 11 replaces it with
  Jackpot). Tabs are now MINE / VAULT / ABOUT, and STAKE was renamed VAULT
  because CONTEXT.md forbids "stake" as a noun for the deposit.
- `src/state.ts`. Its `useVaultState` was multi-pool discovery over
  `getProgramAccounts` plus receipt-token balances, none of which exists any
  more. Replaced by `useChainState` in `read.ts`, which is the whole of the
  ticket's read requirement in one place: Pool + Player + open Round, polled
  every 2 s (skipped while the tab is hidden) and re-read immediately on a
  `RoundSettled` log.
- `src/wallet.ts` and `src/wallet.test.ts` entirely. `clusterFromEnv`,
  `assertSupportedWallet`, `Cluster` and `SUPPORTED_CLUSTERS` were the
  `VITE_CLUSTER` machinery the ticket removes; `clusterEndpoint` is now the
  one-line `RPC_URL` in `chain.ts`; and `walletConfiguration` was dead code
  duplicating `walletModeFor` in `wallets.tsx`, used only by its own test.
- `src/useProgramEvents.test.ts` and the `EVENT_NAMES` list it guarded. The
  hook no longer subscribes by name: it takes one `connection.onLogs` and
  decodes with the program's own event coder, so there is no hardcoded list
  left to drift from the IDL.
- From `actions.ts`: `claimPrize`, `claimJackpot`, `claimRoundReward`,
  `refreshEntries`, `requestRoundRandomness`, `requestEpochDraw`,
  `randomClientSeed`, `ProofNodeJson`, `toProofNode`, `hexToBytes`, the
  slot-hashes sysvar. The operator does all of that now.
- From `chain.ts`: `configAddress`, `randomnessAddress`, `prizeVaultAddress`,
  `receiptAta`, `TOKEN_2022`, `ASSOCIATED_TOKEN`, `AccountApi.all()`.
- From `read.ts`: `listPools`, `listEpochs`, `listRounds`, `listPositions`,
  `listRandomness` and the old `PoolRow` / `EpochRow` / `RandomnessRow`.
- From `api.ts`: `fetchSnapshot`, `SnapshotFile`, `asSnapshotFile`,
  `fetchEvents`/`EventRow` (now `fetchFeed`/`EventDto`), `stringify`.
- From `lib/protocol.ts`: `epochMilestones`, `EpochWindows`, `Milestone`,
  `hexFromBytes`, `JACKPOT_STATUS`, `REQUEST_STATUS`, `REQUEST_KIND`. The
  tile-mask helpers are untouched.
- From `engine.ts`: `currentRound` and `latestSettled`. There is at most one
  round in view now, so both were list scans over a one-element list.

### Kept, with the reasoning

- `register(epochId)` is exported from `actions.ts` and nothing calls it yet.
  The ticket names it as one of the five, and the Jackpot screen in ticket 11
  is where a "register my weight" control belongs. Registration is also
  operator-cranked, so the button is a fallback, not the happy path.
- `jackpotVaultAddress` in `chain.ts` is exported and unused for the same
  reason: it is PDA-seed knowledge this ticket owns, and ticket 11 needs the
  live vault balance for the accruing jackpot before `close_registration`
  snapshots it.
- `normalize`/`decode` in `read.ts`, verbatim. The second-copy-of-web3.js
  problem it exists for has not gone away.

### Decisions a reader might question

1. **The dev burner stays, re-gated on the RPC url.** `burnerEnabled(env)` now
   requires `VITE_BURNER_WALLET=1` *and* `isLocalRpc(VITE_RPC_URL)`, which
   parses the url and compares the hostname to `localhost` / `127.0.0.1` (an
   unset or blank url counts as local, because `chain.ts` then defaults to the
   local validator). Deleting the burner was the alternative, but the
   outstanding acceptance run in this very ticket starts with "connect a
   burner". Because the gate decides whether an in-page keypair is offered at
   all, it has its own test: `src/dev-burner.test.ts`, which pins that
   `https://localhost.evil.example` is not localhost.
2. **The Anchor client camelCases the IDL on construction**
   (`convertIdlToCamelCase`), so `methods` is keyed `buyPosition`, not
   `buy_position`, and `account` is keyed `player`, not `Player`. Anything
   written against the raw JSON names silently resolves to `undefined`;
   `method()` and `accountOf()` in `chain.ts` throw instead of returning it.
3. **`RoundSettled` is detected by decoding, not by matching text.** Anchor's
   `emit!` writes `Program data: <base64>` and the event name never appears in
   plain text, so a `logs.includes("RoundSettled")` check would never fire.
   `decodeEventLogs` in `chain.ts` does the decode once and serves both
   `read.ts`'s settle trigger and the activity feed.
4. **`read.ts` also reads the Position**, which the ticket's list does not
   mention. Without it the UI cannot know whether the wallet already has a
   position in the open round (the buy button's lock) or whether one is waiting
   to be settled. It is one `getAccountInfo` on the same 2 s tick.
5. **A round that has settled stays in view.** `pool.open_round_id` goes to 0
   on settle, so the hook remembers the last non-zero round id and keeps
   reading that account. Otherwise the reveal animation and the settle button
   would vanish the instant the operator settled.
6. **A failed pool read no longer blanks the screen.** Anchor's `fetch` throws
   the same way for "account does not exist" and for a stuttering RPC, so the
   hook keeps the last good read and raises the banner instead of resetting to
   empty.
7. **`withdrawable` lives in `lib/money.ts`** (where its tests already were)
   and `read.ts` re-exports it, so both spellings in the ticket resolve to one
   implementation. The new test covers principal < entries, principal >
   entries, equality, and both zero cases.
8. **The round pot ticker is the round's `pot`, in Entries.** It used to be the
   jackpot vault's token balance. The Arena label changed from "HEXPOT" to
   "ROUND POT" because CONTEXT.md lists "HexPot" under what to avoid for
   Jackpot, and this number is the round pot, a different thing.

### Copy

`ControlPanel` and the deploy confirmation both state Entries in, Entries after
and withdrawable after. PT/ET, "bet", "stake" as a noun for the deposit,
"prize" and "claim" are gone from every user-visible string; `About.tsx` was
rewritten around Principal / Entries / Weight / Jackpot and no longer describes
Token-2022 receipts or the deleted ops CLI. Ticket 11 owns the visual design;
nothing here was restyled.

### Env

`.env.example` added at `apps/web/.env.example` with all five variables plus
`VITE_BURNER_WALLET`, and `apps/web/.env.local` written for local runs (it is
gitignored). `VITE_API_URL` defaults to `http://127.0.0.1:8080`, matching
`PORT=8080` in the backend's env. `apps/web/README.md` was updated to match.

### Still outstanding

The localnet end-to-end acceptance: burner, faucet, deposit, buy a position,
watch it settle, withdraw the matched amount, and confirm the numbers on screen
equal `GET /players/:owner` and the on-chain Player. It needs 07 and 08. Leave
this ticket open until that run passes.
