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

  Measured on devnet over 40 Rounds: request to settle takes 4s to 7s on 39 of them and 71s once (ORAO's tail). The request itself
  lands about 2s after the window opens (blockhash fetch, send, confirm). close_buffer is set to 15s: 2s to land the request, 4s to
  7s for the draw, and the rest is margin so the reveal fires at zero instead of after it. The timer holding at 00:00 covers the
  rare 70s tail instead of the buffer trying to; vrf_timeout (120s) bounds it.

  The buffer only works once the program that honours it is deployed. Until 2026-09-06 devnet ran the program from before ff22d53,
  whose request_round_randomness required `now >= ends_at`, so every draw request was rejected with RoundNotEnded until the round
  ended and settled 4s to 7s after zero no matter what close_buffer said. The tell in the operator log is a run of
  `skipped: RoundNotEnded` right before each `sent request_round_randomness`; the tell on chain is the AnchorError line number,
  rounds.rs:162, which the current source does not have. The pool also ran at close_buffer 5 while this note said 8; nobody had run
  set-params.

  Tune it with set-params if ORAO's latency changes, no redeploy needed. The program still enforces 0 <= close_buffer < round_seconds.
  Run it with the root .env exported first: the CLI loads apps/backend/.env, which is the template with an empty mint, and exported
  variables win over the file. (The docker `run --rm backend ... tsx` form in docs/plan does not work: the runtime image has no tsx
  and no decorator config.)

    set -a; . ./.env; set +a; pnpm --filter @hexvault/backend admin set-params --close-buffer 15
