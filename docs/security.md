# Security gates and threat model

## Invariants to test

1. **Principal conservation:** aggregate PT never exceeds USDC in `PrincipalVault`; a prize transfer cannot debit that vault.
2. **Matched exit:** a user withdrawal atomically burns equal PT and ET and transfers exact USDC; insufficient ET rejects it.
3. **No transfer bypass:** PT/ET cannot be user-transferred, delegated, frozen by an attacker, or minted/burned except by the program authority.
4. **Epoch correctness:** ET refresh has one defined state transition, cannot happen early or twice, and cannot alter PT.
5. **One position:** a player has at most one immutable position per round; tile counts, bitmaps, and amount multiplication cannot overflow.
6. **Randomness authenticity:** only the configured provider can fulfill a request; a request is domain-bound, subject-bound, and consumed once.
7. **Settlement correctness:** a round is final only after its close; bonus allocation cannot exceed configuration or be settled twice.
8. **Prize safety:** a prize is capped by the committed prize value and escrow balance, has one winner/claim, and cannot be changed after randomness.
9. **Authority minimization:** guardian pause cannot move funds; test randomness is forbidden in production mode. Timelocked governance changes are a required mainnet gate, not a current program feature.
10. **Account validation:** all token accounts, mints, PDAs, programs, and sysvars are constrained to known identities. No caller-provided program/account is trusted merely because it deserializes.

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
