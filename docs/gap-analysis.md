# HexVault gap analysis

**Date:** 2026-09-03 · **Baseline commit:** `b7be49a` (docs: propose tokenomics and jackpot value flows)

Comparison of the current implementation against `docs/product-requirements.md` (PRD),
`docs/protocol.md`, `docs/security.md`, and `docs/tokenomics-proposal.md`.

Verified baseline before analysis (all green):

- `pnpm run check`, `pnpm run test:unit` (6 tests), `cargo test -p hex_vault --lib` (3 tests)
- `pnpm run test:program` — 5 integration tests on an isolated local validator
- `cargo fmt --check`, `anchor build` (Anchor 1.1.2 / Solana 3.1.10 / sbpf toolchain present)

---

## 1. What exists and works

| Area                           | State                                                                                                                 | Evidence                                    |
| ------------------------------ | --------------------------------------------------------------------------------------------------------------------- | ------------------------------------------- |
| Principal custody              | `PrincipalVault` / `PrizeVault` PDAs, config-PDA authority, deposit mints matched PT+ET, withdraw burns matched PT+ET | custody integration suite                   |
| Non-transferable receipts      | Token-2022 `NonTransferable` mints created in `initialize`                                                            | `lib.rs::create_non_transferable_mint`      |
| First-initializer guard (I-01) | `initialize` requires this program's `ProgramData` and upgrade authority                                              | integration test asserts attacker rejection |
| Epoch lifecycle                | open → snapshot committed → randomness requested → drawn → claimed/expired; rollover requires resolved prior epoch    | implemented, unit-level only                |
| Game rounds                    | 36 tiles, one immutable position per wallet/round, ET burned on buy, proportional ET bonus                            | implemented, partially tested               |
| Merkle-sum prize snapshot      | keccak domain-tagged leaf/node hashing, interval membership proof                                                     | Rust unit tests                             |
| Unbiased randomness mapping    | rejection sampling above `u64::MAX - (u64::MAX % range)`                                                              | Rust unit tests                             |
| Guardian pause                 | deposits and positions stop; withdrawals stay live                                                                    | implemented (partial test coverage)         |
| Indexer core                   | pure in-memory finalized-event reducer with cursor ordering + idempotency                                             | 6 unit tests, no persistence                |
| Wallet policy                  | Privy opt-in only; standard-wallet default; cluster allowlist                                                         | 3 unit tests, no UI                         |

## 2. Gaps against the PRD (must eventually close)

### G-01 — No multi-pool architecture (PRD §5A) — **architecture gap, fixed in this cycle**

The program is a single global protocol: one `ProtocolConfig` pins one USDC mint and one
vault pair. The PRD requires isolated pools, each with an immutable accepted asset, its own
principal/prize/jackpot vaults, and its own cadence policy. Resolved by the per-pool `Pool`
account design in `docs/architecture-pools-epochs.md` and implemented in this cycle.

### G-02 — No jackpot escrow or jackpot lifecycle (PRD §6.7, tokenomics §5–6)

The PRD requires a jackpot escrow distinct from principal and prize custody. Nothing exists:
no vault, no funding path, no draw, no claim. Resolved by `docs/jackpot-design.md` and the
`JackpotDraw` account + per-pool `jackpot_vault` implemented in this cycle.

### G-03 — Fee policy not implementable yet (PRD §6.7 options 1–3, tokenomics §2) — **decision, not code**

The 20/50/30 allocation has no fee base in the current model: ET is non-transferable and
cannot fund a treasury/buyback/jackpot. **Decision (docs/launch-decision.md): launch
ET-only; award game rewards whole; no fee, no burn, no Lane B in v1.** Per the standing
directive, PT-backed principal and non-transferable ET must never be used for fees,
jackpots, buybacks, burns, or staking rewards — so PRD option 1's "retire/burn the 6% ET"
is also rejected for v1. Lane B remains a separately-approved future upgrade.

### G-04 — Epoch schedule is authority-ad-hoc, not policy-bounded (PRD §5A "configurable cadence")

`EpochTiming` is supplied per-epoch with only pairwise sanity checks. There are no
pool-level duration bounds, no deposit/entry cutoff distinct from the snapshot time, and no
enforcement that claim deadlines exceed epoch end. Fixed in this cycle: pool-level
`min/max epoch seconds` bounds, an explicit immutable-at-open `entry_cutoff_at`, and full
ordering validation (`starts < cutoff <= ends <= snapshot <= deadline`).

### G-05 — Round bonus has no cap (open finding I-05)

`create_round` accepts any `bonus_entries`. Fixed in this cycle: pool-level
`max_round_bonus_entries` enforced at `create_round` and covered by tests.

### G-06 — Pause locks the withdrawal route for players with spent ET (violates PRD principle 6)

`refresh_entries` requires `!paused`. A player who spent ET cannot refresh during a pause,
so their principal becomes unwithdrawable for the whole pause. Refresh mints/burns only ET
(no USDC movement, no new risk) and is exactly the "documented withdrawal route" the pause
must preserve. Fixed in this cycle: refresh allowed while paused; pause matrix test added.

### G-07 — Prize claimable after the claim deadline (PRD §6.6)

`claim_prize` checks only `status == EPOCH_PRIZE_DRAWN`. Between the deadline passing and
anyone calling `expire_unclaimed_prize`, a winner can still claim. Fixed in this cycle:
`claim_prize` requires `now < claim_deadline`.

### G-08 — `expire_unclaimed_prize` is silent

No event is emitted, so the indexer and users cannot observe prize expiry. Fixed in this
cycle: `PrizeExpired` event.

### G-09 — Events carry no pool identity (PRD §8.11, §7.4)

All events are global. With multi-pool, indexers and audits cannot partition flows per pool.
Fixed in this cycle: every event carries `pool`.

### G-10 — Indexer is in-memory only (PRD §8.8)

No database, no RPC/log consumer, no restart survival, no reconciliation tooling, no API.
Closed in this cycle: durable Postgres indexer (finalized-only, cursor-persisted,
idempotent), reconciliation job, and a read API — see `docs/localnet-ui-and-cli-plan.md`.

### G-11 — No operator tooling

No CLI for pool/epoch/round lifecycle, snapshot export, randomness driving, or
reconciliation. Closed in this cycle: `packages/cli`.

### G-12 — No runnable local stack

No docker compose, no one-command bring-up of validator + Postgres + indexer + API.
Closed in this cycle.

### G-13 — Web app is a wallet-config stub

PRD Phase 1 wants a functional devnet UI. Deliberately kept minimal this cycle (designer is
building the real UI): a thin functional localnet app that wires wallet → program → API.
Plan only in `docs/localnet-ui-and-cli-plan.md`; placeholder styling.

### G-14 — Test coverage far below the security-review bar

`docs/preliminary-security-review.md` §"Mandatory test expansion" lists 8 required areas;
the repo covers roughly one of them (custody happy path + 2 rejection cases). Closed in
this cycle for the areas reachable in CI: pause matrix, epoch/round/prize/jackpot
lifecycles, role matrix, account-substitution rejections, cutoff enforcement, deadline
enforcement, multi-player rounding conservation. Property/fuzz coverage remains open
(G-14-residual, see `docs/launch-checklist.md`).

## 3. Residual gaps that remain open by design (devnet scope)

| Gap                                        | Why open                                                                                                                                                                       | Track                         |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------- |
| Production authenticated randomness (I-02) | No SVM provider contract available/selected; mock is hard-rejected in `production_mode`                                                                                        | mainnet gate                  |
| Snapshot root trust (I-03)                 | Root is authority-supplied; durable indexer now computes an independent canonical root for reconciliation, but on-chain root stays authority-committed until multisig/timelock | mainnet gate                  |
| Randomness retry/cancellation (I-04)       | Rejection-tail samples still strand mock requests; harmless for mock (re-fulfillable), blocking for one-shot VRF                                                               | before provider integration   |
| Multisig/timelock governance               | Not implementable meaningfully pre-launch; roles are separate keys on devnet                                                                                                   | mainnet gate                  |
| Yield adapter                              | Deliberately disabled; prizes are sponsor-funded                                                                                                                               | separate approval             |
| Lane B transferable-reward game + 20/50/30 | Requires legal review and separate terms                                                                                                                                       | `docs/launch-decision.md`     |
| HEX token                                  | Rejected for now                                                                                                                                                               | `docs/hex-tokenomics-memo.md` |
| External audit, legal review, bug bounty   | Launch gates                                                                                                                                                                   | `docs/launch-checklist.md`    |

## 4. Audit findings on the existing code (critical review)

Beyond the documented findings (I-01..I-05), this review adds:

1. **G-06 (high, fixed)** — pause-withheld refresh strands principal. Arguably the most
   user-hostile defect in the repo; it contradicts PRD principle 6 and `docs/security.md`
   invariant 2's spirit.
2. **G-07 (medium, fixed)** — deadline is advisory, not enforced.
3. **Timing validation hole (fixed)** — `validate_epoch_timing` permitted
   `claim_deadline < ends_at` and `prize_snapshot_at` anywhere in `[ends_at, deadline]`
   with no cutoff concept; a snapshot before round close could strand open rounds against a
   frozen snapshot.
4. **Event hygiene (fixed)** — expiry silent, no pool tags, no jackpot events.
5. **Liveness hole found during refactor (fixed)** — a randomness request that is never
   fulfilled (stalled authority, rejection-tail sample) permanently blocked
   `begin_next_epoch`, a permissionless DoS on pool rollover; expiry now cancels stuck
   draws for both the prize and the jackpot.
6. **Accepted-asset validation gap (fixed)** — `create_pool` did not verify that the
   accepted mint is owned by the declared accepted token program (PRD §8.13); a mismatched
   pair passed creation and failed later at vault init with an opaque token error. The
   program now rejects it at creation (`MintTokenProgramMismatch`).
7. **Verified non-issues** (checked, no change needed): single-commit snapshot immutability
   (second `commit_prize_snapshot` fails on epoch status); position PDA uniqueness prevents
   double purchase; overflow-safe stake math incl. `u64::MAX % range` rejection; prize
   payment physically unable to touch `PrincipalVault` (distinct PDA + transfer path);
   Token-2022 non-transferable receipts block user transfers at the token program level.

Two further defects were caught by the build/test cycle and fixed in the same pass:

- The indexer's Merkle-sum proof builder could truncate sibling paths for trees larger
  than two leaves (loop bound on node count instead of leaf count); caught by the
  parallel-built integration suite, verified fixed by a property test proving every
  leaf's proof resolves and the claimed intervals tile the weight space exactly.
- The CLI's chain snapshot export skipped Token-2022 token accounts carrying extensions
  (exact-length filter) — ET accounts carry `ImmutableOwner`, so every snapshot exported
  from chain was empty; offsets are fixed in the base layout, only length varies.
