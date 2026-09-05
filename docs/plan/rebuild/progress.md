# Rebuild progress

Where the rebuild in [`spec.md`](./spec.md) actually stands. Each ticket's own
file carries the detail under its `## Comments`; this is the map.

## Done

| Ticket | Commit    | Verified by                                                     |
| ------ | --------- | --------------------------------------------------------------- |
| 01     | `bde6a49` | acceptance grep clean outside docs and the program being rewritten |
| 02     | `4d201b4` | `cargo test --lib` 15 passed, `tests/01-custody.test.ts` 6 passed |
| 05     | `e6e173d` | check, 2 vitest tests, build, `/healthz`, docker build against postgres:16-alpine |
| 03     | `3cbbf6e` | `tests/02-rounds.test.ts` 8 passed                                 |
| 04     | `0281e08` | `tests/03-epochs.test.ts` 10 passed                                |
| 09     | `eaf3053` | two localnet bootstrap runs, clean diff, with and without the fast-pool flags |
| 08     | `3d14b51` | 24 API tests against a seeded Postgres                             |
| 06     | `5f1e056` | 40 unit and Postgres tests, 3 localnet tests                       |
| 07     | `511fa8e` | 27 unit tests, one 47 s localnet end-to-end through payout         |
| 10     | `538be2a` | web check and vitest, then `9e923ae` matched the API client to ticket 08 |
| 11     | `8e03ac1` | web check clean, 41 vitest tests, copy audit at ticket 10's baseline |

`89fb8b3` adds the shared `fulfillRandomness` and `randomnessFor` test helpers.
`1cd51bc` adds what all four backend tickets needed from files none of them
owned: `PrismaService`, the resynced IDL, `Cursor.updatedAt`, the four new
dependencies, and `HEXVAULT_SKIP_BUILD`. `ce72add` wires the three server
modules into `AppModule`.

The whole program suite run together after 03 and 04 merged: 24 localnet tests
passed, 15 Rust unit tests passed. The backend suite after 06 to 09 merged: 97
passed, 4 skipped (the two localnet files, which each ran on their own).

## Next

12, and only 12. It is `ready-for-human` and needs the devnet deploy key and
the VPS. Step 4 of it (compose stack, env example, deploy runbook) landed in
`04b291b`; the deploy itself has not happened.

13's code landed in `e5bd20a`: the `admin` command group (`set-params`,
`pause`, `unpause`, `fund-jackpot`), the runbook sections, and
`apps/web/e2e/demo.spec.ts` behind an `E2E_BASE_URL` env var. Its ticket stays
`blocked`, because its acceptance is a passing Playwright run against the live
URL and there is no live URL yet. Point the env var at Vercel once 12 lands.

Two things nobody has run: the PRD §9 manual walkthrough on localnet that
ticket 11 asks for, and the demo spec itself against any stack. Both want a
validator, backend and frontend up together.

## How the program is split

`lib.rs` only declares instructions and delegates to `custody.rs`, `rounds.rs`
and `epochs.rs`. That is the whole reason 03 and 04 can run in parallel: neither
touches `lib.rs`, so neither can conflict with the other. Handler names and
argument lists in those three modules are fixed by `lib.rs` and must not change.

Shared and owned by nobody working a ticket: `state.rs`, `touch.rs`, `errors.rs`,
`events.rs`, `constants.rs`, `vrf.rs`, `tests/helpers/hx.ts`,
`tests/run-local.sh`.

## How the backend is split

Same trick, one directory per ticket: `src/indexer/`, `src/operator/`,
`src/api/`, `src/bootstrap.ts`. Tickets 06 to 09 ran in parallel because the
files none of them owned were written first and landed in `1cd51bc`:
`src/prisma/`, `src/chain/`, `src/config/`, `src/idl/`, `prisma/schema.prisma`
and `package.json`.

The operator depends on the indexer, so that edge is a token rather than an
import. `src/operator/indexer-queries.ts` declares `INDEXER_QUERIES` and the
two method signatures; `OperatorModule` binds it to `IndexerService`. Neither
module imports the other's implementation, and either could have landed first.

The binding has to live in `OperatorModule`. Nest resolves a provider's
dependencies from its own module and the exports of that module's imports,
never from the parent, so the same provider declared in `AppModule` is
invisible to `OperatorService`.

`ScheduleModule.forRoot()` is imported only by `OperatorModule`. The indexer
ticks on a plain `setInterval` for that reason: two `forRoot()` calls produce
two schedulers and every job fires twice.

## Running the localnet suite

`HEXVAULT_RPC_PORT=<port> sh tests/run-local.sh tests/<file>` builds with
`--features test-vrf`, boots an isolated validator on that port, deploys, and
runs vitest. The port override exists so several suites can run side by side.
Assign a distinct port per concurrent agent; 8899 and 9099 were used for the
rounds and epoch suites, 9199 / 9299 / 9399 for tickets 06, 07 and 09.

`HEXVAULT_SKIP_BUILD=1` reuses whatever is in `target/deploy` instead of
rebuilding. Several agents each running `anchor build` fight over one cargo
target lock to produce the identical artifact, so build once first, then set
it for every parallel run.

A backend suite driven this way needs `--root apps/backend --config
vitest.config.ts` appended, because the script runs vitest from the repo root
and the backend config's `include` is relative.

A full run takes two to four minutes. Run it in the foreground with a generous
timeout. Launching it as a background task and then waiting on the result burned
an hour on ticket 02, because the wait itself ends the turn and nothing advances.

## Running the backend tests

The Postgres suites want a real database:

```
docker run -d --name hexvault-pg -e POSTGRES_USER=hexvault \
  -e POSTGRES_PASSWORD=hexvault -e POSTGRES_DB=hexvault \
  -p 5433:5432 postgres:16-alpine
DATABASE_URL=postgresql://hexvault:hexvault@127.0.0.1:5433/hexvault \
  pnpm --filter @hexvault/backend exec prisma migrate deploy
```

That URL is `src/test-setup.ts`'s default. The four parallel agents each used
their own database on the same server (`hexvault_indexer`, `hexvault_operator`,
`hexvault_api`) so their truncations could not collide.

Boot smoke tests must run against `nest build` output, not `tsx`. Esbuild does
not emit `design:paramtypes`, so a tsx boot reports every constructor parameter
as unresolvable whether or not the DI graph is sound.

## Decisions taken during the build

- `Pool` has two fields the spec's §2.1 list omits but §2.3 and §2.5 need:
  `open_round_id` (the one-round-at-a-time gate) and `vrf_network_state`.
- Randomness under `test-vrf` never goes near ORAO. `test_fulfill` writes a
  `RandomnessV2`-shaped account at a PDA of this program, and
  `vrf::randomness_address` returns that address under the feature and ORAO's
  request PDA without it. The devnet build never compiles the feature.
- `vrf.rs` kept the existing rejection-sampling mapping instead of the plain
  modulo in spec §2.5. It was already written and tested, and it cannot strand a
  fulfilled draw the way a reverting modulo check can.
- `scripts/test-program-local.sh` became `tests/run-local.sh` rather than being
  deleted with the rest of `scripts/`. Tickets 02 to 04 all need a localnet
  runner and rewriting a working one is waste.
- Spec invariant 2 was wrong and is corrected in `spec.md`. It double-counted
  the House. See ticket 04's comments.
- Test suites read the validator's own clock rather than `Date.now()`. A test
  validator's slot-derived clock lags wall time under load, which made both the
  round and epoch suites fail on timing until they stopped trusting wall time.

## ORAO path, wired up 2026-09-05

The three linked gaps below were confirmed against ORAO's SDK source
(`rust/sdk/src/lib.rs`, `js/src/types/orao_vrf.json`, master on 2026-09-05)
and against two fulfilled devnet `request_v2` CPIs (tx `3nweeTq…` and
`43pTZkE…`), then fixed together:

1. `vrf::orao_request_address` derived `[prefix, network_state, seed]`. ORAO
   derives `[prefix, seed]`; the network state is not part of it. Both live
   requests created the `[prefix, seed]` account and no `[prefix,
   network_state, seed]` account existed. Fixed; a unit test pins the live
   seed/address pair so a drift fails `cargo test`.
2. `vrf::request_randomness` was a `todo!()`. Now a hand-built `request_v2`
   instruction plus `invoke` (discriminator `[38,151,209,6,195,102,28,217]`,
   accounts `payer, network_state, treasury, request, system_program`, data =
   discriminator ++ raw seed). No ORAO crate: its SDK pins an older
   `anchor-lang`. A unit test asserts the wire format.
3. `RequestRoundRandomness` and `CloseRegistration` gained `vrf_treasury`
   (mut). Clients pass `network_state.config.treasury`
   (`9ZTHWWZDpB36UFe1vszf2KEpt83vwi27jDqtHQ7NSXyR` on devnet, request fee
   0.0003 SOL). ORAO rejects any other account, the program only forwards it.
4. Not in the original note: `CloseRegistration.authority` was not `mut`, but
   it is the payer ORAO debits. The CPI would have failed on writable
   privilege even with 1 to 3 fixed. Now `mut`.

`pool.vrf_network_state` stays. It is redundant (ORAO's network state is the
fixed PDA `[b"orao-vrf-network-configuration"]`, verified by seeds inside the
CPI) but dropping it would churn `Pool`, `CreatePoolParams`, the helpers and
both IDL snapshots for no behaviour change. Settle and draw no longer read it.

Not yet done: a real request → fulfil → settle round trip on devnet. The
program is not deployed there. Ticket 13's smoke covers it; until then the
live-pinned unit tests are the only check on the ORAO side.

## Open, and needed before ticket 12

- `apps/backend/src/idl/hex_vault.json` is a snapshot and goes stale every time
  the program changes. Resynced in `1cd51bc` from the post-04 build; re-run the
  sync script again once the program is final. `ChainService` overrides the
  IDL's own `address` with the env `PROGRAM_ID`, so a stale snapshot cannot
  point the backend at the wrong program. It can still mislead the operator:
  `OperatorService` decides between the test-vrf randomness PDA and ORAO's
  request PDA by looking for `testFulfill` in the IDL, and logs which mode it
  picked at boot.
- The backend needs `HEXUSDC_MINT`, which `bootstrap` (ticket 09) prints on its
  first run.
- Sync the IDL to `apps/web` too. Ticket 10 owns that.
- `pnpm format:check` fails repo-wide, including on files untouched since
  ticket 05. There is no prettier config, so it is checking against defaults
  the code was never written to. Either add a config or reformat once, in its
  own commit, not mixed into a feature.
- Two `ponytail:` shortcuts are worth knowing about before load matters: the
  API scans every `Player` row per request for the odds denominator, and the
  faucet reads its claim row before minting rather than guarding the write, so
  two simultaneous requests for one owner can both mint.
