# HexVault protocol specification (devnet MVP)

**Status:** implementation contract

## Scope and non-goals

HexVault is an active savings-lottery prototype. The initial deployment accepts only devnet USDC. It provides deterministic accounting, a 36-tile entry game, an asynchronous randomness boundary, and a sponsor-funded prize vault.

It does **not** deploy user principal into a third-party lending market, issue a return guarantee, permit mainnet deposits, or claim regulatory clearance. A yield integration changes the risk profile: neither a stablecoin nor a lending protocol makes principal economically risk-free.

## Units

All token values are unsigned `u64` atomic USDC units (six decimals). `1_000_000` units represents `$1.00`. PT and ET use the same unit scale.

## Account model

| Account             | Owner / PDA seed              | Purpose                                                                      |
| ------------------- | ----------------------------- | ---------------------------------------------------------------------------- |
| `ProtocolConfig`    | `config`                      | immutable mint identities; authority, guardian, status, timing, and limits   |
| `PrincipalVault`    | `principal-vault`             | segregated USDC that backs aggregate PT exactly                              |
| `PrizeVault`        | `prize-vault`                 | USDC funded by sponsor/yield adapter; only source of prize claims            |
| `Epoch`             | `epoch`, epoch ID             | weekly lifecycle, prize snapshot, selected winner, and remaining prize claim |
| `Round`             | `round`, epoch ID, round ID   | game time bounds, selected tile, total ET placed by tile, finalization state |
| `Player`            | `player`, owner               | canonical PT/ET accounting, last refreshed epoch, round-position nonce       |
| `Position`          | `position`, round, player     | exactly one immutable board purchase for the player and round                |
| `RandomnessRequest` | `randomness`, domain, subject | binds a provider request to a particular round or epoch and prevents replay  |

PT and ET are represented by non-transferable Token-2022 mints held in owner-associated token accounts. The `Player` account is the canonical source of epoch semantics; token balances are reconciled by constrained program CPIs. No user-controlled account may become a vault, mint authority, or randomness request.

## Deposit and withdrawal

### Deposit

1. User transfers devnet USDC from a token account constrained to the configured USDC mint into `PrincipalVault`.
2. Program mints equal PT to the user.
3. Program mints equal ET to the user if the current epoch is open; otherwise the next epoch refresh produces it.
4. `Player.principal_amount` and `Player.entry_amount` increase equally.

Invariant after a successful deposit:

```text
principal_vault.amount >= sum(all Player.principal_amount)
user PT amount == Player.principal_amount
user ET amount == Player.entry_amount
```

### Withdraw

A withdrawal for `x` requires `x > 0`, `PT >= x`, and `ET >= x` for the same owner. It atomically burns `x` PT and `x` ET, decrements the canonical balances, then transfers exactly `x` USDC from `PrincipalVault` to the owner’s USDC token account. Prize escrow is never an alternate liquidity source.

A player who has spent ET can withdraw only the matched portion of principal. The remaining principal becomes withdrawable only when ET is replenished at rollover (or if a game reward increases ET). This is intentional and must be disclosed in product UI.

## Epoch lifecycle

An epoch is one UTC week in production (short durations are configured only for local/devnet tests).

1. **Open:** deposits, positions, and games are accepted until configured cutoffs.
2. **Prize snapshot:** a permissionless instruction marks the epoch closed and records each eligible player’s ET weight. The production high-concurrency design uses a Merkle root published by the indexer plus on-chain root commitment; the MVP initially snapshots participant PDAs in bounded batches. New deposits and positions cannot alter this snapshot.
3. **Randomness request:** a permissionless relayer creates a provider-bound request after snapshot finality.
4. **Randomness fulfill:** only the configured, authenticated provider callback can write the result, exactly once. The winner selection uses unbiased rejection sampling over total snapshot ET weight; modulo reduction alone is forbidden.
5. **Claim:** the selected owner may claim up to the prize amount already reserved in `PrizeVault`. A claim cannot exceed the prize escrow balance or be paid twice.
6. **Rollover:** after the prize state is final, each player may permissionlessly refresh. ET is adjusted to exactly current PT (mint if lower; burn if higher), and `last_refreshed_epoch` advances. This expires in-epoch game advantages after the prize snapshot while restoring withdrawal capacity.

## Game rounds

A board contains exactly **36** indexed hex tiles (`0..35`). A round must lie wholly inside its parent epoch and has a configured open window plus a closing buffer.

- A wallet makes **at most one** `buy_position` call per round.
- That single call selects any non-empty subset of tiles and provides one ET stake amount for each selected tile. The total is checked with overflow-safe arithmetic and burned/escrowed atomically.
- The position is immutable once created: no top-up, tile change, cancellation, or second purchase is permitted.
- At close, anyone requests randomness. On callback, a selected tile is `randomness mod 36` only after a bias-resistant mapping; the program then calculates the winning tile’s ET aggregate.
- If a player covered the winning tile, their allocation equals `round_bonus * player_stake_on_tile / total_stake_on_winning_tile`. If nobody covered it, bonus ET remains unminted. The losing ET is permanently spent for the current epoch.
- The bonus is an ET-only in-epoch game reward; it is not prize USDC and it does not alter PT.

The exact game bonus is a bounded protocol configuration set through the governance path. It is zero by default in security tests, which demonstrates that no unbounded minting or prize transfer is hidden in game settlement.

## Randomness provider boundary

The callback account must be owned by the configured provider program and linked to `RandomnessRequest.provider_request`. The program validates: domain separation (`hex-round` or `weekly-prize`), subject ID, provider program ID, request ID, fulfillment status, and one-time consumption.

The test provider cannot be selected once `ProtocolConfig.production_mode` is true. Public Pyth Entropy documentation currently describes Ethereum contracts and does not list Solana. Pyth must not be asserted as the live provider until it offers an authenticated SVM callback. The design prevents this vendor fact from weakening the custody or accounting invariants.

## Governance and emergency controls

- A config authority may stage a parameter update; it becomes active only after the configured timelock.
- A guardian may pause deposits, positions, and external-adapter actions, but cannot transfer principal, mint PT/ET, choose winners, or claim prizes.
- Withdrawals remain live while paused except where an explicitly documented external-adapter unwind is required. A pause must not create an arbitrary custody lock.
- Mainnet requires a named 2-of-3 Squads multisig to hold authority and guardian roles, a timelock, a verified build, and a completed independent audit.

## Yield adapter boundary

The `YieldAdapter` may move only a configured, capped surplus out of a strategy allocation and into `PrizeVault`; it may never pay a prize from `PrincipalVault`. Before activating any adapter, the program must verify its program ID, USDC mint, share mint, slippage bound, per-epoch cap, cooldown, and emergency unwind semantics.

For orientation only, an annualized 4–6% variable USDC lending rate would produce roughly `$400–$600/year` (`$7.69–$11.54/week`) per `$10,000` of deployed capital before strategy fees, failed-utilization periods, and losses. It is neither a prediction nor a promised prize budget.
