# HexVault

A no-loss lottery on Solana with a game bolted on. Deposit USDC, keep your principal, and
your time-weighted Entries are your odds on the epoch's yield jackpot. Between draws, put
Entries on a 36-tile hex board every 60 seconds and take the round pot from the other
players when your tile is drawn. Principal never moves except back to you.

> Devnet prototype. Yield is simulated and labeled as such. No audit, no legal review, do
> not deposit real assets.

## Read first

- [`CONTEXT.md`](CONTEXT.md): the vocabulary. Use these words and no others.
- [`docs/product-requirements.md`](docs/product-requirements.md): what the product does.
- [`docs/plan/rebuild/spec.md`](docs/plan/rebuild/spec.md): program, backend, frontend, infra.
- [`docs/plan/rebuild/issues/`](docs/plan/rebuild/issues/): the ordered build tickets.
- [`docs/adr/`](docs/adr/): why the surprising choices were made.

## State of the repo

The old design (Token-2022 receipts, Merkle snapshots, two prize draws, a CLI operator) is
gone. The rebuild lands ticket by ticket under `docs/plan/rebuild/`.

## Layout after the rebuild

```
programs/hex_vault/   Anchor program
apps/web/             Vite React frontend (Vercel)
apps/backend/         NestJS + Prisma: indexer, operator, read API (Contabo, docker compose)
tests/                Anchor localnet suite (test-vrf feature)
```

## Agent conventions

See [`AGENTS.md`](AGENTS.md) and `docs/agents/`.
