# Jackpot design (v1, sponsor-funded)

Implements PRD §6.7 and tokenomics §6 under the ET-only launch decision
(`docs/launch-decision.md`): v1 has **no fee revenue**, so jackpot funding is explicit,
disclosed sponsor/operator transfer only. Contribution rate, odds formula, and cap tweaks
that depend on fee revenue are deferred with Lane B.

## 1. Custody

- Each pool has a **`jackpot_vault`** token account, a PDA (`seed = ["jackpot-vault",
pool.key()`), authority = pool PDA, mint = the pool's immutable accepted asset.
- Allowed in: `fund_jackpot` (external token account → vault, event-tagged) and nothing else.
- Allowed out: `claim_jackpot` for the committed winner of a committed draw, and nothing else.
- Never receives or pays: principal vault funds, PT, ET, prize escrow, treasury (none exists).
- Because it is funded only by external transfers, principal can never reach it structurally —
  there is no instruction that moves USDC from `PrincipalVault` to `JackpotVault`.

## 2. Winner cohort and draw

**Cohort (fixed, disclosed before the epoch opens): eligible snapshot participants.**
The jackpot winner is selected from the **same committed Merkle-sum snapshot** as the
ordinary prize — every player whose ET weight is in the epoch snapshot is eligible with
weight-proportional probability. The cohort and the fact a jackpot draw will occur are
published in the epoch schedule before deposits open; nothing about eligibility can change
after the snapshot is committed.

**Draw mechanics (reusing the audited machinery):**

1. `commit_jackpot` — snapshot authority, while the epoch is `EPOCH_SNAPSHOT_COMMITTED`,
   commits `committed_amount = jackpot_vault.amount` (balance at commit time) into a
   per-(pool, epoch) `JackpotDraw` account, status `COMMITTED`. Committing also requires the
   ordinary prize snapshot to exist, so eligibility is identical and frozen.
2. `request_jackpot_randomness` — permissionless; creates a `RandomnessRequest` PDA with
   `kind = REQUEST_JACKPOT`, `subject = jackpot_draw.key()`, domain-bound separately from
   `REQUEST_PRIZE`.
3. `fulfill_jackpot_with_mock` — the configured authority supplies the sample; the program
   computes `target = unbiased_u64(sample, total_entry_weight)` (identical rejection-sampled
   mapping as the prize) and sets status `DRAWN`.
4. `claim_jackpot` — the winner proves membership with the same Merkle proof used for the
   prize; the program checks the proof's prefix interval contains `jackpot_target`, requires
   `now < claim_deadline`, pays exactly `committed_amount` from `jackpot_vault`, one time.
5. `expire_jackpot` — after the claim deadline, marks the draw `EXPIRED`. **No funds move:**
   the uncommitted remainder simply stays in the vault, which _is_ the rollover — the next
   epoch's `commit_jackpot` commits the larger balance. This makes rollover free of any
   transfer path that could be abused.

## 3. Properties and invariants

1. Contribution is disclosed: every inflow is a discrete event-tagged `fund_jackpot` transfer.
2. Balance, asset, history are queryable on-chain and in the indexer.
3. Separate domain-bound randomness request; cannot reuse or disturb the prize draw.
4. Full amount committed before selection; payout can never exceed the committed amount.
5. One winner, one claim, deadline-enforced, expiry is a one-time public transition.
6. Cohort cannot change after the snapshot; never configurable post-open.
7. Rollover requires zero privileged fund movement.
8. A committed but unresolved jackpot draw blocks `begin_next_epoch` (same rule as the
   ordinary prize), so two epochs can never commit overlapping claims against the same vault.

## 4. Explicitly out of scope for v1

- Per-round jackpot contributions from game revenue (needs Lane B).
- Tile-cohort jackpots ("all players on the winning tile") — viable later, but changes the
  odds structure and needs its own fairness review; v1 reuses the snapshot cohort.
- Jackpot caps and sponsor top-up automation — operations policy, documented in the
  maintenance guide when real sponsors exist.
- Any odds formula other than weight-proportional snapshot participation.

The whiteboard's 1-in-333 / 60-second parameters are **not adopted**; v1 odds are exactly
`(player weight) / (total snapshot weight)` — the same probability shape as the ordinary
prize, transparent and verifiable from published snapshot data.
