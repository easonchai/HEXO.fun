# Test, audit, legal/compliance, and mainnet launch checklist

**Product status: devnet-only.** No item below may be marked done without written evidence.
Mainnet (or any real-asset deployment) requires every section complete.

## A. Testing (expand until Section A is fully green in CI)

| #   | Item                                                                                                                                                                                                                             | Evidence required              | Status     |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------ | ---------- |
| A1  | Daily matrix green: `pnpm run check`, `test:unit`, `test:program`, `format:check`, `cargo fmt --check`, `cargo test --lib`, `git diff --check`                                                                                   | CI run URL per merge           | ✅ local   |
| A2  | Custody: deposit mints matched PT+ET post-transfer; matched-burn withdrawal; prize funding segregation                                                                                                                           | integration suite              | ✅         |
| A3  | Pause matrix: deposit/round/position/snapshot stop; **refresh + withdrawal stay live**; guardian-only                                                                                                                            | integration suite              | ✅         |
| A4  | Epoch lifecycle: first/next epoch, non-sequential + unresolved-prior rejection, timing ordering + pool bounds enforced, entry cutoff enforced                                                                                    | integration suite              | ✅         |
| A5  | Round lifecycle: window checks, one-position immutability, duplicate rejection, settlement after close only, replay rejection, multi-player proportional reward with rounding conservation (Σ rewards ≤ bonus), bonus cap (I-05) | integration suite              | ✅         |
| A6  | Prize lifecycle: funding bound, snapshot after snapshot_at only, single commit, draw replay rejection, non-winner/wrong-weight proof rejection, single claim, claim blocked after deadline, expiry evented, rollover gating      | integration suite              | ✅         |
| A7  | Jackpot lifecycle: fund→commit→draw→claim/expire, separate domain binding, deadline + rollover, unresolved draw blocks next epoch                                                                                                | integration suite              | ✅         |
| A8  | Role matrix: authority/guardian/snapshot/mock-randomness rejections incl. first-initializer takeover                                                                                                                             | integration suite              | ✅         |
| A9  | Account substitution: wrong mint, wrong token program, wrong vault, foreign PDA, wrong owner ATA — all rejected                                                                                                                  | integration suite              | ✅         |
| A10 | Indexer: idempotency, out-of-order rejection, restart replay from cursor, canonical root equality, reconciliation mismatch detection                                                                                             | unit + integration vs Postgres | ✅         |
| A11 | End-to-end: multi-pool CLI scenario → indexer parity → API responses → web smoke                                                                                                                                                 | e2e script                     | ✅         |
| A12 | Property/fuzz: arithmetic extremes, random deposit/play/withdraw sequences vs PT-supply invariant, Merkle fuzz, instruction-data fuzz                                                                                            | fuzz harness                   | ⬜ Cycle 2 |
| A13 | Randomness-provider drills: timeout, rejection-tail retry, cancellation, double-fulfill                                                                                                                                          | provider integration           | ⬜ Cycle 2 |

## B. Security audit

| #   | Item                                                                                                                                                                                                | Status                           |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------- |
| B1  | Freeze release candidate commit + reproducible build instructions                                                                                                                                   | ⬜                               |
| B2  | Commission independent Solana/Anchor audit (source, IDL, threat model, tests, deployed artifact)                                                                                                    | ⬜                               |
| B3  | Remediate all critical/high; publish remediation matrix                                                                                                                                             | ⬜                               |
| B4  | Dependency review + lockfile audit; pin toolchains                                                                                                                                                  | partial (pinned; review pending) |
| B5  | Public responsible-disclosure channel + bug bounty                                                                                                                                                  | ⬜                               |
| B6  | Randomness provider independent review (closes I-02/I-04) — ORAO v2 pull integration implemented (docs/vrf-randomness.md); review covers seed mixing, binding, and the ORAO quorum trust assumption | partial (code done; review ⬜)   |
| B7  | Snapshot/indexer trust-boundary review incl. challenge process (closes I-03 residual)                                                                                                               | ⬜                               |
| B8  | 2-of-3 Squads multisig + timelock for authority/guardian/snapshot roles; key ceremony documented                                                                                                    | ⬜                               |
| B9  | Upgrade-authority plan: multisig holds it **before** first initialization on any real deployment                                                                                                    | ⬜                               |

## C. Legal / compliance

| #   | Item                                                                                                          | Status                |
| --- | ------------------------------------------------------------------------------------------------------------- | --------------------- |
| C1  | Classification opinion: prize-linked savings + game + (future) jackpot in each target jurisdiction            | ⬜                    |
| C2  | Eligibility, geo-blocking, KYC/age policy; excluded-jurisdiction enforcement plan                             | ⬜                    |
| C3  | Terms of service, risk disclosures (incl. "spending entries defers withdrawal to next epoch"), privacy notice | ⬜                    |
| C4  | Prize terms: amount schedule, sponsor terms, **unclaimed-prize treatment**, tax reporting responsibility      | ⬜                    |
| C5  | Approved brand language: "entries", "seasonal reward"; no "bet/wager/risk-free/guaranteed"                    | ⬜                    |
| C6  | Lane B (transferable rewards/fees) decision + counsel sign-off — **prerequisite for any fee**                 | ⬜ (rejected for v1)  |
| C7  | HEX launch decision per `docs/hex-tokenomics-memo.md` gates                                                   | ⬜ (rejected for now) |

## D. Operations & launch

| #   | Item                                                                                                     | Status                             |
| --- | -------------------------------------------------------------------------------------------------------- | ---------------------------------- |
| D1  | Durable indexer in production config (managed RPC/webhook source), alerting on cursor lag/reorg/mismatch | ⬜ (local compose done)            |
| D2  | External monitoring: vault deltas vs PT supply, failed settlement, callback failures; on-call rotation   | ⬜                                 |
| D3  | Incident runbook + pause drill executed by guardian multisig                                             | ⬜ (runbook exists; drill pending) |
| D4  | Published: program ID, verified build, role addresses, version, status page, season archive              | ⬜                                 |
| D5  | Reproducible build verification by a second party                                                        | ⬜                                 |
| D6  | Launch caps (deposit cap, TVL cap) + eligibility approved and enforced                                   | ⬜ (TBD by policy)                 |
| D7  | Randomness provider SLO + fallback policy documented                                                     | ⬜                                 |
| D8  | Yield strategy: **stay disabled** unless separately approved per PRD §9                                  | ✅ (disabled)                      |
| D9  | Written sign-off: engineering, security, legal, product — before first real deposit                      | ⬜                                 |

## E. Definition of done for mainnet

E = (A1–A12 ∧ B1–B9 ∧ C1–C5 ∧ D1–D9) with A13/B6/B7 specific to the chosen provider.
Anything short of E remains devnet/testnet. This file is the gate record; update it, with
links to evidence, as items complete.
