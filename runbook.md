 # terminal 1 — postgres + backend
  docker compose -f docker-compose.dev.yml up -d

  # terminal 2 — frontend
  pnpm --filter @hexvault/web dev

  Then http://localhost:5173, Phantom set to devnet. Faucet gives you 1000 hexUSDC.

  Check it came up: curl localhost:8080/status should show rpcOk: true and a lastAction a few seconds old. Watch it work with docker
  compose -f docker-compose.dev.yml logs -f backend — a round every round_seconds plus a few seconds to settle.

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
  zero. The operator sleeps until its next deadline, so the next Round opens a second after ends_at; a 60s safety tick and the
  randomness subscription are what else wakes it. vrf_timeout (120s) bounds the ORAO tail.

  Demo cadence (2026-09-10): epoch_seconds 86400, round_seconds 30, close_buffer 12, on the anchored pool bootstrapped with
  --epoch-anchor 2026-09-13T16:00:00Z. One draw a day, landing at 00:00 MYT. Rounds switch on the next Round, epochs on the next
  epoch, and epoch_seconds is now safe to change mid-epoch because touch reads the epoch's stored ends_at instead of adding the
  parameter to the start. Before this the pool ran hourly at epoch_seconds 3600 off an arbitrary boundary. The operator tops the
  jackpot vault up to 42069 hexUSDC (JACKPOT_AMOUNT in operator/tick.ts) once the previous epoch has paid, three tries at most;
  there is no simulated yield any more.

    set -a; . ./.env; set +a; pnpm --filter @hexvault/backend admin set-params --epoch-seconds 86400 --round-seconds 30 --close-buffer 12

  Round length: 90s (2026-09-14)

  Every Round costs about five transactions, so round_seconds sets the biggest line on the RPC bill. At 60s the idle backend
  projects to just over a 1M-credit free-tier month, and 30s is worse; at 90s it projects to about 560k. bootstrap now defaults to 90.
  A live Pool keeps its old value until set-params moves it, and the change takes effect on the next Round. 120s roughly halves
  the round-linked cost again if the bill comes in over.

    Pool 7 (dev, .env):     epoch_seconds 86400, round_seconds 30, close_buffer 12. Move to 90: pending.
    Pool 8 (VPS, .env.vps): epoch_seconds 86400, round_seconds 30, close_buffer 12. Move to 90: pending.

    set -a; . ./.env; set +a
    DATABASE_URL=postgresql://x pnpm --filter @hexvault/backend admin set-params --round-seconds 90

  Same again from a fresh shell with .env.vps for Pool 8. Replace "pending" with the signature and slot once each lands.

  The buffer only works once the program that honours it is deployed. Until 2026-09-06 devnet ran the program from before ff22d53,
  whose request_round_randomness required `now >= ends_at`, so every draw request was rejected with RoundNotEnded until the round
  ended and settled 4s to 7s after zero no matter what close_buffer said. The tell in the operator log is a run of
  `skipped: RoundNotEnded` right before each `sent request_round_randomness`; the tell on chain is the AnchorError line number,
  rounds.rs:162, which the current source does not have. The pool also ran at close_buffer 5 while this note said 8; nobody had run
  set-params.

  Tune it with set-params if ORAO's latency changes, no redeploy needed. The program still enforces 0 <= close_buffer < round_seconds.
  Run it with the root .env exported first. The CLI reads process.env directly and loads no file of its own, so nothing reaches it
  except what the shell exports. DATABASE_URL is the catch: admin validates the backend's full env but neither .env nor .env.vps sets
  it (compose builds it from the POSTGRES_* keys), so a dummy value has to come along or the command dies on a missing key it never
  uses. (The docker `run --rm backend ... tsx` form in docs/plan does not work: the runtime image has no tsx and no decorator config.)

    set -a; . ./.env; set +a
    DATABASE_URL=postgresql://x pnpm --filter @hexvault/backend admin set-params --close-buffer 15

  House cut: the set-params flag

  --house-cut-bps sets the pool's House cut rate in basis points, a whole number from 0 to
  10000 inclusive (0% to 100%). The default at pool creation is 600, 6%. A change applies to
  the next round settled, never to one already settled.

    set -a; . ./.env; set +a
    DATABASE_URL=postgresql://x pnpm --filter @hexvault/backend admin set-params --house-cut-bps 600

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

  Standing up a fresh pool after a Pool or Round layout change

  Adding a field to Pool or Round changes the account size, and create_pool allocates exactly
  8 + Pool::INIT_SPACE with no slack. An older pool is short by the new field's width, so Anchor
  fails deserialization with error 3003 before any instruction body runs, withdraw included.
  There is no in-place upgrade and no migration: the old pool's deposits, Player accounts and
  epoch history are gone. Two changes have forced this so far, the epoch anchor fields and the
  House cut.

  Both environments share one devnet program id, so the upgrade breaks dev and the VPS at the
  same instant. Run the whole thing back to back, not over two days.

  Pool ids are global rather than per authority: the PDA seed is the id alone, so a VPS pool and
  a dev pool can never share one. 1 through 6 are spent; the next two are 7 and 8.

  Keep a rollback before touching anything. This is the only way back to the old layout:

    solana program dump LFk9ba6QXuM9oYRRNGGPxMGzfo13X3DAr8ghSPz72C6 /tmp/hex_vault-prev.so --url devnet

    1. Build without the test feature and deploy. tests/run-local.sh leaves a --features test-vrf
       build in target/, which stubs the ORAO CPI, so a plain rebuild has to follow any test run.
       The grep is the check that matters: it prints 0 on a deployable artifact.

         anchor build
         pnpm --filter @hexvault/backend sync-idl
         pnpm --filter @hexvault/web sync-idl
         strings target/deploy/hex_vault.so | grep -c test-vrf
         solana program deploy --program-id target/deploy/hex_vault-keypair.json \
           target/deploy/hex_vault.so --url devnet

       "ExtendProgram requires a minimum of 10240 additional bytes" means run
       solana program extend LFk9ba6QXuM9oYRRNGGPxMGzfo13X3DAr8ghSPz72C6 10240 --url devnet first.

    2. Bootstrap the dev pool. Bump POOL_ID but leave HEXUSDC_MINT alone: bootstrap reuses a mint
       that already exists with 6 decimals and the authority as mint authority, so every wallet
       keeps its faucet balance. Principal does not carry over, because Player is a PDA of the
       pool and every depositor starts at zero.

         sed -i '' 's/^POOL_ID=.*/POOL_ID=7/' .env
         set -a; . ./.env; set +a
         pnpm --filter @hexvault/backend bootstrap \
           --epoch-anchor 2026-09-13T16:00:00Z --epoch-seconds 86400 \
           --round-seconds 30
         DATABASE_URL=postgresql://x pnpm --filter @hexvault/backend admin set-params --close-buffer 12

       bootstrap takes no --close-buffer and no --vrf-timeout: create_pool always gets the
       defaults from src/bootstrap/params.ts (close_buffer 5, vrf_timeout 120, min_deposit 1
       hexUSDC). Only set-params changes them, which is why 12 is a second command. --house-cut-bps 600

       600 bps is the default, so pass the flag only for a different rate. stdout is a pasteable
       KEY=value block and progress goes to stderr, so `bootstrap > pool.env` gives a clean file.
       Paste HEXUSDC_MINT back into .env if the block names a mint you did not already have.

    3. Wipe the dev database and rebuild the stack. Epoch, Round and Player rows carry no pool
       column, so the previous pool's rows collide with the new pool's ids on the same numbers.

         docker compose -f docker-compose.dev.yml down -v
         docker compose -f docker-compose.dev.yml up -d --build

       The container runs prisma migrate deploy before node starts, which is what adds the new
       columns. Confirm with curl localhost:8080/pool for the new poolId and curl
       localhost:8080/status for rpcOk true and a lastAction a few seconds old.

    4. Repoint the dev frontend: VITE_POOL_ID=7 in apps/web/.env, plus VITE_PROGRAM_ID if the
       program id moved. Vite reloads on its own. A stale id reads an account that no longer
       exists and the screen sits empty.

    5. Sparring player, once per pool. Its Principal lived on the old pool, so the deposit has to
       happen again; the script reuses SPARRING_KEYPAIR from .env and only redoes what is missing.

         set -a; . ./.env; set +a; pnpm --filter @hexvault/backend sparring-setup

    6. Now the VPS, which has its own authority, mint and pool. .env.vps is the local mirror of
       the .env that lives on the box, and bootstrap runs from here against it:

         sed -i '' 's/^POOL_ID=.*/POOL_ID=8/' .env.vps
         set -a; . ./.env.vps; set +a
         pnpm --filter @hexvault/backend bootstrap \
           --epoch-anchor 2026-09-13T16:00:00Z --epoch-seconds 86400 \
           --round-seconds 30
         DATABASE_URL=postgresql://x pnpm --filter @hexvault/backend admin set-params --close-buffer 12
         pnpm --filter @hexvault/backend sparring-setup

       Open a new shell first. `set -a` on a second env file does not unset what the first one
       exported, so leftover dev values silently win wherever .env.vps happens to be missing a
       key, and the command runs against the wrong authority.

    7. On the box, set POOL_ID=8 in its .env, then pull and recreate. Compose hardcodes
       env_file: .env, so the file is named .env there whatever it is called in this repo.
       Wipe the volume for the same reason step 3 does: Epoch, Round and Player are keyed by
       chain id alone, so the previous pool's rows collide with the new pool's ids. FaucetClaim
       goes with it, so anyone who already claimed may claim again.

         sed -i 's/^POOL_ID=.*/POOL_ID=8/' .env
         git pull
         docker compose down -v
         docker compose up -d --build

    8. Vercel: set VITE_POOL_ID to 8 on the project pointed at api-hexo.elvtd.io and redeploy.
       A Vercel env var only reaches the bundle on the next build, so a redeploy is required.

    9. Smoke it once a round has settled. The authority's Player account is the House:

         curl -s https://api-hexo.elvtd.io/rounds/<id> | jq '{pot, houseCut}'
         curl -s https://api-hexo.elvtd.io/players/<authority> | jq .entries

       houseCut is floor(pot × house_cut_bps ÷ 10000) and the House's entries rise by exactly
       that. A forfeited round reads houseCut 0 with the whole pot going to the House instead.

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

  Frontend RPC endpoint and checking for a leaked key

  The browser reads chain data through VITE_PUBLIC_RPC_URL, a public endpoint that Vite inlines into the shipped bundle at build
  time, defaulting to devnet's public cluster URL when unset. Never set this to a keyed URL: whatever the variable holds ships in
  plaintext to every visitor, in the JS bundle and again in the wss:// URL the wallet layer derives from that same string. The
  backend's own RPC endpoint is a separate, server-only variable and never reaches the frontend build. Everything else the browser
  shows comes from the backend API, mostly one poll of GET /state; the wallet's own token balance is the only thing it still reads
  from the chain directly.

  Check a local build for a leaked key:

    pnpm --filter @hexvault/web build
    grep -r "api-key=" apps/web/dist
    grep -r "helius-rpc.com" apps/web/dist

  Both greps should print nothing. Check a deployed site the same way, without a local build, by pulling down what the browser actually
  downloads:

    curl -s https://<deployed-host>/ | grep -oE '/assets/[^"]+\.js'
    curl -s https://<deployed-host><asset-path-from-above> | grep -E "api-key=|helius-rpc.com"
