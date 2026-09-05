# 12 Deploy: devnet program, Contabo compose, Vercel

Status: ready-for-human
Type: task
Blocked by: 07, 08, 09, 11

## Goal

The demo is live at a public URL.

## Steps

1. **Program to devnet** (human, needs the deploy key and ~5 SOL of devnet airdrop): `anchor build && anchor deploy --provider.cluster devnet`. Confirm `declare_id!` matches. Commit the IDL.
2. **VPS** (human): clone repo, create `.env` from spec §3.1 with the Helius devnet URL and the authority key (`solana-keygen new`, airdrop 5 SOL). `docker compose up -d postgres`, then `docker compose run backend pnpm bootstrap` and paste its output into `.env`, then `docker compose up -d backend`. Traefik labels in `docker-compose.yml` route `Host(api.<domain>)` to port 8080 on the existing Traefik network; TLS is Traefik's job.
3. **Vercel** (human): import repo, root `apps/web`, build `pnpm --filter web build`, env `VITE_RPC_URL` (second Helius key with the Vercel domain allowlisted), `VITE_API_URL=https://api.<domain>`, `VITE_PROGRAM_ID`, `VITE_POOL_ID=1`, `VITE_PRIVY_APP_ID`. Set `CORS_ORIGIN` on the VPS to the Vercel URL and restart backend.
4. **Agent-prepared parts**: `docker-compose.yml` rewritten for postgres + backend with Traefik labels and an `.env.example` listing every variable with a comment; a `docs/plan/rebuild/runbook.md` with the exact commands above and the "how to reset the demo" recipe (bump `POOL_ID`, re-run bootstrap).

## Acceptance

- `https://api.<domain>/status` is green.
- The Vercel URL completes PRD §9 with a fresh Privy wallet.
- `docker compose logs backend` shows rounds opening and settling every ~65 s.
