 # terminal 1 — postgres + backend
  docker compose -f docker-compose.dev.yml up -d

  # terminal 2 — frontend
  pnpm --filter @hexvault/web dev

  Then http://localhost:5173, Phantom set to devnet. Faucet gives you 1000 hexUSDC.

  Check it came up: curl localhost:8080/status should show rpcOk: true and a lastAction a few seconds old. Watch it work with docker
  compose -f docker-compose.dev.yml logs -f backend — a round every ~65s.

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

  After the backend has been down

  Epochs chain: begin_epoch starts the next one at the previous ends_at. Before 2026-09-07 that held no matter how late, so a backend
  that came back after hours replayed the whole gap one epoch at a time (begin_epoch, register, close_registration, draw, payout,
  20s to 40s each), paid the jackpot floor to the registered players once per replayed epoch, and opened no Round until it caught up:
  tick step 7 needs a whole round_seconds to fit before the epoch's ends_at, and a replayed epoch has already ended. The UI said
  "no open round" the entire time. Now begin_epoch starts the next epoch at the latest point of the anchor grid it has reached, so
  one begin_epoch after an outage lands in real time and Rounds resume on the next tick. Ordinary lag still chains from the previous
  ends_at, because the next grid point is not there yet, and either way the draw keeps the same clock time. See "Epoch anchor: when
  the draw lands" below.

  close_buffer: the draw window

  close_buffer is the number of seconds before a Round's ends_at that Positions close and request_round_randomness starts accepting
  requests. The operator's first tick step requests randomness the moment that window opens, so ORAO's round trip runs inside the
  countdown instead of after it.

  Measured on devnet over 40 Rounds: request to settle takes 4s to 7s on 39 of them and 71s once (ORAO's tail). The request itself
  lands about 2s after the window opens (blockhash fetch, send, confirm). close_buffer is set to 12s on 30s rounds: 2s to land
  the request, 4s to 7s for the draw, and the rest is margin. The web countdown ends at the close and the stage reads DRAWING
  until the settle lands, at which point the reveal fires, so a slow draw shows as a longer DRAWING rather than a timer stuck at
  zero. The operator ticks every 1s and opens the next Round 1s after ends_at. vrf_timeout (120s) bounds the ORAO tail.

  Demo cadence (2026-09-10): epoch_seconds 86400, round_seconds 30, close_buffer 12, on the anchored pool bootstrapped with
  --epoch-anchor 2026-09-13T16:00:00Z. One draw a day, landing at 00:00 MYT. Rounds switch on the next Round, epochs on the next
  epoch, and epoch_seconds is now safe to change mid-epoch because touch reads the epoch's stored ends_at instead of adding the
  parameter to the start. Before this the pool ran hourly at epoch_seconds 3600 off an arbitrary boundary. The operator tops the
  jackpot vault up to 42069 hexUSDC (JACKPOT_AMOUNT in operator/tick.ts) once the previous epoch has paid, three tries at most;
  there is no simulated yield any more.

    set -a; . ./.env; set +a; pnpm --filter @hexvault/backend admin set-params --epoch-seconds 86400 --round-seconds 30 --close-buffer 12

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

  Epoch anchor: when the draw lands

  epoch_anchor is a unix timestamp on the Pool, and it is a phase reference rather than a start time. Every epoch boundary is a point
  on the grid anchor + k * epoch_seconds, so the draw ends at the same clock time whatever second the pool was bootstrapped and
  however late the operator cranks it. Only where the anchor sits inside one period matters, and it may sit in the future.

  bootstrap and admin set-params both take --epoch-anchor as an ISO 8601 string, and both default to the next Sunday 16:00 UTC at or
  after now. Bootstrap prints the resolved anchor in UTC, in MYT, and as the first three boundaries it produces, so a typo shows up
  before the pool is live instead of a week later. Pass it explicitly whenever you care which instant you get.

    set -a; . ./.env; set +a; pnpm --filter @hexvault/backend admin set-params --epoch-anchor 2026-09-13T16:00:00Z

  Keep Sunday 16:00 UTC. Malaysia is UTC+8 and observes no daylight saving, so 16:00 UTC is 00:00 MYT permanently, no twice-yearly
  shift to chase. That instant is 57600 seconds into the day and 316800 seconds into the week, both whole multiples of an hour, which
  is why the one value sits on all three cadences at once: hourly it is the top of every hour, daily it is 00:00 MYT every day, weekly
  it is 00:00 MYT every Monday. Choose the anchor once and no cadence change ever has to move it.

  Switching cadence is therefore one set-params and no redeploy:

    set -a; . ./.env; set +a; pnpm --filter @hexvault/backend admin set-params --epoch-seconds 604800

  The running epoch keeps its own stored ends_at, so nothing about it changes. The next begin_epoch starts there, which is off the new
  weekly grid, and ends at the first weekly point after it. You get one short transition epoch, then Mondays. Going back to 3600 or
  86400 works the same way.

  Re-bootstrapping after the Pool layout change

  epoch_anchor, current_epoch_ends_at and previous_epoch_ends_at are new fields on Pool, so the account is a different size. There is
  no in-place upgrade and no migration: every pool created before this effort is abandoned, along with its deposits, Player accounts
  and epoch history. Devnet had one; it is gone. Coming back up on a fresh pool:

    1. Redeploy the program: anchor build, both sync-idls, solana program deploy --program-id target/deploy/hex_vault-keypair.json
       target/deploy/hex_vault.so --url devnet.
    2. Bump POOL_ID in the root .env, then bootstrap the new pool:

       set -a; . ./.env; set +a; pnpm --filter @hexvault/backend bootstrap --epoch-anchor 2026-09-13T16:00:00Z --epoch-seconds 86400

    3. Repoint both apps at it. Paste the printed HEXUSDC_MINT into the root .env next to the bumped POOL_ID, and set VITE_POOL_ID
       (and VITE_PROGRAM_ID, if the program id moved) in apps/web/.env to match. Both derive the pool address from that id, so a
       stale one reads an account that no longer exists.
    4. Restart the indexer so it reloads the env and mirrors the new accounts from scratch: up -d --force-recreate --build backend.
       Check curl localhost:8080/status shows rpcOk: true and a fresh lastAction.

  The Sparring player

  The Sparring player is a backend-owned wallet that buys one Position in every Round, on six to eight random tiles at one Ticket per
  tile, so a lone human is never playing against an empty board. It looks like any other wallet on screen and competes in the daily
  draw like any Player. It is not the House and never touches the House account.

  SPARRING_KEYPAIR is the base58 secret of that wallet, and it is optional. When it is set the backend plays every Round; when it is
  empty the backend boots exactly as before and nobody else is on the board.

  Set one up once per environment with the root .env exported first, the same way admin is run:

    set -a; . ./.env; set +a; pnpm --filter @hexvault/backend sparring-setup

  The script generates a keypair when SPARRING_KEYPAIR is empty and prints the SPARRING_KEYPAIR= line on stdout, so you can append it
  straight to .env. Everything else it prints goes to stderr. It then transfers 0.1 SOL from the authority wallet when the Sparring
  wallet holds under 0.05, mints 1000 hexUSDC to the Sparring wallet with the authority key, and deposits that 1000 as Principal
  signed by the Sparring keypair. The 0.1 SOL covers transaction fees and Position rent for weeks of hourly epochs, and Position rent
  comes back when the operator settles the Position.

  Every step checks the chain before it acts and says what it did or why it skipped, so re-running after a half-finished setup is
  safe. It never deposits a second time: Tickets reset to Principal at every new epoch, so the 1000 keeps funding play forever. Once
  the Principal is in place the script mints nothing either, because the deposit leaves the token account at zero and a balance check
  on its own would mint another 1000 on every run.

  Paste the printed line into .env and restart the backend to pick it up (up -d --force-recreate backend). The wallet is worth
  recording here, since the secret only lives in .env:

    local (pool 1): 8fiH2kWupGjj7MbScxXkbD6aaWpbLkAnvBqt26jc3A8B
    VPS (pools 2 and 3): 2phBznrAD5cHHQ1zq6z3Qf7dmHzrcuYsNtNPL9M8oT4B
