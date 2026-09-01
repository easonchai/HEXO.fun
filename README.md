# HexVault

A Solana devnet prototype for an active, no-loss-principal savings lottery.

> **Prototype only. Do not deposit real assets.** This repository is not an audit, a financial product, or a promise of yield. Mainnet deployment requires an independent audit, multisig/timelock governance, legal review, operational runbooks, and a production randomness provider.

## Product model

Users deposit devnet USDC. The program records two non-transferable, 1:1 accounting balances:

- **Principal Token (PT):** the user’s claim on deposited USDC.
- **Entry Token (ET):** an epoch-scoped game balance. One dollar of deposit creates one PT and one ET (both use USDC’s six decimals).

Within a weekly epoch, ET may be spent on one 36-tile Hex board position per round. Losing entries are gone, so the matching principal cannot be withdrawn until the next weekly ET refresh. At the epoch boundary, ET is restored to the current PT balance after the prize eligibility snapshot. A game winner can receive additional ET, increasing their odds in the epoch’s USDC prize draw; ET is neither transferable nor redeemable for USDC.

The USDC principal vault, prize escrow, and yield adapter are separate. A lottery prize can only be paid from the prize escrow; it cannot draw down accounted principal.

See [`docs/protocol.md`](docs/protocol.md) for the state machine and invariants, [`docs/security.md`](docs/security.md) for the threat model, and [`docs/research.md`](docs/research.md) for source research and integration status.

## Intended stack

- **On-chain:** Rust with Anchor, Solana/Agave, Token-2022 non-transferable receipt/accounting tokens.
- **Clients/services:** TypeScript with `@solana/kit`/Anchor client APIs.
- **Wallets:** Privy Solana embedded/external wallet adapter when `VITE_PRIVY_APP_ID` is supplied, plus standard Solana-wallet-adapter connections.
- **Randomness:** provider interface. Pyth Entropy’s current public docs are EVM-only, so the production SVM provider must be selected before mainnet (ORAO/Switchboard are candidates); test-only mock randomness is rejected by production configuration.
- **Indexer:** an idempotent event consumer, checkpointed by slot/signature, designed for a managed RPC/webhook source and PostgreSQL in production.
- **Yield:** an adapter boundary designed for a Kamino USDC lending-vault integration. It is deliberately disabled in the initial devnet contract; prizes are sponsor-funded until adapter risk controls are implemented and audited.

## Repository layout

```text
programs/hex_vault/     Anchor program
packages/indexer/       event normalization and durable-indexer boundary
apps/web/               wallet and transaction-building boundary
tests/                  program and service tests
docs/                   product, risk, and operational specifications
```

## Development status

The project is being bootstrapped with the current local Solana and Anchor toolchain. Use only the repository-native commands documented once the lockfiles and generated IDL land; no deployment key, RPC key, Privy App ID, or mainnet configuration is committed.
