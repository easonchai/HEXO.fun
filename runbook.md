 # terminal 1 — postgres + backend
  docker compose -f docker-compose.yml -f docker-compose.local.yml up -d

  # terminal 2 — frontend
  pnpm --filter @hexvault/web dev

  Then http://localhost:5173, Phantom set to devnet. Faucet gives you 1000 hexUSDC.

  Check it came up: curl localhost:8080/status should show rpcOk: true and a lastAction a few seconds old. Watch it work with docker
  compose -f docker-compose.yml -f docker-compose.local.yml logs -f backend — a round every ~65s.

  Shut down with down in place of up -d.

  When you change something

  ┌────────────┬──────────────────────────────────────────────────────────────────────────────────────────────────────────────────────┐
  │  Changed   │                                                          Do                                                          │
  ├────────────┼──────────────────────────────────────────────────────────────────────────────────────────────────────────────────────┤
  │ Backend    │ up -d --build backend                                                                                                │
  │ code       │                                                                                                                      │
  ├────────────┼──────────────────────────────────────────────────────────────────────────────────────────────────────────────────────┤
  │ .env       │ up -d --force-recreate backend (restart won't re-read it)                                                            │
  ├────────────┼──────────────────────────────────────────────────────────────────────────────────────────────────────────────────────┤
  │ Frontend   │ nothing, Vite hot-reloads                                                                                            │
  ├────────────┼──────────────────────────────────────────────────────────────────────────────────────────────────────────────────────┤
  │ Program    │ anchor build, both sync-idls, solana program deploy --program-id target/deploy/hex_vault-keypair.json                │
  │            │ target/deploy/hex_vault.so --url devnet, then up -d --build backend                                                  │
  └────────────┴──────────────────────────────────────────────────────────────────────────────────────────────────────────────────────┘

  Two gotchas worth remembering. Never build with --features test-vrf before a devnet deploy — that stubs the ORAO CPI and the operator
  picks the wrong randomness PDA off the IDL. And if solana program deploy says ExtendProgram requires a minimum of 10240 additional
  bytes, run solana program extend LFk9ba6QXuM9oYRRNGGPxMGzfo13X3DAr8ghSPz72C6 10240 --url devnet first.

  Nothing needs re-bootstrapping. Only bump POOL_ID and re-run bootstrap if you want a clean pool, and then paste the new HEXUSDC_MINT
  into .env.

  close_buffer: the draw window

  close_buffer is the number of seconds before a Round's ends_at that Positions close and request_round_randomness starts accepting
  requests. The operator's first tick step requests randomness the moment that window opens, so ORAO's round trip runs inside the
  countdown instead of after it.

  Measured on devnet over 16 Rounds: request to settle takes 2s minimum, 4s median, 18s maximum. close_buffer is set to 8s. That covers
  the median draw with room for tick lag; the timer holding at 00:00 covers the rare 18s tail instead of the buffer trying to.

  Tune it with set-params if ORAO's latency changes, no redeploy needed. The program still enforces 0 <= close_buffer < round_seconds.
