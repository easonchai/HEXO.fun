# 13 Demo smoke test and runbook

Status: ready-for-agent
Type: task
Blocked by: 12

## Goal

Prove the deployed demo does the PRD §9 loop and leave instructions for keeping it alive.

## Scope

- Playwright script `apps/web/e2e/demo.spec.ts` against the Vercel URL with `VITE_BURNER_WALLET` style burner or Privy test mode: faucet → deposit 100 → buy a position on 3 tiles → wait for settle → assert Entries changed and withdrawable shows `min(principal, entries)` → withdraw the matched amount.
- Runbook additions: what to check when the status pill is amber (RPC key exhausted, ORAO stalled → rounds voiding, authority out of SOL, Postgres disk), how to change epoch length for a live demo (`set_params` via a tiny `pnpm --filter backend admin set-params` command), how to top up the authority with SOL and hexUSDC.
- A one-off `admin` command group in the backend for `set-params`, `pause`, `unpause`, `fund-jackpot`, all thin wrappers over `ChainModule`.

## Acceptance

- The Playwright run passes against the live URL.
- A teammate who has not seen the code can follow the runbook to reset the demo pool in under 10 minutes.
