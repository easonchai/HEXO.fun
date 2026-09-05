# Rebuild progress

Where the rebuild in [`spec.md`](./spec.md) actually stands. Each ticket's own
file carries the detail under its `## Comments`; this is the map.

## Done

| Ticket | Commit    | Verified by                                                     |
| ------ | --------- | --------------------------------------------------------------- |
| 01     | `bde6a49` | acceptance grep clean outside docs and the program being rewritten |
| 02     | `4d201b4` | `cargo test --lib` 15 passed, `tests/01-custody.test.ts` 6 passed |
| 05     | `e6e173d` | check, 2 vitest tests, build, `/healthz`, docker build against postgres:16-alpine |

`89fb8b3` adds the shared `fulfillRandomness` and `randomnessFor` test helpers.

## In flight

Tickets 03 (rounds) and 04 (epochs), one agent each, running at the same time
against the same working tree.

## How the program is split

`lib.rs` only declares instructions and delegates to `custody.rs`, `rounds.rs`
and `epochs.rs`. That is the whole reason 03 and 04 can run in parallel: neither
touches `lib.rs`, so neither can conflict with the other. Handler names and
argument lists in those three modules are fixed by `lib.rs` and must not change.

Shared and owned by nobody working a ticket: `state.rs`, `touch.rs`, `errors.rs`,
`events.rs`, `constants.rs`, `vrf.rs` (except the one `request_randomness` body,
which is ticket 03's), `tests/helpers/hx.ts`, `tests/run-local.sh`.

## Running the localnet suite

`HEXVAULT_RPC_PORT=<port> sh tests/run-local.sh tests/<file>` builds with
`--features test-vrf`, boots an isolated validator on that port, deploys, and
runs vitest. The port override exists so several suites can run side by side.
Reserved while 03 and 04 are in flight: 8899 for rounds, 9099 for epochs.

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

## Open, and needed before ticket 12

- **The whole real ORAO path is unfinished and untested.** `test-vrf` bypasses
  ORAO entirely, so nothing in the suite touches any of this. Three pieces, and
  they have to land together because they cut across `vrf.rs`, `rounds.rs` and
  `epochs.rs`:
  1. `vrf::request_randomness` is a `todo!()`. Ticket 03 verified the shape
     against ORAO's generated IDL and CPI example: discriminator
     `[38,151,209,6,195,102,28,217]`, accounts `payer, network_state, treasury,
     request, system_program` in that order.
  2. That CPI needs a `treasury` account, which `request_randomness` does not
     take and neither request context passes.
  3. `vrf::orao_request_address` looks wrong. It derives the request PDA from
     `[prefix, network_state, seed]`, but ORAO's SDK uses `[prefix, seed]` with
     no network state. If that holds, every real request and settle would look
     for an account ORAO never creates. Carried over from the pre-rebuild code,
     so it was never right. Confirm against a live devnet request before
     changing it, then fix all three at once.
- `apps/backend/src/idl/hex_vault.json` is a snapshot and goes stale every time
  the program changes. Re-run the sync script once the program is final.
  `ChainService` overrides the IDL's own `address` with the env `PROGRAM_ID`, so
  a stale snapshot cannot point the backend at the wrong program.
- The backend needs `HEXUSDC_MINT`, which does not exist until `bootstrap`
  (ticket 09) has run once.
