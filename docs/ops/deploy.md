# Deploying and upgrading

One script, `scripts/deploy.sh <dev|devnew|staging|mainnet> [--upgrade] [--dry-run]`, builds,
checks and deploys or upgrades the `hex_vault` program for one environment (`devnew` is the
fresh devnet program that carries the padded `Pool`/`Epoch`/`Player` layout, leaving the original
`dev` program and its pools untouched; see [`environments.md`](environments.md)). The same script also has two
opt-in actions, `--idl` (publish the on-chain IDL) and `verify` (reproducible-build
verification); see "Publishing the IDL" and "Verifiable build" below. Run it from the repo root,
same as `scripts/check-deployable.sh` and `tests/run-local.sh`. See
[`docs/ops/environments.md`](environments.md) for what each environment is.

## First deploy per environment

```bash
scripts/deploy.sh dev
scripts/deploy.sh staging
scripts/deploy.sh mainnet
```

The script, in order:

1. Maps the environment to a cargo feature, a keypair under `keys/`, and a cluster URL (devnet,
   or `DEPLOY_RPC_URL` when set, for dev, devnew and staging; `.env.mainnet`'s `RPC_URL` for
   mainnet).
2. Builds: a plain `anchor build` for dev (the default feature is the dev ID), `anchor build --
   --features <feature>` for devnew and staging, and `solana-verify build -- --features mainnet`
   for mainnet (see "Verifiable build" below). `solana-verify` only produces the `.so`, so for
   mainnet the script then regenerates the IDL with `anchor idl build -o target/idl/hex_vault.json
   -- --features mainnet`; otherwise step 4, `--idl` and the post-deploy `sync-idl` would read
   whatever IDL the last `anchor build` left behind.
3. Runs `scripts/check-deployable.sh`, which refuses a `test-vrf` artifact.
4. Asserts that the keypair's pubkey matches the built `declare_id!` (read from the built IDL's
   `address` field), so a mismatched keypair fails before anything is written on chain.
5. Writes a buffer, then deploys or upgrades against it. Both calls carry a priority fee
   (`--with-compute-unit-price`, from `DEPLOY_CU_PRICE`, default `100000`) and
   `--max-sign-attempts 50` so a large program lands under congestion; mainnet also adds
   `--use-rpc`, since it only helps when the RPC is stake-weighted (Helius, Triton) and only
   mainnet's RPC is. On mainnet there is a step in between: the buffer is written under the
   locally configured hot keypair, handed to the Ledger with `solana program
   set-buffer-authority <buffer> --new-buffer-authority <ledger pubkey>` (one hot-key signature),
   and only then deployed with `--upgrade-authority usb://ledger`. Writing the buffer under the
   Ledger directly would have the device sign every write chunk, since the loader's `Write`
   instruction needs the buffer authority as signer.
6. After the deploy, asserts the on-chain upgrade authority (`solana program show
   <program-id>`) equals the authority expected for the env: the Ledger on mainnet, the locally
   configured keypair (`solana address`) elsewhere. Then checks `solana program show --buffers
   --buffer-authority <that authority>` and fails if any buffer remains.
7. Prints the program's `solana program show` output, then runs both apps' `sync-idl` scripts.

`--dry-run` does steps 1 to 4 (and the ProgramData size read under `--upgrade`) but never calls
`solana program write-buffer`, `set-buffer-authority`, `extend`, `deploy` or `sync-idl`, and never
checks buffers or the upgrade authority. It touches no network write, so it is safe to run against real keys and a real
cluster to sanity-check a build.

If a step after `write-buffer` fails, the script prints the exact `solana program close <buffer>
--bypass-warning` command for the buffer it just wrote, so nothing is left stranded paying rent to
nobody. On mainnet the printed command carries `--buffer-authority usb://ledger` once
`set-buffer-authority` has landed, since from then on only the Ledger can close it; before that
point the hot key still owns the buffer and the plain command is right. The post-deploy buffer
check catches the same thing for any other leftover buffer under the same authority (an
interrupted previous run, for example), and counts buffers with `jq` when it is installed and a
`grep` of `"address"` keys otherwise.

Every printed command shows `--url "$RPC_URL"` (mainnet) or `--url "$DEPLOY_RPC_URL"` (a keyed
devnet endpoint) instead of the URL itself, because a keyed RPC URL carries its api key; export
the variable (`set -a; . ./.env.mainnet; set +a`) before pasting one.

Mainnet asks for a typed confirmation of the program ID before writing the buffer, and signs the
deploy with `--upgrade-authority usb://ledger`. The fee payer for `write-buffer` and `deploy`
defaults to the locally configured keypair (`solana config get`); set `FEE_PAYER_KEYPAIR` (a
keypair file path) to pay those two from somewhere else. Keep it a file: a `usb://ledger` fee
payer would put the device back on every write chunk. `set-buffer-authority` is always signed
and paid by the locally configured keypair, since that key is the buffer's authority at that
point.

### The cosmetic "Program ID mismatch" warning

`anchor build -- --features staging` (or `mainnet`) prints:

```
Program ID mismatch detected for program 'hex_vault':
Please run 'anchor keys sync' to update the program ID in your source code or use the '--ignore-keys' flag to skip this check.
```

This is Anchor comparing the built `declare_id!` against `Anchor.toml`'s `[programs.localnet]` /
`[programs.devnet]` entries, which always carry the dev program ID (`Anchor.toml`'s `[programs.
mainnet]` entry is the only one that matches a non-dev build, and only for mainnet). Ignore it:
`deploy.sh` never runs `anchor deploy` or `anchor keys sync`, and its own step 4 above is the
real check against the keypair you are about to deploy with.

## Upgrading

```bash
scripts/deploy.sh dev --upgrade
```

Before writing a buffer, the script reads the current ProgramData size (`solana program show`)
and compares it against the new `.so`. If the build is larger, it prints the exact `solana
program extend <program-id> <bytes>` command and, outside `--dry-run`, asks to run it (`y/N`)
before continuing; `solana program deploy` also auto-extends if a required extend was skipped, so
declining here is not a hard stop.

**Deploy an upgrade only when no `Round` is open.** `Round` has no reserved padding by design
(ADR 0013): it is short-lived and reclaimed by `close_round`, so a layout change is acceptable
there but only for rounds that open after the upgrade. A `Round` account already open at the
moment of an upgrade that changes `Round`'s layout fails to deserialize on the next instruction
that touches it, until the round is abandoned; its Entries (not USDC) become unclaimable and its
rent is never reclaimed. Check `GET /status` (`openRoundId`) or wait for the current round to
settle before running `--upgrade`.

`Pool`, `Epoch` and `Player` carry `version` and `_reserved` padding precisely so an upgrade that
only adds a field there needs no such care; see ADR 0013.

### Rollback

Before any upgrade, dump the currently deployed bytes so there is a way back:

```bash
solana program dump <program-id> /tmp/hex_vault-prev.so --url <cluster>
```

To roll back, write a buffer from that dump and deploy it the same way as a forward upgrade:

```bash
solana program write-buffer /tmp/hex_vault-prev.so --url <cluster>
solana program deploy --buffer <buffer> --program-id keys/hex_vault-<env>-keypair.json --url <cluster>
```

A rollback only restores code. It does not undo state a newer version already wrote (for
example, a `version` bump or a field the old code never reads); check whether that matters before
relying on it.

### Closing stray buffers

A failed or abandoned `write-buffer` leaves a buffer account behind, paying rent to nobody in
particular:

```bash
solana program show --buffers --url <cluster>
solana program close <buffer-pubkey> --url <cluster>
```

On mainnet, a buffer that `deploy.sh` had already handed to the Ledger is listed and closed with
`--buffer-authority usb://ledger` on both commands; one from before `set-buffer-authority` is
still the hot key's and needs no flag.

`target/deploy/hex_vault-keypair.old.json` and `target/deploy/hex_vault-upgrade-buffer.json` in
this repo are exactly that: leftovers from before the per-environment keypairs (`keys/`) and
`deploy.sh` existed. Run `solana program show --buffers` against devnet, close whatever matches,
and delete the two files; they are not read by anything.

`deploy.sh` now catches this itself: it prints the close command if a later step fails right after
`write-buffer`, and it fails the run outright if `solana program show --buffers` still lists a
buffer under the deploy authority once the deploy has finished.

## Publishing the IDL

```bash
scripts/deploy.sh dev --idl
```

Builds (so the IDL reflects the current source), then runs `anchor idl init` the first time and
`anchor idl upgrade` on every run after that, against the env's cluster and program ID, signing
with the same authority as a deploy (`usb://ledger` on mainnet). It does not write a program
buffer or touch the deployed bytecode, so it is safe to run on its own after a deploy that only
changed instructions, accounts or docs on the Rust side without a corresponding binary change, or
any time the on-chain IDL has drifted. `--dry-run` prints which of `init`/`upgrade` it would run
without calling either. Not run automatically by a plain deploy, so a staging deploy stays fast;
run it whenever the IDL actually changed.

## Upgrade policy (ADR 0013)

- Append-only. A new field takes bytes from a struct's `_reserved`, never reorders or resizes an
  existing field.
- Its zero value must be a safe default, or the change bumps `version` and migrates the account
  lazily on first touch.
- A new capability is a new instruction (`foo_v2`), not a new required argument on an existing
  one; old clients keep working.
- `Round` and `Position` are exempt: no padding, because they are short-lived and reclaimed, and
  the affected-in-flight-rounds cost is accepted (see "Upgrading" above).

## Admin signing: local key, Ledger or Squads

Three ways an admin-gated instruction gets signed, picked by env vars the admin CLI
(`apps/backend/src/admin`) reads at run time:

- **Local key** (the default): `chain.keypair`, the same key configured for the operator, signs
  and sends directly. Fine for dev and staging.
- **Ledger**: `ADMIN_KEYPAIR=usb://ledger[?key=N]` (`key` defaults to 0, the same derivation path
  the `solana` CLI uses) signs through `@ledgerhq/hw-app-solana`. Plug the Ledger in and unlock
  the Solana app first. If `ADMIN_ADDRESS` is also set, the CLI checks the Ledger's pubkey
  against it before building any transaction and fails closed on a mismatch.
- **Squads** (mainnet today): set `ADMIN_ADDRESS` to the multisig vault's address without loading
  its key anywhere. Every admin-gated command (`set-params`, `shutdown`, `sweep-house`,
  `withdraw-principal`, `return-principal`, `set-operator`, `propose-admin`, `accept-admin`, and
  `grant-tickets`'s admin path) then builds the instruction with the vault as signer and fee
  payer and prints one base58 transaction on stdout instead of sending it
  (`apps/backend/src/admin/squads.ts`, `adminMode`); everything else it prints goes to stderr, so
  `admin withdraw-principal --amount 25000 | pbcopy` hands Squads a clean paste. In Squads:
  Transaction Builder, Add instruction, Import base58 encoded tx, paste, simulate, then collect
  approvals and execute. The transaction carries a blockhash that expires in about a minute;
  re-run the command for a fresh one if the paste took too long. `pause`, `fund-jackpot`,
  `fund-yield`, `principal-out` and `emergency-crank` never go through Squads: the first three
  are permissionless or dual-signer by design, and `principal-out` is read-only, so none of them
  has to wait on multisig approval, which matters most for `pause` in an incident.

`scripts/deploy.sh mainnet` always signs the program upgrade itself with a Ledger
(`--upgrade-authority usb://ledger`), independent of whichever of the three modes above the admin
CLI is using for instructions.

## Moving admin and the upgrade authority to Squads later

Not done yet for this environment split (spec.md "Out of Scope"): a new mainnet pool starts with
the upgrade authority on a Ledger, and the admin CLI can already print for a Squads vault
(`ADMIN_ADDRESS`, see "Admin signing" above) but nothing has actually handed the admin role to
one yet. The path, when it happens:

1. **Upgrade authority**: `solana program set-upgrade-authority <program-id>
   --new-upgrade-authority <squads-vault> --upgrade-authority usb://ledger` moves it from the
   Ledger to the vault.
2. **Admin role**: the current admin runs `admin propose-admin --key <squads-vault>`, then, with
   `ADMIN_ADDRESS=<squads-vault>` exported, `admin accept-admin`; the CLI prints a base58
   transaction with the vault as the proposed admin, and someone with a signer role in Squads
   imports and executes it. The two-step handover means a typo in `propose-admin` never hands the
   pool to an address nobody controls.
3. **Program upgrades under Squads from then on**: write a buffer as usual (`solana program
   write-buffer`), transfer the buffer's authority to the vault (`solana program
   set-buffer-authority <buffer> --new-buffer-authority <squads-vault>`), then propose the
   upgrade in Squads against that buffer and the program ID.
4. **Timelock**: a delay between Squads approval and execution, on top of Squads itself, is a
   later addition; not implemented here.

## Launch checklist

Before a real mainnet deploy:

- [ ] Independent audit of `programs/hex_vault`.
- [ ] A bug bounty (Immunefi or similar) live before or at launch.
- [ ] Verifiable build: repo pushed at the deployed commit, `solana-verify verify-from-repo` and
  `solana-verify remote submit-job` run (see "Verifiable build" below), or the local hash
  published if the repo stays private.
- [ ] Real contacts in `security_txt!` (`programs/hex_vault/src/lib.rs`): `project_url` and
  `contacts` are TODO placeholders today. A placeholder wastes a researcher's report.
- [ ] A paid RPC provider with its own API key for mainnet (never share the devnet key's rate
  limit or bill).
- [ ] `PRIORITY_FEE_MAX_MICROLAMPORTS` set for mainnet congestion, not left at the devnet default
  by accident.
- [ ] An uptime monitor polling `GET /alerts` (200 with an empty list when healthy, 503 with the
  active codes otherwise) as the paged URL, not `/healthz` or `/status`; see
  [`docs/ops/incidents.md`](incidents.md) for what to do when a code fires.
- [ ] The mainnet program keypair backed up offline before its first deploy. After that, only the
  upgrade authority (the Ledger) matters, but losing the keypair before the first deploy loses
  the program ID.

### Verifiable build

It needs a public repo at the deployed commit; whether this repo goes public is still open
(spec.md "Open items the user owns"). After a real deploy, from a machine with `solana-verify`
installed (`cargo install solana-verify`, needs Docker) and the repo pushed at the deployed
commit:

```bash
scripts/deploy.sh mainnet verify
```

This refuses on a dirty working tree, then runs, against the current commit:

```bash
solana-verify verify-from-repo \
  --url <cluster for the env> --program-id <program id for the env> \
  <repo-url> --commit-hash <deployed sha> -- --features mainnet

solana-verify remote submit-job \
  --program-id <program id for the env> [--uploader <pubkey>]
```

The `-- --features mainnet` cargo args go only to `verify-from-repo`, which rebuilds;
`submit-job` records the job and takes no build flags. `<repo-url>` is `git remote get-url
origin`, converted from SSH to HTTPS if needed; set `VERIFY_REPO_URL` to override it.
`--uploader` expects a base58 pubkey (the address recorded as the job's uploader) and is only
added when `VERIFY_UPLOADER` is set to one; left unset, `solana-verify` falls back to its own
default (the locally configured keypair's pubkey). To use a keypair file's address, pass
`VERIFY_UPLOADER=$(solana-keygen pubkey <path>)`.
`verify` works for any env, not only mainnet, but only mainnet is built with `solana-verify build`
(dev and staging use a plain `anchor build`), so it is the one whose deployed bytecode is actually
reproducible this way.

If the repo stays private, run `solana-verify build -- --features mainnet` (`deploy.sh` already
does this for a mainnet build) plus `solana-verify get-executable-hash` locally, and publish the
hash instead of the OtterSec job.
