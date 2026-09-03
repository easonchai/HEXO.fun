# HexVault protocol specification (devnet MVP)

**Status:** implementation contract

## Scope and non-goals

HexVault is an active savings-lottery prototype. Each pool accepts one immutable asset
(test USDC on devnet). It provides deterministic accounting, a 36-tile entry game, an
asynchronous randomness boundary, a sponsor-funded prize vault, and a sponsor-funded
jackpot vault with rollover.

It does **not** deploy user principal into a third-party lending market, issue a return
guarantee, permit mainnet deposits, charge any fee, or claim regulatory clearance. A yield
integration changes the risk profile: neither a stablecoin nor a lending protocol makes
principal economically risk-free.

## Units

All token values are unsigned `u64` atomic units at the pool asset's decimals (six for
USDC). `1_000_000` units represents `$1.00`. PT and ET use the same scale.

## Account model

| Account             | PDA seed                          | Purpose                                                                          |
| ------------------- | --------------------------------- | -------------------------------------------------------------------------------- |
| `ProtocolConfig`    | `config`                          | program-global roles: authority, guardian, snapshot authority, mock randomness   |
| `Pool`              | `pool`, pool id                   | immutable asset identity, receipt mints, three vaults, limits, `latest_epoch_id` |
| `Epoch`             | `epoch`, pool, epoch id           | immutable schedule, prize snapshot, jackpot state, remaining prize claim         |
| `Round`             | `round`, pool, epoch id, round id | game window, selected tile, per-tile ET totals, finalization state               |
| `Player`            | `player`, pool, owner             | canonical per-pool entry-refresh pointer                                         |
| `Position`          | `position`, pool, round, owner    | exactly one immutable board purchase per player and round                        |
| `RandomnessRequest` | `randomness`, pool, subject, kind | binds a provider request to round / prize / jackpot; prevents replay             |

PT and ET are non-transferable Token-2022 mints created per pool with the pool PDA as mint
authority; their constrained Token-2022 balances are the authoritative balance record.
Principal, prize, and jackpot vaults are per-pool PDAs with the pool PDA as authority.
No user-controlled account can become a vault, mint authority, or randomness request, and
no account from one pool can be substituted into another pool's instruction: every
subordinate PDA is derived from the pool PDA and re-validated by seed.

### Pool creation and immutability

`create_pool` (authority only) freezes, for the pool's lifetime: the accepted mint, its
token program (validated against the mint's on-chain owner at creation), decimals, both
receipt mints, the three vault addresses, and all limits (`min_deposit`,
`max_stake_per_tile`, `max_round_bonus_entries`, epoch duration bounds, round close
buffer). There is no update instruction; changing any of these means deploying a new pool.

## Deposit and withdrawal

### Deposit

1. User transfers the accepted asset into the pool's `principal_vault`.
2. Program mints equal PT and ET to the user's receipt ATAs.
3. Blocked when the pool is paused, or at/after the epoch's `entry_cutoff_at`.

Invariant after a successful deposit:

```text
principal_vault.amount >= PT mint supply
user PT amount and ET amount each increase by the deposited amount
```

### Withdraw

A withdrawal for `x` requires `x > 0`, `PT >= x`, and `ET >= x` for the same owner. It
atomically burns `x` PT and `x` ET, then transfers exactly `x` from `principal_vault` to
the owner's token account. It is never blocked by pause, epoch state, or rollover, and
prize/jackpot escrow is never an alternate liquidity source.

A player who has spent ET can withdraw only the matched portion of principal. The
remainder becomes withdrawable when entries are refreshed to match principal — refresh is
**allowed while paused** because it only restores the matched-withdrawal route (PRD
principle 6): it moves no custody asset and creates no exposure.

## Epoch lifecycle

An epoch's full schedule is committed at creation and immutable:

```text
starts_at < entry_cutoff_at <= ends_at <= prize_snapshot_at <= claim_deadline
ends_at - starts_at within the pool's [min_epoch_seconds, max_epoch_seconds]
```

`entry_cutoff_at` stops deposits (rounds may settle afterwards); `prize_snapshot_at` opens
the snapshot window; `claim_deadline` closes prize and jackpot claims. Only a future epoch
can have a different schedule — there is no edit instruction at all.

1. **Open:** deposits and positions accepted until their cutoffs.
2. **Prize snapshot:** the snapshot authority commits a Merkle-sum root of entry weights,
   the total weight, and the prize amount (bounded by the prize vault balance), exactly
   once, at/after `prize_snapshot_at`, only while the epoch is open and the pool is not
   paused. The indexer independently recomputes the canonical root at the commit slot and
   reconciliation compares the two (see the snapshot trust note in
   `docs/preliminary-security-review.md`).
3. **Jackpot commit:** while the epoch is snapshot-committed, the authority may commit the
   current jackpot vault balance as the epoch's jackpot (`docs/jackpot-design.md`). The
   cohort is the committed snapshot; unclaimed jackpots roll over by remaining in the
   vault.
4. **Randomness:** permissionless requests create domain-bound request PDAs (kind 0 round,
   1 prize, 2 jackpot); only the configured authority fulfills, exactly once per request.
   Winner selection uses unbiased rejection sampling over total snapshot weight; modulo
   reduction alone is forbidden. A request that is never fulfilled does not strand the
   epoch: expiry (below) also cancels stuck draws.
5. **Claim:** the selected owner claims the committed prize from the prize vault, or the
   committed jackpot from the jackpot vault, by proving their snapshot interval (Merkle
   proof + winning interval). Both are deadline-enforced, one-time, and cannot touch any
   other escrow.
6. **Expiry:** after the claim deadline, an unclaimed prize is marked expired (events
   emitted), and a stuck or unclaimed jackpot draw likewise expires with **no funds
   moved** — the balance remains escrowed for future epochs.
7. **Rollover:** `begin_next_epoch` requires the prior epoch's prize to be claimed/expired
   **and** its jackpot (if any) claimed/expired, so two epochs can never hold overlapping
   claims against the same vault. Each player may then permissionlessly refresh: ET is
   adjusted to exactly current PT (mint if lower, burn if higher) and `last_refresh_epoch`
   advances.

## Game rounds

A round contains exactly **36** indexed tiles (`0..35`) and must lie wholly inside its
epoch.

- A wallet makes **at most one** `buy_position` per round; the position is immutable.
- That single call selects any non-empty tile subset with one stake amount per tile,
  overflow-checked; the total ET is burned atomically.
- Buys stop at the round's close (`ends_at - pool.round_close_buffer_seconds`).
- At close, anyone requests randomness; on fulfillment the winning tile is chosen by
  unbiased mapping, and a covering position earns `bonus * stake_on_tile / total_on_tile`
  additional ET. The bonus is bounded by the pool's `max_round_bonus_entries` at
  `create_round`, is ET-only, and multi-player settlement conserves: Σ rewards ≤ bonus.
- The bonus never mints PT, never transfers the accepted asset, and never touches any
  vault. Losing ET is permanently spent for the current epoch.

## Randomness provider boundary

The devnet MVP has an explicit mock asynchronous randomness authority, rejected whenever
`ProtocolConfig.production_mode` is enabled (no instruction sets it today). Request PDAs
are domain-separated per kind and per subject, so a round draw cannot be replayed against
a prize and vice versa. A production provider integration with timeout, retry,
cancellation, and key rotation is a mainnet gate (I-02, I-04).

## Governance and emergency controls

- The devnet config authority initializes the protocol, creates pools, epochs, and rounds.
  No timelocked parameter-update instruction exists yet.
- A guardian may pause a single pool, which stops deposits, round creation, position
  purchases, and snapshot/jackpot commits — but never withdrawals, entry refresh, reward
  claims, prize/jackpot claims, or expiries.
- Withdrawals remain live in every state. A pause must not create a custody lock.
- Mainnet requires a named 2-of-3 Squads multisig for all roles, a timelock, a verified
  build, and a completed independent audit (`docs/launch-checklist.md`).

## Yield adapter boundary

No yield path exists in the current program. A future `YieldAdapter` may move only a
capped, verified surplus into a prize vault — never the reverse, and never from
`PrincipalVault` — and requires separate approval per `docs/product-requirements.md` §9.
