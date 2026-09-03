# @hexvault/cli — `hexvault`

Operator CLI for the HexVault Anchor program (`6aDFSdwXESHF7UXJRCkHogNtUTbDPajmLupsfvzTSGvB`).
Localnet/devnet only. JSON output by default (`--text` for humans), so scripts and tests can
consume it directly.

## Run

```sh
pnpm exec tsx src/index.ts --help          # from packages/cli
pnpm exec tsx src/index.ts pool show --pool-id 1
```

`bin` exposes `hexvault`, so once the workspace links it (`pnpm install`), `pnpm exec hexvault …`
works from anywhere in the repo.

### Options and environment

| Flag                | Env                     | Default                    | Meaning                                                                             |
| ------------------- | ----------------------- | -------------------------- | ----------------------------------------------------------------------------------- |
| `-u, --url`         | —                       | `http://127.0.0.1:8899`    | RPC endpoint                                                                        |
| `-k, --keypair`     | `HEXVAULT_KEYPAIR`      | `~/.config/solana/id.json` | signing keypair file                                                                |
| `--state-dir`       | `HEXVAULT_STATE_DIR`    | `<repo>/.hexvault`         | where `pool create` records receipt mints                                           |
| `-p, --pool`        | —                       | —                          | default pool id for per-pool commands                                               |
| `--text` / `--json` | —                       | JSON                       | output format                                                                       |
| —                   | `HEXVAULT_IDL`          | auto                       | path to `target/idl/hex_vault.json` (auto-resolved by walking up from this package) |
| —                   | `HEXVAULT_DATABASE_URL` | —                          | default `--db` for `snapshot export`                                                |

Per-pool commands accept either `--pool-id N` or the global `--pool N`.

### Conventions

- **Amounts are atomic units** (`bigint`, never floats): `--amount 1000000` with a 6-decimal
  accepted mint = `1.0`. Outputs include a decimal rendering alongside atomic values.
- **Times** are unix seconds or relative: `+60s`, `-5m`, `+2h`, `+1d`.
- **Tiles** are a comma list (`1,7,22`) or a single tile index; `0x…`/`0b…` select a raw mask.
- State-changing transactions are confirmed at `finalized` before the CLI prints.
- Exit codes: `0` ok · `2` usage error · `3` chain/RPC error · `4` failed assertion
  (e.g. `reconcile` verdicts, `--weight` disagreeing with the snapshot).

### Roles

The CLI wallet must hold whatever role a command needs: protocol authority
(`initialize`, `pool create`, `epoch create/next`, `round create`), guardian
(`pause`), snapshot authority (`prize/jackpot commit`, `expire`), mock randomness
authority (`randomness fulfill`), or plain user (`deposit`, `withdraw`, `refresh`,
`position buy`, `reward claim`, `prize/jackpot claim`). `prize/jackpot claim` may
relay for any `--winner`: the Merkle proof authorizes the payout.

## Full epoch lifecycle (worked example)

```sh
cd packages/cli
HV="pnpm exec tsx src/index.ts"

# 0. program-global init — signer must be the deployed program's upgrade authority
$HV initialize --guardian $GUARDIAN --snapshot $SNAPSHOT --mock-randomness $AUTHORITY

# 1. one pool against a devnet-USDC stand-in (6 decimals); receipt mints are generated
$HV pool create --pool-id 1 --mint $USDC \
  --min-deposit 1000000 --max-stake 100000 --max-bonus 50000 \
  --min-epoch-seconds 60 --max-epoch-seconds 86400 --buffer-seconds 10
# prints + stores the principal/entry mints in .hexvault/pool-1-mints.json (never overwritten)

# 2. epoch schedule (ordering + duration bounds are enforced on chain)
$HV epoch create --pool-id 1 --starts +0s --cutoff +300s --ends +600s --snapshot +600s --deadline +900s

# 3. users deposit (PT + ET minted 1:1), then buy positions before the round closes
$HV deposit --pool-id 1 --amount 50000000
$HV round create --pool-id 1 --round-id 1 --starts +0s --ends +590s --bonus 50000
$HV position buy --pool-id 1 --round-id 1 --tiles 1,7,22 --stake 1000

# 4. settle the round, pay the ET bonus, then fund the prize + jackpot escrows
$HV randomness request round --pool-id 1 --round-id 1
$HV randomness fulfill round --pool-id 1 --round-id 1 --sample 1234567
$HV reward claim --pool-id 1 --round-id 1
$HV prize fund --pool-id 1 --amount 10000000
$HV jackpot fund --pool-id 1 --amount 25000000

# 5. snapshot at/after prizeSnapshotAt, while the epoch is still OPEN and not paused
$HV snapshot export --pool-id 1 --epoch-id 1 --db postgres://… --out snapshot.json
$HV prize commit --pool-id 1 --epoch-id 1 --snapshot-file snapshot.json --prize-amount 10000000
$HV jackpot commit --pool-id 1 --epoch-id 1        # amount = current jackpot vault balance

# 6. draws
$HV randomness request prize --pool-id 1 --epoch-id 1
$HV randomness fulfill prize --pool-id 1 --epoch-id 1 --sample 42
$HV randomness request jackpot --pool-id 1 --epoch-id 1
$HV randomness fulfill jackpot --pool-id 1 --epoch-id 1 --sample 42

# 7. claims (winner derived from the drawn target interval; any wallet may relay)
$HV prize claim --pool-id 1 --epoch-id 1 --winner $WINNER --proof-file snapshot.json
$HV jackpot claim --pool-id 1 --epoch-id 1 --winner $WINNER --proof-file snapshot.json

# 8. if nobody claims before claimDeadline
$HV prize expire --pool-id 1 --epoch-id 1
$HV jackpot expire --pool-id 1 --epoch-id 1        # balance rolls into the next epoch
$HV epoch create --pool-id 1 --starts +0s --cutoff +300s --ends +600s --snapshot +600s --deadline +900s

# operator checks
$HV status
$HV pool show --pool-id 1
$HV balances --pool-id 1 --owner $USER
$HV jackpot status --pool-id 1
$HV pause on --pool-id 1        # withdrawal and refresh stay live while paused
$HV refresh --pool-id 1
$HV reconcile --pool-id 1       # exit 4 if any on-chain check fails
```

## `snapshot export`

Builds the Merkle-sum tree exactly as the program verifies it
(`hexvault:prize-leaf:v1` / `hexvault:prize-node:v1`, keccak-256, `u64` little-endian
sums, odd nodes promoted). Output:

```json
{
  "pool": "<pool PDA>",
  "epochId": "1",
  "root": "<32-byte hex>",
  "totalWeight": "150",
  "source": "db",
  "players": [
    {
      "owner": "<pubkey>",
      "weight": "50",
      "proof": [
        { "siblingHash": "<hex>", "siblingSum": "100", "siblingIsLeft": false }
      ]
    }
  ]
}
```

Two sources:

- `--db postgres://…` reads the indexer's per-player entries. It looks for a table named
  `player_entries`, `entries`, `snapshot_entries` or `player_balances` with an owner column
  (`owner`/`player`/`owner_pubkey`/`authority`) and a weight column
  (`weight`/`entry_weight`/`entries`/`entry_amount`/`balance`), filtering by `pool_id`/`epoch_id`
  when those columns exist. `--table` forces a name.
- without `--db`, weights are read from chain: every Token-2022 account holding the pool's
  entry mint. Exact by construction, and fine at localnet/devnet scale.

`prize commit` cross-checks the file's `pool`/`epochId` before sending.
`prize/jackpot claim` accepts the full snapshot file, a bare `players[]` array, or a single
`{weight, proof}` record, and refuses a `--weight` that disagrees with the snapshot.

## Testing

```sh
pnpm exec vitest run    # parsers (tiles/times/amounts) + Merkle-sum tree vs program vectors
pnpm run check          # tsc
```
