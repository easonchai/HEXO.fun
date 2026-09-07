# 11 Frontend: Vault, Jackpot, Leaderboard, status

Status: resolved
Type: task
Blocked by: 10

## Goal

The screens in PRD §4, using the existing HEXO design language and `src/ui.tsx` primitives.

## Scope

- **Vault**: Principal, Entries, withdrawable now, "the rest unlocks when the epoch resets in HH:MM"; deposit and withdraw forms with min/max guards; faucet button (devnet) with the 429 countdown.
- **Jackpot** (replaces Prizes): epoch countdown; jackpot amount with a visible "simulated 5% APR" label; your live weight and odds; during drawing, "Drawing epoch N, registered X of Y" and a "register me" fallback button; last five winners from `/epochs`.
- **Leaderboard** tab from `/leaderboard`.
- **Feed** in the arena panel from `/feed` with copy per CONTEXT.md.
- **Status pill** in the header from `/status`: green when the last tick is under 10 s old and no error; amber with the error text otherwise; the arena shows "operator paused" instead of a spinning countdown when stale.
- Copy audit: no "bet", "stake" as the deposit noun, "prize", "claim", "risk-free", "guaranteed". Every APR or yield figure carries "simulated".

## Acceptance

- Manual walkthrough of PRD §9 on localnet with a shortened epoch.
- `rg -i "bet|prize|claim|risk-free|guaranteed" apps/web/src` returns only code identifiers, no user-visible strings.

## Comments

Scope landed: the Vault's always-visible stats and unlock countdown, the
faucet's live 429 countdown, the new Jackpot screen, the new Leaderboard tab,
the header status pill, and the arena's stale-operator text. The Feed
requirement was already complete from ticket 10; read through it, changed
nothing.

### Verified

- `pnpm --filter @hexvault/web exec tsc -p tsconfig.json`: 0 errors.
- `pnpm --filter @hexvault/web exec vitest run`: 41 passed across 7 files
  (`status.test.ts` is new at 7 tests; `engine.test.ts` gained one case for
  `hmText`, now 6).
- `pnpm --filter @hexvault/web exec vite build`: succeeds. Not in this
  ticket's required checks, run anyway as a sanity pass; the only warning is
  the pre-existing large-vendor-chunk one from Privy/wallet-adapter, present
  before this change too.
- `rg -i "bet|prize|claim|risk-free|guaranteed" apps/web/src`: the same
  baseline ticket 10 recorded. "between" inside `useChainClock.ts`'s comment
  and eight `justify-content: space-between` CSS rules, plus the two Rust
  doc-comment strings inside the generated `idl/hex_vault.json`. No
  user-visible string anywhere in the diff matches.
- The PRD §9 localnet walkthrough was **not** run: no backend stack was up
  in this session, and the task said plainly not to fake it. This is the one
  open item; see below.

### What was built

- **`src/screens/Vault.tsx` gained a "YOUR VAULT" stat grid up front.** It
  makes Principal, Entries, withdrawable now, and the epoch-reset countdown
  always visible, not just after typing a withdraw amount. It reads "fully
  withdrawable" once Entries have caught back up to Principal, and "in
  HH:MM" otherwise, computed from the pool's own `currentEpochStart +
  epochSeconds` against the chain clock, not the API, matching ticket 10's
  chain-is-authoritative rule for Pool state. Deposit now also guards
  against depositing more than the wallet holds, with a note under the
  button. The faucet's 429 wait ticks down a real second at a time
  (`useEffect` plus `setTimeout`) and disables the button until it hits
  zero, instead of showing a static number that never moved.
- **`src/screens/Jackpot.tsx` is new.** It shows the epoch countdown from
  `/epochs/current`, the jackpot amount labeled "Jackpot (simulated 5%
  APR)", your weight and odds from `/players/:owner`, a "DRAWING EPOCH N"
  panel with registration progress and a "register me" button wired to the
  `register()` action ticket 10 left unused for exactly this screen, and the
  last five winners pulled from `/epochs`. It looks back 20 rows to find
  five, since rollovers leave `winner: null`.
- **`src/screens/Leaderboard.tsx` is new.** It renders `/leaderboard` rows
  as they arrive, already sorted by weight server-side, so there is no
  client-side sort. Your own row and the House row are both called out by
  name instead of an address.
- **The header status pill and the arena's stale text share one judgment
  call.** `src/status.ts`'s `summarizeStatus` decides "is the backend
  healthy" once; the header chip and `Arena` both read its result. Green
  needs a fresh operator tick, no operator error, and a fresh indexer
  cursor. `App.tsx` passes `operatorStale` into `Arena`, which swaps its
  round timer for "OPERATOR PAUSED" while that holds.
- **The Feed was already complete from ticket 10.** `activityRows.ts`
  handles all seven `/feed` event kinds, rendered in `ControlPanel`'s "LIVE
  MINERS" tier, with copy that already matches CONTEXT.md. Read through it,
  changed nothing.
- **New shared piece: `src/useApiPoll.ts`.** A small hook that polls one
  `api.ts` fetcher every 2 s and keeps the last good value on a failed poll.
  Used by the status pill, Jackpot (three polls) and Leaderboard.
  `hmText` (HH:MM) sits next to `timerText` (MM:SS) in `engine.ts` for the
  two epoch-length countdowns: Vault's unlock note and Jackpot's epoch
  countdown.

### Decisions

1. Tabs are now MINE / VAULT / JACKPOT / LEADERBOARD / ABOUT. Jackpot and
   Leaderboard render even without a connected wallet, since their data is
   API-only; only the "register me" button and the "your weight/odds" cells
   need one.
2. **The status pill's green state also checks the indexer cursor.** The
   Scope bullet names only the operator tick, but ticket 08 flagged that
   `cursor.ageSeconds` is `null` (not `0`) before the first sync and that
   the pill should treat null as "starting". Every aggregate screen reads
   through the indexer, so a stalled cursor makes that data stale even while
   the operator keeps ticking on-chain. It gates green too.
3. Jackpot's "your weight" shows the raw `liveWeight` figure, decimal-shifted
   like a token amount by the existing `atomicShort` (reused from
   `activityRows.ts`). It isn't actually hexUSDC; the ticket doesn't ask for
   an invented unit label, so it sits as a bare number next to "your odds",
   which is the number that actually decides anything.
4. The Vault's "Rest unlocks" stat always renders, not only when Entries are
   below Principal, so the stat grid's shape does not jump around mid-round.
5. PRD §4.5 also lists "current round id" as part of the small indicator;
   the Scope bullet for the status pill only names the green/amber rule and
   the arena's stale text, and the round id is already visible elsewhere
   (the timer, the feed rows), so it was left out of the pill itself.

### Still outstanding

The PRD §9 localnet walkthrough: connect a burner, faucet, deposit, play
three rounds and see one settle in your favor, read your odds on the Jackpot
screen, withdraw, and (with a shortened epoch) watch the draw pay a winner
with nobody clicking anything. Needs the backend stack up; not run here.
