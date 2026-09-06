# 14 Weekly draw and the hexpot

Status: resolved
Type: task
Blocked by: 11

## Goal

Two words were doing three jobs. On screen, "jackpot" named both the epoch's
yield prize and the thing under the board that main called the HEXPOT, and
"epoch" leaked the mechanism name into player copy. Split them: the epoch draw
is the **weekly draw**, what it pays is the **prize**, and the pool's jackpot
vault balance is the **hexpot**, shown under the board again.

## Scope

Frontend and docs only. The API, Prisma schema, program and IDL keep
`jackpot` in every identifier; nothing below the API boundary changes.

- Tab `JACKPOT` becomes `WEEKLY DRAW`. The screen file, test ids and CSS
  comments follow (`WeeklyDraw.tsx`, `weekly-draw-screen`, `prize-amount`).
- "Prize" is the noun for the weekly amount: headline stat, last winners,
  the payout feed row. "Jackpot" leaves player-facing copy.
- "Epoch" leaves the screen: "week #4", "draw in 3d 4h", "this week",
  "drawing week 4". Code, API and docs keep epoch as the mechanism name.
- The odometer under the board is labelled HEXPOT again and shows the
  jackpot vault's token balance, read over RPC on the existing 2 s poll. It
  pulses when the vault moves (funding, payout, rollover) and when round
  tokens fly in. The round pot moves to its own row in the stake panel.
- Feed rows: payout is `prize`, registration is `weekly draw`, rollover says
  "stays in the hexpot".
- `CONTEXT.md`: new **Weekly draw** entry, **Hexpot** becomes the glossary
  name for the jackpot vault balance instead of a forbidden word, Epoch drops
  "week" from its avoid list, "tickets" stays avoided.
- README and PRD prose say weekly draw. PRD epoch length becomes seven days
  so "weekly" is literal. Devnet pool 1 keeps its 15 minute epochs for
  testing; the countdown shows the real time either way.

## Out of scope

A grand jackpot that accumulates on its own and is won rarely, separate from
the weekly prize. Decided in principle, unfunded in design: the funding source
(House wins, fees, a yield skim) and the win condition are open. Spec it
before any code.

## Acceptance

- `rg -i jackpot apps/web/src --glob '!*.json'` matches only API field names
  (`jackpotAmount`, `jackpotPaid`, `jackpotVault`) and one backend error
  string in a test.
- `rg -i epoch apps/web/src/screens apps/web/src/App.tsx` matches only code
  identifiers and comments, no JSX text.
- The HEXPOT odometer shows the jackpot vault balance on a live pool.
- `pnpm --filter @hexvault/web check` and vitest pass.

## Comments

Landed in one commit on `feature/improvements`. The hexpot read is one extra
`getTokenAccountBalance` per poll; the round pot row in the stake panel is
always visible rather than only inside the buy preview, since it is useful
before a tile is picked.
