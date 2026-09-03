# Preliminary internal security review

**Status: not an audit.** This is a repository-author static review and local-validator regression pass. It does not provide an independent assurance opinion, economic-model review, production-randomness assessment, or a bug bounty substitute. No real assets may be deposited.

## Scope reviewed

- Anchor instruction handlers, account constraints, PDA derivation, and token CPIs in `programs/hex_vault/src/`.
- The local-validator custody test in `tests/custody.integration.test.ts`.
- Protocol and security documentation.

The review did not include a deployed devnet program, an external RPC/indexer, a production VRF, a yield adapter, a browser UI, fuzzing, formal verification, or third-party dependencies beyond their lockfile versions.

## Fixed finding

### I-01 — first-initializer authority takeover — fixed

**Severity before fix:** critical.

A global config PDA can only be created once. Previously, any signer could call `initialize` first and irreversibly choose every privileged role. `Initialize` now requires the `ProgramData` account for this program and verifies that the initializer is the deployed program’s upgrade authority (`programs/hex_vault/src/lib.rs`). The local-validator fixture first attempts initialization as a funded attacker and asserts `UnauthorizedAuthority`, then completes legitimate initialization (`tests/custody.integration.test.ts`).

**Deployment condition:** this guard intentionally requires an upgradeable-program `ProgramData` account with a non-null upgrade authority. Do not make the program immutable before initialization. For mainnet, transfer that upgrade authority to the approved multisig before first initialization.

## Open findings and mainnet blockers

### I-02 — mock randomness controls game and prize outcomes — critical blocker

`initialize` sets `production_mode` false and no instruction enables it. The configured mock signer selects the accepted sample for both round and prize fulfillment. This is acceptable only for local/devnet testing. A production authenticated SVM randomness callback, key rotation, timeout, retry, monitoring, and end-to-end tests must be implemented and independently reviewed before mainnet.

**Update 2026-09-03:** an authenticated randomness path is implemented — ORAO
VRF v2, pull model (`docs/vrf-randomness.md`): slot-hash-mixed request seeds,
program-bound ORAO request accounts, fulfilled-only settlement, and in-program
rejection-tail re-derivation. Mock fulfillment remains available for localnet
and stays hard-gated by `production_mode`. Residual: the ORAO fulfillment
authority quorum is a multi-party trust assumption, and B6 (independent review
of the integration) remains open before mainnet.

### I-03 — snapshot authority is a custody-grade trusted role — high

The snapshot authority supplies the Merkle-sum root, total entry weight, and committed prize value. The program validates membership against that root but does not derive it from on-chain balances. A malicious or compromised snapshot authority can create a root that favors itself. Mainnet needs a durable/reproducible indexer, multisig/timelock root publication, an observability/challenge process, and explicit user disclosure of this trust boundary.

### I-04 — rejected randomness has no new-request lifecycle — high

The unbiased mapping deliberately rejects tail samples to prevent modulo bias. A production one-shot VRF callback cannot currently obtain a fresh on-chain request ID after such rejection, potentially stranding a round or prize epoch. Add timeout, cancellation, and re-request semantics before integrating a provider.

**Update 2026-09-03:** the VRF settle path closes the stranding case —
`vrf::unbiased_from_randomness` re-derives tail samples in-program
(`sha256(randomness ‖ counter)` chain) instead of reverting, so a fulfilled
ORAO account always settles; each re-derivation step has probability
`range / 2^64`, so the counter practically never advances. The mock path keeps
the revert-and-retry behavior (the operator supplies a fresh sample there).
B6 review must cover this mapping.

### I-05 — round bonus has no configured cap — medium

The authority can supply any `bonus_entries` when creating a round. Although this cannot mint PT or withdraw USDC, it changes game incentives and in-epoch prize weights contrary to the bounded-bonus documentation. Add an immutable/config-governed cap, enforce it, and test aggregate reward conservation.

## Regression coverage now present

The local-validator suite deploys the actual built program and covers:

- unauthorized first initialization rejection and successful legitimate initialization;
- unauthorized guardian pause rejection;
- deposit requires USDC transfer before matched PT/ET minting;
- sponsor prize funding remains outside the principal vault;
- ET is burned when purchasing a position, and unmatched PT cannot be withdrawn;
- matched PT/ET withdrawal returns only backed principal and leaves prize escrow untouched.

Run it with:

```sh
pnpm run test:program
```

## Mandatory test expansion before mainnet

1. Privileged-role rejection for authority, snapshot authority, and randomness authority.
2. Pause matrix: deposits, entry refresh, and positions stop; matched withdrawals stay live.
3. Epoch refresh and rollover: early/double refresh, zero/overflow amounts, and resolved-prior-epoch requirement.
4. Round lifecycle: invalid/duplicate positions, close windows, request/fulfillment replay, winning/losing claims, and multi-player rounding conservation.
5. Prize lifecycle: snapshot time/funding bounds, request/fulfillment replay, invalid and non-winning Merkle proofs, single claim, expiry, and principal-vault non-use.
6. Malicious account substitution: all config, mint, token-program, vault, PDA, recipient, and account-owner constraints.
7. Randomized/property tests over deposits, ET spending/refresh, withdrawal capacity, aggregate PT versus principal custody, and failed-transaction atomicity.
8. Fuzzing of instruction data, account ordering, PDA seeds, arithmetic extremes, Token-2022 extensions, and Merkle proofs.

## External review requirements

Before mainnet, commission an independent Solana/Anchor security audit after the production randomness, snapshot/indexer, governance, and yield designs are complete. Freeze the reviewed commit; provide source, IDL, build reproducibility instructions, threat model, test results, deployed program ID, upgrade-authority plan, and operational runbooks. Remediate every critical/high finding, publish a remediation matrix, and arrange a public responsible-disclosure channel and bug bounty.
