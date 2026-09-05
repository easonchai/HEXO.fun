# 11 Frontend: Vault, Jackpot, Leaderboard, status

Status: ready-for-agent
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
