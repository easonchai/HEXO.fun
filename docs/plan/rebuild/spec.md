# Rebuild spec

Status: agreed. Implements [`docs/product-requirements.md`](../../product-requirements.md). Tickets live in [`issues/`](./issues/). Decisions with lasting consequences are recorded in [`docs/adr/`](../../adr/).

## 1. Repository after the rebuild

```
programs/hex_vault/     Anchor program, rewritten, new program ID
apps/web/               Vite React frontend, rewired
apps/backend/           NestJS + Prisma: indexer, operator, api modules
tests/                  Anchor integration tests against localnet (test-vrf feature)
docker-compose.yml      postgres + backend, Traefik labels on backend
docs/                   product-requirements.md, plan/, adr/, agents/
CONTEXT.md              glossary
```

Deleted: `packages/cli`, `packages/indexer`, `packages/api`, `scripts/*`, `infra/`, every old doc, the old tests.

## 2. Program

Anchor, one program, one `Pool` per `pool_id`. All amounts are `u64` atomic units at the accepted mint's decimals (6). Weight accumulators are `u128`. Time is `i64` unix seconds from `Clock`.

### 2.1 Accounts

```
Pool                 seeds ["pool", pool_id: u64]
  pool_id            u64
  authority          Pubkey        operator key; also the House's owner
  accepted_mint      Pubkey
  principal_vault    Pubkey        token acct, seeds ["principal", pool], authority = pool
  jackpot_vault      Pubkey        token acct, seeds ["jackpot", pool], authority = pool
  treasury           Pubkey        authority-owned token acct, set at create
  buyback_reserve    Pubkey        authority-owned token acct, set at create
  house              Pubkey        Player PDA for authority, created in create_pool
  epoch_seconds      i64           applies to the next epoch created
  round_seconds      i64           applies to the next round created
  close_buffer       i64           positions stop this many seconds before round end (5)
  vrf_timeout        i64           seconds after request before void/rollover (120)
  min_deposit        u64
  paused             bool
  current_epoch_id   u64           0 before the first epoch
  current_epoch_start i64
  previous_epoch_start i64
  next_round_id      u64
  carry_pot          u64           Entries carried from a voided round into the next round
  total_principal    u64
  bumps

Epoch                seeds ["epoch", pool, epoch_id]
  epoch_id           u64
  starts_at, ends_at i64
  status             u8   Open | Registering | Drawing | Drawn | Paid | RolledOver
  registered_weight  u128
  registered_count   u32
  jackpot_amount     u64           set at close_registration = jackpot_vault.amount
  vrf_seed           [u8;32]
  requested_at       i64
  target             u128          set by draw
  winner             Pubkey        set by payout

Round                seeds ["round", pool, round_id]
  round_id, epoch_id u64
  starts_at, ends_at i64
  status             u8   Open | Requested | Settled | Forfeited | Voided
  tile_totals        [u64; 36]
  pot                u64           staked + carry_in
  vrf_seed           [u8;32]
  requested_at       i64
  winning_tile       u8

Player               seeds ["player", pool, owner]
  owner              Pubkey
  principal          u64
  entries            u64
  weight_acc         u128          Σ entries × seconds within the current epoch (epoch_id below)
  last_update        i64
  epoch_id           u64           epoch the accumulator belongs to
  frozen_weight      u128          final weight for frozen_epoch
  frozen_epoch       u64
  reg_epoch          u64           epoch this player is registered for
  reg_start, reg_end u128          interval in that epoch's registered_weight
  is_house           bool

Position             seeds ["position", round, owner]
  owner, round       Pubkey
  tiles              u64           bitmask, bits 0..35
  stake_per_tile     u64
```

### 2.2 The touch rule (lazy reset and accrual)

Every instruction that reads or changes a Player's Entries calls `touch(player, pool, now)` first:

```
if player.epoch_id < pool.current_epoch_id:
    // finalize the epoch the player last acted in
    prev_end = pool.current_epoch_start           // epochs are contiguous
    if player.epoch_id == pool.current_epoch_id - 1:
        player.frozen_weight = player.weight_acc + player.entries × (prev_end - player.last_update)
    else:
        // idle through the previous epoch: entries were (conceptually) principal all epoch
        prev_len = pool.current_epoch_start - pool.previous_epoch_start
        player.frozen_weight = player.principal × prev_len
    player.frozen_epoch = pool.current_epoch_id - 1
    player.entries    = player.principal          // House: principal is 0, so entries reset to 0
    player.weight_acc = player.principal × (now - pool.current_epoch_start)
    player.last_update = now
    player.epoch_id   = pool.current_epoch_id
else:
    player.weight_acc += player.entries × (now - player.last_update)
    player.last_update = now
```

`frozen_weight` uses the principal *before* the current instruction changes it, which closes the "deposit right after epoch end to inflate last epoch's weight" hole. Only the most recent ended epoch is frozen; a player who is untouched for several epochs gets `principal × prev_len` for the immediately previous one, which is correct because idle means Entries equalled Principal.

### 2.3 Instructions

Authority-only unless marked permissionless. All amount math is checked; any overflow aborts.

**Custody**

- `create_pool(pool_id, params)`: creates Pool, two vaults, the House Player (`is_house = true`, owner = authority). Records treasury and buyback_reserve token accounts (must be owned by authority, mint = accepted_mint).
- `set_params(epoch_seconds?, round_seconds?, close_buffer?, vrf_timeout?, min_deposit?)`: takes effect for the next epoch or round created. Cannot change mint, vaults, treasury, buyback_reserve, authority.
- `set_pause(bool)`: blocks deposit, create_round, buy_position. Never blocks withdraw.
- `deposit(amount)` permissionless, `init_if_needed` Player: `touch`; require `!paused`, `amount >= min_deposit`; transfer owner → principal_vault; `principal += amount; entries += amount; pool.total_principal += amount`.
- `withdraw(amount)` permissionless: `touch`; require `principal >= amount && entries >= amount && amount > 0`; `principal -= amount; entries -= amount; total_principal -= amount`; transfer principal_vault → owner.

**Rounds**

- `create_round(starts_at, ends_at)`: require `!paused`, no Open/Requested round exists (pool tracks `open_round_id`, 0 when none), `ends_at - starts_at == round_seconds`, `ends_at <= current epoch ends_at`. `round_id = next_round_id++`, `pot = pool.carry_pot; pool.carry_pot = 0`, seed = keccak("round", pool, round_id).
- `buy_position(round, tiles, stake_per_tile)` permissionless: `touch`; require round Open, `now < ends_at - close_buffer`, `tiles != 0 && tiles < 2^36`, `stake_per_tile >= 1`, `total = stake × popcount(tiles)`, `entries >= total`. Pre-credit weight: `weight_acc += total × (round.ends_at - now)`. Then `entries -= total`, each selected `tile_totals[t] += stake`, `pot += total`. Creates Position (rent paid by owner).
- `request_round_randomness(round)` permissionless: require Open, `now >= ends_at - close_buffer` (the close, when Positions stop); CPI ORAO `request_v2(seed)`; status Requested, `requested_at = now`.
- `settle_round(round, orao_randomness, house Player)`: require Requested and ORAO account fulfilled; `winning_tile = u64(randomness[0..8]) % 36` (bias < 2^-59, documented); if `tile_totals[tile] == 0`: `touch(house)`; `house.entries += pot`; status Forfeited; else status Settled. Sets `pool.open_round_id = 0`.
- `settle_position(round, position, player)` permissionless: `touch(player)`; require round Settled or Forfeited; if Settled and position covers winning_tile: `reward = pot × stake_per_tile / tile_totals[winning_tile]`, `entries += reward`. Closes Position, rent to owner. Integer division dust stays unminted and is documented as negligible.
- `void_round(round)`: require Requested and `now > requested_at + vrf_timeout`; `pool.carry_pot += pot`; status Voided; `open_round_id = 0`. Positions in a voided round settle to zero reward and close.

**Epochs**

- `begin_epoch()`: if `current_epoch_id == 0`: `starts_at = now`; else require `now >= current.ends_at`, set previous Epoch status Registering, `starts_at = previous.ends_at`. `ends_at = starts_at + epoch_seconds`. `previous_epoch_start = current_epoch_start; current_epoch_start = starts_at; current_epoch_id += 1`.
- `register(epoch, player)` permissionless: require epoch Registering, `epoch.epoch_id == current_epoch_id - 1`, `player.reg_epoch != epoch.epoch_id`. Weight:
  ```
  if player.epoch_id == epoch.epoch_id:      w = weight_acc + entries × (epoch.ends_at - last_update)   // not touched since; do not mutate
  elif player.epoch_id > epoch.epoch_id:     require frozen_epoch == epoch.epoch_id; w = frozen_weight
  else:                                      w = principal × (epoch.ends_at - epoch.starts_at)
  ```
  If `w == 0` return Ok without registering. Else `reg_epoch = id; reg_start = registered_weight; reg_end = reg_start + w; registered_weight = reg_end; registered_count += 1`.
- `fund_jackpot(amount)` permissionless: transfer any token account → jackpot_vault. Emits `JackpotFunded { source, amount }`.
- `close_registration(epoch)`: require Registering. `jackpot_amount = jackpot_vault.amount`. If `registered_weight == 0`: status RolledOver. Else seed = keccak("epoch", pool, id), CPI ORAO request, status Drawing, `requested_at = now`.
- `draw(epoch, orao_randomness)`: require Drawing and fulfilled; `target = u128(randomness[0..16]) % registered_weight` (bias < 2^-70); status Drawn.
- `payout(epoch, winner Player, winner token acct, treasury, buyback_reserve)`: require Drawn, `winner.reg_epoch == id`, `reg_start <= target < reg_end`. If `winner.is_house`: transfer 50% → buyback_reserve, 20% → treasury, remainder stays. Else transfer `jackpot_amount` → winner token acct. `epoch.winner = owner`; status Paid. Emits `JackpotPaid`.
- `rollover_epoch(epoch)`: require Drawing and `now > requested_at + vrf_timeout`; status RolledOver. Funds stay.

### 2.4 Invariants (each has a test)

1. `principal_vault.amount == pool.total_principal == Σ player.principal`.
2. `Σ player.entries + Σ unsettled round pot + carry_pot == total_principal`, summing every Player including the House, evaluated after touching all of them at one instant. Settlement dust from integer division is the only slack. (This line previously read `== total_principal + house.entries`, which double-counts the House: Entries are created only by `deposit` and destroyed only by `withdraw`, and everything the game does just moves them between Players and pots. Corrected in ticket 04, where the sweep is checked against a real forfeited pot.)
3. `withdraw(x)` succeeds iff `principal >= x && entries >= x`, in every pool and epoch state including paused.
4. No instruction transfers from `principal_vault` except `withdraw`, and only to the Player's owner.
5. `Σ settle_position rewards for a round <= round.pot`.
6. `payout` transfers exactly `jackpot_amount` (or its 70% when the House wins), once, to the account whose interval contains `target`.
7. A player untouched for an entire epoch registers `principal × epoch_len`; a player who deposits `d` at time `t` in an epoch of length `L` registers `d × (L - t)` plus whatever they had before.
8. `touch` never lets a change in the current epoch alter the weight registered for the previous one.

### 2.5 Randomness

ORAO VRF v2, devnet network state `5ER1oENnV4srxYdAynUfRzWeQCPQaqMiAp4VqyMbSqnK`. The requesting instruction CPIs `request_v2` with a seed derived from the subject, so each round and each epoch has one randomness account. Settling instructions read that account and require it fulfilled. A Cargo feature `test-vrf` compiles in `test_fulfill(subject, bytes)` that writes a fake fulfilled randomness account; the devnet build is compiled without it. The tile and target mapping is rejection sampling with a rehash, not modulo reduction: `vrf::unbiased_u64` and its u128 twin reject a sample above the range's last full multiple and rehash the randomness with a counter instead. The bias bound is documented on `vrf::unbiased_u64` in the program.

### 2.6 Events

`Deposited`, `Withdrawn`, `RoundOpened`, `PositionBought`, `RoundSettled { round_id, winning_tile, pot, forfeited }`, `RoundVoided`, `PositionSettled { owner, reward }`, `EpochBegan`, `Registered { owner, weight }`, `JackpotFunded`, `EpochDrawn { target }`, `JackpotPaid { winner, amount, is_house }`, `EpochRolledOver`, `Paused`.

## 3. Backend (`apps/backend`)

NestJS 11, Prisma 6, Postgres 16, Node 22, TypeScript. One process; modules below. `@solana/web3.js` 1.x plus Anchor's TS client generated from the IDL, matching what `apps/web` already uses.

### 3.1 Env

```
DATABASE_URL
RPC_URL                 Helius devnet HTTP url (websocket derived)
PROGRAM_ID
POOL_ID                 default 1
AUTHORITY_KEYPAIR       base58 secret key
HEXUSDC_MINT            created by bootstrap
APR_BPS                 500
JACKPOT_FLOOR           10000000   (10 hexUSDC)
FAUCET_AMOUNT           1000000000 (1000 hexUSDC)
FAUCET_INTERVAL_SECONDS 3600
CORS_ORIGIN             https://<vercel-domain>
PORT                    8080
```

### 3.2 Prisma schema

```
Pool       address pk, poolId, authority, mint, epochSeconds, roundSeconds, paused, currentEpochId, totalPrincipal, carryPot, updatedSlot
Epoch      id pk (epochId), startsAt, endsAt, status, registeredWeight (Decimal), registeredCount, jackpotAmount, target (Decimal), winner
Round      id pk (roundId), epochId, startsAt, endsAt, status, pot, winningTile, tileTotals (Json)
Player     owner pk, principal, entries, weightAcc (Decimal), lastUpdate, epochId, frozenWeight, frozenEpoch, regEpoch, regStart, regEnd, isHouse
Position   address pk, owner, roundId, tiles (BigInt), stakePerTile, settled
Event      slot, signature, index  composite pk; name, data Json, blockTime
Cursor     id pk=1, lastSignature, lastSlot
FaucetClaim owner pk, lastClaimAt
OperatorState id pk=1, lastTickAt, lastAction, lastError, registeredCount, registeredTotal
```

All on-chain `u64` map to `BigInt`, `u128` to `Decimal(40,0)`. The API serializes both as decimal strings.

### 3.3 Indexer module

- Every 2 s: `getProgramAccounts` filtered by discriminator for Pool, Epoch, Round, Player, Position; decode with the Anchor coder; upsert. Rows for closed Positions are deleted when the account is gone.
- Finalized `onLogs(programId)` subscription plus a catch-up `getSignaturesForAddress` from the cursor on boot; decode `Program data:` lines with the Anchor event coder; insert into `Event` ignoring duplicates; advance cursor in the same transaction.
- Exposes `getPlayers()`, `getOpenRound()`, `getEpoch(id)` to the operator from Postgres so the operator does not hammer the RPC.

### 3.4 Operator module

`@nestjs/schedule` interval 2 s, single-flight (skip a tick if the previous is still running). Each tick reads fresh Pool/Epoch/Round state from chain (three `getAccountInfo` calls), then runs in order and stops after the first transaction sent:

1. Open round past `endsAt - closeBuffer` (the close, the same instant `buy_position` starts refusing) → `request_round_randomness`, so ORAO's round trip runs inside the countdown. Requested round: fulfilled → `settle_round`; timed out → `void_round`. Round steps run first so a Round can never straddle an Epoch boundary that step 3 might open.
2. Unsettled Positions in Postgres on any Round that is Settled, Forfeited or Voided, not just the newest → `settle_position`, up to 8 per transaction, one Round per tick.
3. `begin_epoch`, only when the current Epoch has ended, `open_round_id == 0`, step 2 found nothing, and the previous Epoch (if any) is `Paid` or `RolledOver`.
4. Previous epoch `Registering`: from Postgres take players with `regEpoch != prev.id` and non-zero computed weight; send `register` for up to 8 players per transaction. When none remain, `close_registration` (`fund_jackpot(max(floor, totalPrincipal × APR × len / year))` from the authority's hexUSDC account, mint to self first if short, then close) is sent only once the list has come back empty on two consecutive ticks, so a player who deposited just before `ends_at` gets one more indexer sync window before being counted out.
5. Previous epoch `Drawing`: if ORAO account fulfilled → `draw`; else if `now > requestedAt + vrfTimeout` → `rollover_epoch`.
6. Previous epoch `Drawn`: find the Player with `regEpoch == id && regStart <= target < regEnd` → `payout` (create the winner's ATA idempotently in the same transaction).
7. No open round and `now + roundSeconds <= epoch.endsAt` and not paused and the previous Round's reveal has played (no previous Round, or it is Voided, or `now >= previousRound.endsAt + 5`) → `create_round(now, now + roundSeconds)`.

Every step writes `OperatorState.lastAction`; any thrown error writes `lastError` and the tick ends. Program errors for "already done" states are expected and logged at debug.

### 3.5 API module

```
GET  /pool                      pool row + current epoch + open round summary
GET  /epochs?limit=20           newest first
GET  /epochs/current            includes drawing progress: registeredCount / eligible players
GET  /rounds?limit=50           newest first, includes winningTile and pot
GET  /rounds/:id
GET  /players/:owner            row + liveWeight (acc + entries × (now − lastUpdate)) + odds
GET  /leaderboard?limit=20      players by liveWeight in the current epoch
GET  /feed?limit=50             events newest first, filtered to user-facing names
GET  /status                    OperatorState + indexer cursor age + rpc ok
GET  /healthz
POST /faucet { owner }          mints FAUCET_AMOUNT hexUSDC to owner's ATA once per FAUCET_INTERVAL_SECONDS per owner; 429 otherwise
```

CORS restricted to `CORS_ORIGIN`. Amounts are decimal strings.

### 3.6 Bootstrap command

`pnpm --filter backend bootstrap` (a Nest standalone script): create the hexUSDC mint (6 decimals, authority = keypair), the authority's ATA, treasury and buyback_reserve token accounts, then `create_pool`. Prints env values to paste into `.env`. Idempotent: skips what exists.

## 4. Frontend (`apps/web`)

- Regenerate the IDL; rewrite `actions.ts` to: `deposit`, `withdraw`, `buyPosition`, `settlePosition`, `register`. Delete Merkle, snapshot proof, keccak, claim, refresh, mock randomness, multi-pool code.
- `read.ts`: fetch own Player and open Round from RPC on an interval and on the `RoundSettled` websocket event. Everything else from `api.ts` polling every 2 s.
- Screens: Arena (existing), Vault (deposit/withdraw/faucet, withdrawable = min(principal, entries)), Jackpot (replaces Prizes: countdown, simulated jackpot, your weight and odds, drawing state, last winners), Leaderboard tab, status pill in the header.
- Copy rules: "Entries", "Principal", "deposit", "withdraw", "round pot", "jackpot (simulated)". Never "bet", "stake" as a noun for the deposit, "prize", "claim".
- Env: `VITE_RPC_URL`, `VITE_API_URL`, `VITE_PROGRAM_ID`, `VITE_POOL_ID`, `VITE_PRIVY_APP_ID`.

## 5. Infra

- `apps/backend/Dockerfile`: multi-stage, `pnpm install --frozen-lockfile`, `prisma generate`, `nest build`, runtime `node dist/main.js`; `prisma migrate deploy` on start.
- `docker-compose.yml`: `postgres:16-alpine` with a volume, `backend` built from the Dockerfile, joined to the existing Traefik network with router labels for the API host. Traefik itself is already running on the VPS and is not part of this compose file.
- Program deploy: `anchor build && anchor deploy --provider.cluster devnet` from a machine with the deploy key; the program ID is committed in `Anchor.toml` and `declare_id!`.
- Vercel: root `apps/web`, build `pnpm --filter web build`, env vars above.

## 6. Testing

- `cargo test -p hex_vault --lib`: touch rule, register weight cases, reward math, tile and target mapping.
- `tests/`: Anchor localnet suite compiled with `test-vrf`: custody invariants, pause, round lifecycle including forfeit and void, position settlement and rent refund, epoch lifecycle including register cases (active, idle, touched-after), draw, payout to player and to House, rollover, and the account-substitution attacks from the old suite.
- Backend: Vitest unit tests for the operator step selection given fake chain state, and for API serialization. One Postgres integration test for the indexer upsert path.
- Frontend: keep the existing money and tile unit tests; add one for withdrawable math.

## 7. Defaults

| parameter        | value           |
| ---------------- | --------------- |
| epoch_seconds    | 86400           |
| round_seconds    | 60              |
| close_buffer     | 5               |
| vrf_timeout      | 120             |
| min_deposit      | 1 hexUSDC       |
| APR              | 5%              |
| jackpot floor    | 10 hexUSDC      |
| faucet           | 1000 hexUSDC/h  |
| House split      | 50 / 30 / 20    |
