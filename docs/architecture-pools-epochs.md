# Architecture: isolated immutable-asset pools and configurable epochs

**Recommended and implemented architecture** for PRD §5A.

## 1. Recommendation: one program, many pool instances

Two viable models existed:

| Model                                             | Pros                                                                                                       | Cons                                                                                     |
| ------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| A. Separate deployed program per pool             | Hard isolation                                                                                             | N audits per asset, N upgrade pipelines, N program IDs, indexer/CLI/UI per-ID complexity |
| B. **Single program, per-pool accounts** (chosen) | One audited codebase, one IDL, uniform tooling; isolation enforced by per-pool accounts and PDA derivation | Program-level bug affects all pools (mitigated by audits + pause)                        |

**Chosen: B.** The PRD's requirement is _state isolation_ — "one accepted asset, principal
vault, prize escrow, jackpot escrow, game rules, cadence policy" per pool, immutable after
deployment. Model B delivers that: every custody and game account is derived from the pool
PDA, so no instruction can mix pools, and each pool's asset identity is frozen in its
`Pool` account at creation. Model A remains available later (deploy the same program at a
new ID) if an asset demands true program-level isolation.

## 2. Account model

```
ProtocolConfig (global, once)          Pool (per pool instance, PDA ["pool", pool_id])
  authority                              pool_id, paused
  guardian                               accepted_mint, accepted_token_program, decimals   ← immutable
  snapshot_authority                     principal_vault   (PDA ["principal-vault", pool]) ← immutable
  mock_randomness_authority              prize_vault       (PDA ["prize-vault", pool])     ← immutable
  production_mode                        jackpot_vault     (PDA ["jackpot-vault", pool])   ← immutable
  bump                                   min_deposit, max_stake_per_tile,
                                         max_round_bonus_entries,
                                         min_epoch_seconds, max_epoch_seconds,
                                         round_close_buffer_seconds, bump

Epoch       (PDA ["epoch", pool, id])         Round      (PDA ["round", pool, epoch_id, round_id])
Player      (PDA ["player", pool, owner])     Position   (PDA ["position", pool, round_id, owner])
RandomnessRequest (PDA ["randomness", pool, subject])    JackpotDraw (PDA ["jackpot-draw", pool, epoch_id])
```

Rules enforced by construction:

- Every fund-holding account is a PDA of this program, derived from the owning pool.
- Every instruction validates the pool PDA and derives all subordinate accounts from it —
  an attacker cannot substitute another pool's vault, epoch, or round.
- `Pool.accepted_mint` / `accepted_token_program` / vaults are set once at pool creation and
  never have a setter. Adding an asset = creating a new pool (itself an authority action,
  moving toward multisig per the launch gates).
- Roles stay program-global in v1 (one authority/guardian/snapshot authority). Per-pool roles
  are deliberately deferred: the same operator keys must exist anyway, and per-pool role
  matrices multiply account complexity without adding security until real org separation
  exists. Revisit at multisig adoption (launch gates).
- `paused` is per-pool: a guardian pauses a misbehaving pool without freezing the others.

## 3. Configurable epochs without retroactive rule changes

An epoch's full schedule is committed when the epoch account is created and is immutable:

```
EpochTiming { id, starts_at, entry_cutoff_at, ends_at, prize_snapshot_at, claim_deadline }
```

Program-enforced ordering: `starts_at < entry_cutoff_at <= ends_at <= prize_snapshot_at <=
claim_deadline`, plus pool-level bounds `min_epoch_seconds <= (ends_at - starts_at) <=
max_epoch_seconds`. `ends_at - starts_at` may be daily/weekly/monthly/custom — the bounds,
not a cadence enum, are the policy lever, which is why custom durations need no extra code.

What each timestamp gates:

- `entry_cutoff_at` — last moment for deposits, entry refresh _completion for new entries_,
  and `buy_position`. Explicit and published (PRD §6.4's "deposit/entry cutoff"), replacing
  the old behavior where the snapshot authority's commit was the de-facto cutoff (a hidden
  trust lever; shrinking it is part of the I-03 mitigation).
- `ends_at` — all rounds must lie within `[starts_at, ends_at]`.
- `prize_snapshot_at` — earliest `commit_prize_snapshot`.
- `claim_deadline` — last `claim_prize` / `claim_jackpot`; after it only expiry.

Retroactivity rules (PRD §5A.2): the schedule of an _open_ epoch can never be edited (there
is no edit instruction at all). Pool bounds changes would apply only to _future_ epochs; in
v1 there is no bounds-update instruction either — a pool's limits are as immutable as its
asset. A `set_pool_limits` instruction behind multisig/timelock is the documented future
upgrade path (launch gates), never a live one.

## 4. Snapshot, indexer, and reconciliation roles

The durable indexer (see `docs/localnet-ui-and-cli-plan.md`) independently recomputes the
canonical Merkle-sum root from events and stores it beside the authority-committed root.
They are compared on every reconciliation pass:

- match → snapshot verified, published to the API;
- mismatch → alert surface for operators and the visible trust-boundary disclosure (I-03).

This keeps the on-chain trust model unchanged while making deviation detectable rather than
silent.

## 5. Consequences

- Deposits/withdrawals/positions carry `pool` in every PDA and every event — per-pool
  accounting, audit trails, and indexer partitioning are exact.
- Multi-asset support is _structural but gated_: creating a pool accepts any mint
  mechanically, but the intended policy (PRD §5A asset profiles) is that pool creation is an
  authority-only, reviewed action. Devnet uses test USDC; no new asset without its review.
- The old global `config` accounts and instruction set are replaced wholesale; this is a
  devnet-stage breaking change by design (no live users; migration is out of scope and the
  program ID remains development-only).
