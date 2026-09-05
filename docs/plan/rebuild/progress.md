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

`89fb8b3` adds the shared `fulfillRandomness` and `randomnessFor` test helpers.

The whole program suite run together after 03 and 04 merged: 24 localnet tests
passed, 15 Rust unit tests passed.

## Next

Tickets 06 (indexer), 07 (operator) and 08 (API) all depend on 05, which is in.
09 (bootstrap) also only needs 05. 07 depends on 06; 08 depends on 06.

## How the program is split

`lib.rs` only declares instructions and delegates to `custody.rs`, `rounds.rs`
and `epochs.rs`. That is the whole reason 03 and 04 can run in parallel: neither
touches `lib.rs`, so neither can conflict with the other. Handler names and
argument lists in those three modules are fixed by `lib.rs` and must not change.

Shared and owned by nobody working a ticket: `state.rs`, `touch.rs`, `errors.rs`,
`events.rs`, `constants.rs`, `vrf.rs`, `tests/helpers/hx.ts`,
`tests/run-local.sh`.

## Running the localnet suite

`HEXVAULT_RPC_PORT=<port> sh tests/run-local.sh tests/<file>` builds with
`--features test-vrf`, boots an isolated validator on that port, deploys, and
runs vitest. The port override exists so several suites can run side by side.
Assign a distinct port per concurrent agent; 8899 and 9099 were used for the
rounds and epoch suites.

A full run takes two to four minutes. Run it in the foreground with a generous
timeout. Launching it as a background task and then waiting on the result burned
an hour on ticket 02, because the wait itself ends the turn and nothing advances.

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
  the program changes. Re-run the sync script once the program is final.
  `ChainService` overrides the IDL's own `address` with the env `PROGRAM_ID`, so
  a stale snapshot cannot point the backend at the wrong program.
- The backend needs `HEXUSDC_MINT`, which does not exist until `bootstrap`
  (ticket 09) has run once.
