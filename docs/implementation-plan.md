# Phased implementation plan

Status after the 2026-09-03 build cycle. Estimates are for one engineer with the repo's
established toolchain (Anchor 1.1.2, Solana 3.1.10, Node 22, pnpm).

## Cycle 1 — devnet protocol hardening + full backend (this cycle, shipped)

| #   | Work                                                                                                                                                                                                                        | Depends on    | Estimate | Status |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------- | -------- | ------ |
| 1   | Deliverable docs (gap analysis, architecture, jackpot, launch decision, HEX memo, plans, checklist)                                                                                                                         | —             | 1d       | done   |
| 2   | Program refactor: per-pool accounts, immutable asset/vault identity, schedule bounds + entry cutoff, bonus cap (I-05), refresh-during-pause fix (G-06), claim-deadline enforcement (G-07), expiry event, pool-tagged events | 1 (decisions) | 2–3d     | done   |
| 3   | Jackpot: vault, fund, draw lifecycle, claim, rollover, events                                                                                                                                                               | 2             | 1d       | done   |
| 4   | Expanded test suite: pause matrix, epoch/round/prize/jackpot lifecycles, role matrix, substitution rejections, conservation                                                                                                 | 2,3           | 1–2d     | done   |
| 5   | Durable Postgres indexer: log consumer, Anchor event decode, cursor, idempotency, canonical snapshot root, reconciliation                                                                                                   | 2 (IDL)       | 2d       | done   |
| 6   | Read API (Fastify): pools/epochs/rounds/positions/prize/jackpot/health/reconciliation, pino logs, metrics                                                                                                                   | 5             | 1d       | done   |
| 7   | Ops CLI (`packages/cli`): full lifecycle incl. snapshot export + reconcile                                                                                                                                                  | 2 (IDL)       | 1d       | done   |
| 8   | Minimal functional localnet web app (designer replaces styling later)                                                                                                                                                       | 5,6           | 1d       | done   |
| 9   | Docker compose: postgres + api + indexer (+ optional validator profile), migrations, env templates                                                                                                                          | 5,6           | 0.5d     | done   |
| 10  | End-to-end validation: multi-pool e2e via CLI on local validator, indexer↔chain reconciliation, compose stack up, all suites green; docs sync                                                                              | all           | 1d       | done   |

## Cycle 2 — production randomness + governance (blocks devnet→public testnet)

| #   | Work                                                                                                                                                                                      | Depends on      | Estimate |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------- | -------- |
| 11  | Select SVM randomness provider (ORAO / Switchboard / Switchboard-On-Demand); implement authenticated callback with domain binding, timeout, cancellation, re-request (closes I-02 + I-04) | vendor decision | 1–2 wk   |
| 12  | `production_mode` enablement path + provider monitoring + callback failure drills                                                                                                         | 11              | 3d       |
| 13  | Squads 2-of-3 multisig for authority/guardian/snapshot roles + timelocked `set_pool_limits` + change-record process (closes governance gap; enables per-pool roles if wanted)             | —               | 1 wk     |
| 14  | Property/fuzz testing (_anchor_ fuzz or custom): arithmetic extremes, account substitution, Merkle fuzz, epoch-sequence randomization (closes G-14 residual)                              | 4               | 1 wk     |
| 15  | Devnet deployment ceremony: dedicated keys, smoke runbook, published program ID + verified build                                                                                          | 13              | 2d       |

## Cycle 3 — public testnet readiness (PRD Phase 2)

| #   | Work                                                                                                                                  | Depends on       | Estimate                   |
| --- | ------------------------------------------------------------------------------------------------------------------------------------- | ---------------- | -------------------------- |
| 16  | Full production UI by designer (accessibility: WCAG 2.2 AA, keyboard board, reduced motion), disclosure flows, cutoff/deadline states | 8; design assets | 2–4 wk                     |
| 17  | Observability: alerting on reconciliation mismatch, vault deltas, callback failures, stale cursor                                     | 6,15             | 1 wk                       |
| 18  | Freeze release candidate → independent audit → remediation matrix                                                                     | 11–17            | 4–8 wk (audit queue-bound) |
| 19  | Legal/compliance review: wording, geography, eligibility, prize terms, unclaimed-prize policy                                         | —                | parallel with 18           |

## Cycle 4 — limited mainnet (PRD Phase 3)

Gate-gated only; see `docs/launch-checklist.md` for the full checklist with owners.

## Dependency graph (cycles)

```
docs(1) → program(2) → jackpot(3) → tests(4) ─┐
              └→ IDL → indexer(5) → api(6) ───┼→ e2e(10)
                      └→ cli(7) ──────────────┤
                      └→ web(8) ──────────────┘
                      └→ compose(9) ──────────┘
cycle 2: randomness(11→12) + multisig(13) + fuzz(14) → devnet deploy(15)
cycle 3: ui(16) + observability(17) → freeze → audit(18) ∥ legal(19)
cycle 4: launch checklist all-green
```

## Standing rules applied throughout

- Devnet-only until every launch gate has written approval.
- No PT/principal or ET in fees, jackpots, buybacks, burns, staking — enforced structurally.
- Smallest change that satisfies the PRD; no speculative abstractions (Lane B and HEX
  remain unimplemented by decision, not by omission).
