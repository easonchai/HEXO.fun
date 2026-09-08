# HexVault (HEXO.fun)

Save your money. Play your luck.

HexVault is a no-loss lottery on Solana with a game bolted on. Deposit USDC and your
principal never leaves the pool except back to you. Your time-weighted Entries are your
odds in the draw for the pool's prize. Between draws, put Entries on a 36-tile hex board
every 30 seconds and take the round pot from the other players when your tile is drawn.
Win rounds and you carry more weight into the draw. Lose and you still withdraw every
cent you deposited.

> Devnet prototype built for a hackathon. The prize is funded by the operator and labeled
> as simulated. No audit, no legal review. Do not deposit real assets.

- Landing page: https://hexo-landing.vercel.app/
- App: https://hexofun-beta.vercel.app/
- Program on devnet: `LFk9ba6QXuM9oYRRNGGPxMGzfo13X3DAr8ghSPz72C6`

## Screenshots

| Home                                 | Play                                 |
| ------------------------------------ | ------------------------------------ |
| ![Home](docs/screenshots/home.png)   | ![Play](docs/screenshots/play.png)   |

| Earn                                       | Deposit                                    |
| ------------------------------------------ | ------------------------------------------ |
| ![Earn](docs/screenshots/earn.png)         | ![Deposit](docs/screenshots/deposit.png)   |

| Daily draw                                 | Round reveal                               |
| ------------------------------------------ | ------------------------------------------ |
| ![Draw](docs/screenshots/draw.png)         | ![Reveal](docs/screenshots/reveal.png)     |

## How it works

1. Connect a wallet. Privy embedded wallet by default, with gas sponsored, so anyone can
   play in under a minute. Phantom and other adapters also work.
2. Get test USDC from the faucet in the wallet menu.
3. Deposit. You receive equal Principal and Entries (shown on screen as Tickets).
4. Play rounds. Stake Entries on tiles, watch the draw, collect round rewards as Entries.
   Losers' Entries go to the winners on the drawn tile, never to the house. A tile nobody
   covered forfeits the pot to the House, which competes in the draw like any player.
5. The epoch ends. The operator registers every player's weight, draws one winner with
   ORAO VRF, and pushes the prize straight to their wallet. No claim step.
6. New epoch. Entries reset to Principal. Play again, or withdraw.

Withdrawable balance is always `min(Principal, Entries)`, and the program enforces the
same rule the UI shows before every position.

### Demo cadence

| Setting        | Value                                    |
| -------------- | ---------------------------------------- |
| Epoch          | 1 hour (labeled DAILY DRAW on screen)    |
| Round          | 30 seconds, positions close 12 s early   |
| Prize          | Jackpot vault topped up to 42069 hexUSDC |
| Randomness     | ORAO VRF for rounds and the draw         |

Production intent is a seven day epoch with the prize funded by real yield. The cadence is
tunable on chain without a redeploy; see `runbook.md`.

## Architecture

```
programs/hex_vault/   Anchor program: custody, rounds, epochs, draw, ORAO VRF
apps/backend/         NestJS + Prisma + Postgres: indexer, operator, read API, faucet
apps/web/             Vite + React app (Vercel): hex arena, deposit, dashboard, draw
apps/landing/         Static marketing site with a Neon signup route
tests/                Anchor localnet suite (test-vrf feature stubs ORAO)
docs/                 Product requirements, ADRs, build tickets, progress
```

**Program.** Principal and Entries are plain numbers in a Player account, not tokens
(ADR 0001). Weight is Entries integrated over time and registered on chain at epoch end
(ADR 0002). Rounds are zero-sum between players (ADR 0003). Payout is pushed, never
claimed (ADR 0004).

**Operator.** One backend service holds the authority keypair and advances the protocol
on a one second tick: opens rounds and epochs, requests randomness as soon as the close
window opens, settles rounds, cranks registration, funds the prize, and pays the winner.
It never holds user funds.

**Indexer and API.** The same backend mirrors program accounts and events into Postgres
and serves the leaderboard, activity feed, and status endpoints. The frontend reads the
Pool, Player and open Round straight from chain and treats the API as a cache.

## Run it locally

Requirements: Node 22, pnpm 11, Docker, Solana 3.1 and Anchor 1.1 for program work.

```sh
pnpm install
cp .env.example .env                       # fill in RPC_URL and AUTHORITY_KEYPAIR
docker network create traefik              # once
docker compose -f docker-compose.yml -f docker-compose.local.yml up -d   # postgres + backend
pnpm --filter @hexvault/web dev            # http://localhost:5173
```

Set the wallet to devnet. The faucet gives 1000 hexUSDC per hour. Check the backend with
`curl localhost:8080/status`; `rpcOk: true` and a recent `lastAction` mean the operator is
ticking.

Bootstrap a fresh pool with `pnpm --filter @hexvault/backend bootstrap`, then paste the
printed `HEXUSDC_MINT` into `.env`. Change pool timing with the admin CLI:

```sh
set -a; . ./.env; set +a
pnpm --filter @hexvault/backend admin set-params --epoch-seconds 3600 --round-seconds 30 --close-buffer 12
```

### Tests

```sh
pnpm check                 # tsc across the workspace
pnpm test:unit             # vitest: web, backend
anchor test                # program suite on an isolated local validator
cargo test --lib -p hex_vault
```

## Deploy

The backend runs on a VPS behind Traefik with `docker compose up -d --build`; every value
comes from `.env`. The web app deploys to Vercel with the `VITE_*` variables from
`apps/web/.env.example`. Redeploying the program is `anchor build`, `sync-idl` in both
apps, `solana program deploy`, then rebuild the backend. `runbook.md` has the full
procedure and the gotchas, including why you must never deploy a `test-vrf` build.

## Read next

- [`CONTEXT.md`](CONTEXT.md): the vocabulary. Use these words and no others.
- [`docs/product-requirements.md`](docs/product-requirements.md): what the product does.
- [`docs/PRD-V2.md`](docs/PRD-V2.md): the HEXO.fun direction and token layer.
- [`docs/adr/`](docs/adr/): why the surprising choices were made.
- [`docs/plan/rebuild/`](docs/plan/rebuild/): spec, ordered tickets, and progress.
- [`runbook.md`](runbook.md): operating the devnet deployment.
- [`AGENTS.md`](AGENTS.md): conventions for agents working in this repo.
