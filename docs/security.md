# Security gates and threat model

## Invariants to test

1. **Principal conservation:** per pool, aggregate PT never exceeds the accepted asset in that pool's principal vault; a prize or jackpot transfer cannot debit it.
2. **Matched exit:** a user withdrawal atomically burns equal PT and ET and transfers exact asset; insufficient ET rejects it. Withdrawal and entry refresh stay live through pauses and epoch transitions.
3. **No transfer bypass:** PT/ET cannot be user-transferred, delegated, frozen by an attacker, or minted/burned except by the pool PDA authority.
4. **Epoch correctness:** schedules are immutable once created with enforced ordering and duration bounds; entry refresh has one defined state transition and cannot alter PT.
5. **One position:** a player has at most one immutable position per round; tile counts, bitmaps, and amount multiplication cannot overflow; round bonuses are capped per pool and conserve across multi-player settlement.
6. **Randomness authenticity:** only the configured authority can fulfill a request; requests are domain-bound per kind (round/prize/jackpot), subject-bound, and consumed once; mapping is rejection-sampled. A stuck request cannot strand an epoch (expiry cancels it).
7. **Settlement correctness:** a round is final only after its close; bonus allocation cannot exceed the pool cap or be settled twice.
8. **Prize/jackpot safety:** a prize/jackpot is capped by its committed value and its own escrow balance, has one winner/claim, is deadline-enforced, and cannot be changed after randomness. Jackpot rollover moves no funds; a committed draw must resolve before the next epoch opens.
9. **Authority minimization:** guardian pause is per pool, cannot move funds, and never blocks withdrawals or refresh; test randomness is forbidden in production mode. Timelocked governance changes are a required mainnet gate, not a current program feature.
10. **Account validation:** all token accounts, mints, PDAs, programs, and sysvars are constrained to known identities, and every subordinate PDA derives from the owning pool. The accepted mint must be owned by the pool's declared token program (PRD §8.13); no caller-provided program/account is trusted merely because it deserializes.

## Solana-specific controls

- Anchor account constraints plus explicit owner, mint, authority, PDA-seed, and token-program verification.
- Checked `u64` arithmetic only; no unchecked casts from external callback data.
- Reentrancy-style state transitions closed before CPIs; all external CPIs use allowlisted program IDs.
- Token-2022 instructions use fixed mint and program accounts; account substitutions are rejected.
- Callback result mapping avoids modulo bias for ranges that do not divide the provider value domain.
- Events include versioned identifiers, epoch/round, player, amounts, and request IDs so indexers can reconcile rather than infer state.

## Operations before mainnet

- Build with pinned toolchain and reproduce a verifiable program build.
- Test local validator, devnet integration, randomized/property-style accounting sequences, and malicious account substitution cases.
- Independent smart-contract audit, dependency review, and public bug bounty.
- 2-of-3 Squads multisig, timelock, external alerting, key ceremony, incident runbook, and emergency-withdraw analysis.
- Production RPC/WebSocket plus a durable, replayable indexer; monitor finalized slots and reorg/fork behavior.
- Document real yield strategy risk and obtain legal review before calling the system a lottery/savings product or accepting mainnet funds.
