# Deploy runbook

Devnet program, backend on the Contabo VPS behind the running Traefik, frontend
on Vercel. Steps 1 to 3 are human work and need the deploy key, the VPS and the
Vercel account.

## Not runnable yet

These must land first: 06 (Indexer), 07 (Operator), 08 (API and faucet), 09
(bootstrap) and 11 (frontend screens). 07 and 08 both depend on 06.
Without 09 there is no `HEXUSDC_MINT` and no pool, so step 2 stops at the
bootstrap line.

## 1. Program to devnet

Needs the deploy key and about 5 SOL of devnet airdrop.

```
anchor build && anchor deploy --provider.cluster devnet
```

Confirm the deployed id matches `declare_id!` and `Anchor.toml`. Commit the IDL.

## 2. VPS

Clone the repo, then create `.env`:

```
cp .env.example .env
```

Fill in `DOMAIN`, `TRAEFIK_NETWORK`, `CERT_RESOLVER`, `POSTGRES_PASSWORD`,
`RPC_URL` (Helius devnet), `PROGRAM_ID` from step 1, and `AUTHORITY_KEYPAIR`.

The authority key. `AUTHORITY_KEYPAIR` is the base58 form of the 64-byte secret
key, not the JSON array `solana-keygen` writes. Run this from the repo root on a
machine that has run `pnpm install` (the machine that did step 1):

```
solana-keygen new -o authority.json
solana airdrop 5 $(solana-keygen pubkey authority.json) --url devnet
node -e "const b=require('./apps/backend/node_modules/bs58');console.log((b.default??b).encode(Uint8Array.from(require('./authority.json'))))"
```

Paste that base58 string into the VPS `.env`. Keep `authority.json` out of git.

Bring the stack up:

```
docker compose up -d postgres
docker compose run backend pnpm bootstrap
docker compose up -d backend
```

Paste the `KEY=value` lines bootstrap prints into `.env` (`HEXUSDC_MINT` and the
pool addresses) before the last command.

The runtime image has corepack but no `pnpm` on `PATH`, so the middle command
fails as written until the Dockerfile enables it. The equivalent today:

```
docker compose run --rm backend node_modules/.bin/tsx src/bootstrap.ts
```

## 3. Vercel

Import the repo. Root directory `apps/web`, build command `pnpm --filter web build`.

Environment variables:

```
VITE_RPC_URL        second Helius key, with the Vercel domain allowlisted
VITE_API_URL        https://api.<domain>
VITE_PROGRAM_ID     the id from step 1
VITE_POOL_ID        1
VITE_PRIVY_APP_ID   from the Privy dashboard
```

Then on the VPS set `CORS_ORIGIN` to the Vercel URL and restart the backend:

```
docker compose up -d --force-recreate backend
```

`docker compose restart` does not re-read `.env`. Use `up -d --force-recreate`.

## Reset the demo

Bump `POOL_ID` in `.env`, then:

```
docker compose run --rm backend node_modules/.bin/tsx src/bootstrap.ts
docker compose up -d --force-recreate backend
```

Paste the new `HEXUSDC_MINT` into `.env` before the restart. Set the matching
`VITE_POOL_ID` on Vercel and redeploy, or the frontend reads the old pool.

## Admin commands

`apps/backend/src/admin/index.ts` (ticket 13) is a one-off CLI over the live
pool: `set-params`, `pause`, `unpause`, `fund-jackpot`. It signs with the same
`AUTHORITY_KEYPAIR` the backend runs on, so it needs the same `.env`.

From a machine with `pnpm install` already run:

```
pnpm --filter @hexvault/backend admin pause
pnpm --filter @hexvault/backend admin unpause
pnpm --filter @hexvault/backend admin set-params --epoch-seconds 3600 --round-seconds 20
pnpm --filter @hexvault/backend admin fund-jackpot --amount 50000000
```

On the VPS, same caveat as `bootstrap` above: the runtime image has no `pnpm`
on `PATH`, so run it through the container's own tsx instead:

```
docker compose run --rm backend node_modules/.bin/tsx src/admin/index.ts pause
```

`fund-jackpot --amount` is raw atomic hexUSDC (6 decimals): `50000000` is 50
hexUSDC. `set-params` takes any combination of `--epoch-seconds`,
`--round-seconds`, `--close-buffer`, `--vrf-timeout`, `--min-deposit`; only the
flags you pass change, and each takes effect on the next epoch or round, not
the open one (that's on the Pool account itself, not just this CLI: see
`epoch_seconds`/`round_seconds` in `programs/hex_vault/src/state.rs`).

## Changing epoch length for a live demo

To make the epoch draw happen inside a demo instead of waiting a day:

```
pnpm --filter @hexvault/backend admin set-params --epoch-seconds 900
```

This applies to the next epoch; a currently open one still runs its full
length. There is no admin command to roll the open epoch over early. Either
wait for it to end, or reset the demo (bump `POOL_ID`, above) and re-bootstrap
with `--epoch-seconds 900` from the start. Rounds shorten independently with
`--round-seconds`.

## Topping up the authority with SOL and hexUSDC

SOL, for transaction fees:

```
solana airdrop 5 <authority-pubkey> --url devnet
```

The devnet airdrop is rate-limited per IP; if it 429s, use
https://faucet.solana.com in a browser instead.

hexUSDC: bootstrap made the authority the mint's authority, so mint straight
into its own token account. `spl-token mint` wants that account's address,
not the wallet address; bootstrap already printed it as `AUTHORITY_ATA` in the
`KEY=value` block from step 2, so reuse that:

```
spl-token mint <HEXUSDC_MINT> 1000 <AUTHORITY_ATA> --owner authority.json --url devnet
```

If you only have `.env`'s base58 `AUTHORITY_KEYPAIR` and not the JSON file
`authority.json` (typical once you're back on the VPS), rebuild it, the exact
reverse of the encode step above:

```
export $(grep AUTHORITY_KEYPAIR .env)
node -e "const b=require('./apps/backend/node_modules/bs58');console.log(JSON.stringify(Array.from((b.default??b).decode(process.env.AUTHORITY_KEYPAIR))))" > authority.json
spl-token mint <HEXUSDC_MINT> 1000 <AUTHORITY_ATA> --owner authority.json --url devnet
rm authority.json
```

That balance sits in the authority's wallet, not the jackpot. Move some of it
on-chain into the jackpot vault with the admin command:

```
pnpm --filter @hexvault/backend admin fund-jackpot --amount 50000000
```

## Troubleshooting an amber status pill

The pill reads the backend's `/status` endpoint (`operator.lastTickAt`,
`operator.lastAction`, `operator.lastError`, `rpcOk`) and `docker compose logs
backend`. Four causes cover most of what turns it amber.

**RPC key exhausted.** `/status` shows `rpcOk: false`, or the logs repeat
`getSlot failed`. Check the Helius dashboard for the request count on that
key. Fix: swap `RPC_URL` in `.env` for a fresh key (a second Helius key, or a
backup provider), then `docker compose up -d --force-recreate backend`.

**ORAO stalled, rounds voiding.** The logs show `sent void_round` for several
rounds in a row instead of `sent settle_round`. Each round's pot rolls into
the next round's pot (product-requirements.md §3.5); nobody wins those
rounds, but nothing is lost. This clears itself once ORAO answers again, the
operator's own tick handles it, there's nothing to run. If it doesn't clear
after several minutes, check that `vrf_treasury` on the pool still matches
ORAO's current treasury account: a wrong treasury looks identical to a
stalled oracle since the request still lands on chain, it just never gets
fulfilled.

**Authority out of SOL.** The logs show a `tick failed` line with an
insufficient-funds error, and every operator action fails the same way.
Check with `solana balance <authority-pubkey> --url devnet`, then top up
(above).

**Postgres disk.** `docker compose logs postgres` shows "No space left on
device", or the backend can't write indexed rows. Check with
`docker compose exec postgres df -h /var/lib/postgresql/data`. Free space
(`docker system prune`, or trim old rows out of the `Event` table) or grow the
VPS volume; the data lives in a named volume (`docker volume ls`).

## Acceptance

- `https://api.<domain>/status` is green.
- The Vercel URL completes product-requirements §9 with a fresh Privy wallet.
- `docker compose logs backend` shows rounds opening and settling every ~65 s.
