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

## Acceptance

- `https://api.<domain>/status` is green.
- The Vercel URL completes product-requirements §9 with a fresh Privy wallet.
- `docker compose logs backend` shows rounds opening and settling every ~65 s.
