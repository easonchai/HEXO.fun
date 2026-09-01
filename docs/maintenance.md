# HexVault maintenance guide

This is a **devnet prototype**. The repository is useful for protocol development and local-validator testing; it is not authorized for real assets or mainnet deployment.

## What is implemented and tested

| Area              | Current implementation                                                                  | Automated evidence                                                                             |
| ----------------- | --------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| Principal custody | Distinct PDA-owned `PrincipalVault` and `PrizeVault`; the config PDA is token authority | Local validator: deposit, prize funding, matched withdrawal                                    |
| Receipts          | Non-transferable Token-2022 PT and ET; program-only mint/burn paths                     | Local-validator deposit/withdraw plus Rust unit tests                                          |
| Entry/game core   | 36-tile, one-position-per-wallet round mechanics with ET burns/rewards                  | Rust unit tests cover tile mapping; transaction integration remains incomplete                 |
| Prize core        | Authority-committed Merkle-sum snapshot and one-time claim state                        | Rust unit tests cover Merkle interval verification; transaction integration remains incomplete |
| Randomness        | Explicit mock asynchronous devnet boundary                                              | Unit-tested range mapping only; no production provider                                         |
| Indexer           | In-memory finalized-event projection                                                    | Six TypeScript unit tests; no database or RPC consumer                                         |
| Wallet boundary   | Standard Solana-wallet default; optional Privy configuration policy                     | Three TypeScript unit tests; no rendered wallet UI                                             |

A passing test suite proves only the rows and cases above. It does **not** prove economic safety under all sequences, provider security, regulatory compliance, or mainnet readiness.

## Prerequisites

Use the versions pinned in `Anchor.toml` and `package.json`:

- Node.js `>=22.18.0` and pnpm `11.7.0`
- Anchor CLI `1.1.2`
- Solana CLI/test validator `3.1.10`
- Rust toolchain selected by Anchor

Install JavaScript dependencies without enabling unreviewed native builds:

```sh
pnpm install --frozen-lockfile
```

`pnpm-workspace.yaml` explicitly disables the optional `bigint-buffer`, `bufferutil`, and `utf-8-validate` native builds. `bigint-buffer` uses its pure-JavaScript fallback during local tests. Do not change an `allowBuilds` value to `true` without reviewing the package, its install script, and the reason it is required.

## Daily verification

Run these commands from the repository root. They are the required checks before merging a protocol change:

```sh
pnpm run check
pnpm run test:unit
pnpm run test:program
pnpm run format:check
cargo fmt --all -- --check
cargo test -p hex_vault --lib
git diff --check
```

`pnpm run test:program` starts a fresh, temporary `solana-test-validator`, builds and deploys the program, runs package tests, and runs `tests/custody.integration.test.ts`. The runner cleans up its temporary ledger and validator process. It needs the configured local test wallet at `~/.config/solana/id.json`; create a new local-only keypair if it does not exist:

```sh
solana-keygen new --no-bip39-passphrase --outfile ~/.config/solana/id.json
```

Never substitute a funded mainnet wallet for this keypair. No test command should target devnet or mainnet.

## Safe change process

### On-chain changes

1. Read `docs/protocol.md` and `docs/security.md`; name the invariant the change preserves.
2. Change the smallest relevant instruction, account constraint, state type, or helper. Keep explicit mint, token-program, authority, and PDA checks.
3. Regenerate the IDL with `anchor build`. Treat the changed `target/` artifact as a build output, not source to hand-edit.
4. Add a transaction-level test for every fund-moving or authority-sensitive behavior. A unit test alone is insufficient for account writability, CPI signer seeds, token-program selection, or PDA constraints.
5. Run the full verification matrix above. Inspect error logs rather than weakening account constraints to make a test pass.
6. Update the protocol specification and this status table if behavior or test coverage changes.

### Indexer and web changes

- Process only finalized events. Preserve cursor idempotency and reject out-of-order finalized input.
- Never put private keys, RPC secrets, Privy credentials, or signing logic in browser source or committed environment files.
- A missing `VITE_PRIVY_APP_ID` must continue to select the standard-wallet path; do not silently add a custodial fallback.
- Keep amounts as `bigint`/atomic `u64` values. Do not use JavaScript `number` for USDC, PT, ET, weights, or prize amounts.

### Dependency and tooling updates

- Update one toolchain family at a time: Anchor/Solana/Rust or JavaScript dependencies.
- Re-run `anchor build`, the full validator suite, and lockfile formatting after every update.
- Review lockfile changes and new install scripts. A green TypeScript test run does not validate the on-chain artifact.
- Do not upgrade to a new Solana program ID casually. A program-ID change invalidates all PDA addresses and must be treated as a migration.

## Deployment and key handling

- The checked-in program ID is development-only. The deploy keypair under `target/deploy/` is ignored and must never be committed.
- Authority, guardian, snapshot-authority, and mock-randomness roles are separate inputs to `initialize`. On devnet they may be dedicated test keys; they must not share a personal wallet key.
- `mock_randomness_authority` is test/devnet-only. Do not set `production_mode` true until a real authenticated SVM callback, provider monitoring, and callback tests exist.
- Devnet deployments should use a dedicated deployer key, test USDC, an isolated RPC endpoint, and an explicit post-deploy smoke test. Do not deploy to mainnet from this repository state.

## Required mainnet gates

All of the following must land and receive independent review before accepting real deposits:

1. Audited authenticated SVM randomness provider and callback integration.
2. 2-of-3 multisig, timelock, parameter-update controls, key ceremony, and incident runbook.
3. Durable PostgreSQL-backed finalized-event indexer with replay, monitoring, and alerting.
4. Audited yield adapter with limits, oracle/slippage controls, emergency unwind, and explicit loss disclosure—or no adapter at all.
5. Full transaction/property/fuzz coverage of epochs, ET spend/refresh, positions, settlement, malicious account substitution, prize claims, pause semantics, and authority failures.
6. Independent smart-contract audit, dependency review, legal/compliance review, and a public security disclosure process.
7. A user-facing web application with non-custodial wallet connection, transaction simulation/error handling, current risk disclosures, and accessibility review.

## Incident response for devnet

1. Set pause with the configured guardian if deposits or positions are unsafe. Withdrawals are intentionally not paused.
2. Preserve transaction signatures, slots, account addresses, program logs, tool versions, and the deployed artifact hash.
3. Do not rotate roles or redeploy over the evidence. Reproduce against an isolated validator first.
4. Open a security issue privately, write a regression test, document the root cause, and only then publish a patch and deployment plan.

## Documentation map

- `README.md`: product summary and entry point.
- `docs/protocol.md`: executable behavior and protocol state transitions.
- `docs/security.md`: invariants, controls, and mainnet gates.
- `docs/research.md`: source research and vendor status.
- `docs/maintenance.md`: this operational and contributor guide.
