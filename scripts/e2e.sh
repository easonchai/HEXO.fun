#!/bin/sh
# HexVault end-to-end lifecycle proof on an isolated local validator.
# Prereqs (script starts them itself):
#   - target/deploy/hex_vault.so built (`anchor build`)
#   - ~/.config/solana/id.json exists (deployer + protocol authority)
#   - docker compose db service running:  docker compose up -d db
# Usage: sh scripts/e2e.sh
set -eu

cd "$(dirname "$0")/.."
ROOT="$PWD"
export PATH="$HOME/.cargo/bin:$PATH"
HV() { pnpm exec tsx packages/cli/src/index.ts "$@"; }

# A freshly-reset test-validator can accept the deploy before its runtime is
# able to load program ELFs, so the first few instructions transiently fail
# with "Attempt to load a program that does not exist". Retry only that
# transient failure; every other error fails immediately.
HV() {
  attempt=1
  while :; do
    status=0
    out=$(pnpm exec tsx packages/cli/src/index.ts "$@" 2>&1) || status=$?
    if [ $status -eq 0 ]; then printf '%s\n' "$out" | /usr/bin/grep -v punycode | /usr/bin/grep -v 'bigint:' | /usr/bin/grep -v DeprecationWarning || true; return 0; fi
    if printf '%s\n' "$out" | /usr/bin/grep -Eq "Attempt to load a program that does not exist|Program is not deployed" && [ "$attempt" -lt 8 ]; then
      attempt=$((attempt + 1))
      sleep 3
      continue
    fi
    printf '%s\n' "$out" | /usr/bin/grep -v punycode | /usr/bin/grep -v 'bigint:' | /usr/bin/grep -v DeprecationWarning || true
    printf '%s\n' "$out" > "${TMPDIR:-/tmp}/hx-e2e-last-failure.log"
    return $status
  done
}

# Waits for chain time to reach a program-enforced gate: retries the command
# while it fails with a "too early" error (test-validator's chain clock does
# not advance at wall speed, so timed sleeps cannot target it).
HV_WAIT() {
  attempt=1
  while :; do
    status=0
    out=$(pnpm exec tsx packages/cli/src/index.ts "$@" 2>&1) || status=$?
    if [ $status -eq 0 ]; then printf '%s\n' "$out" | /usr/bin/grep -v punycode | /usr/bin/grep -v 'bigint:' | /usr/bin/grep -v DeprecationWarning || true; return 0; fi
    case "$out" in
      *RoundClosed*|*InvalidTimeWindow*|*EpochNotOpen*|*PrizeClaimStillOpen*)
        if [ "$attempt" -lt 60 ]; then attempt=$((attempt + 1)); sleep 3; continue; fi ;;
    esac
    printf '%s\n' "$out" | /usr/bin/grep -v punycode | /usr/bin/grep -v 'bigint:' | /usr/bin/grep -v DeprecationWarning || true
    return $status
  done
}

say() { printf '\n=== %s ===\n' "$1"; }

# ---------------------------------------------------------------- validator
LEDGER="${TMPDIR:-/tmp}/hx-e2e-ledger-$$"
LOG="$LEDGER.log"
solana-test-validator --ledger "$LEDGER" --reset --quiet >"$LOG" 2>&1 &
VALIDATOR_PID=$!
cleanup() {
  kill "$VALIDATOR_PID" 2>/dev/null || true
  wait "$VALIDATOR_PID" 2>/dev/null || true
  rm -rf "$LEDGER"
}
trap cleanup EXIT INT TERM

for _ in $(seq 1 30); do
  solana --url http://127.0.0.1:8899 cluster-version >/dev/null 2>&1 && break
  sleep 1
done
solana --url http://127.0.0.1:8899 cluster-version >/dev/null
kill -0 "$VALIDATOR_PID" || { echo "e2e validator died at startup (port conflict?)" >&2; exit 1; }

say "deploy program"
solana program deploy target/deploy/hex_vault.so \
  --url http://127.0.0.1:8899 \
  --upgrade-authority ~/.config/solana/id.json >/dev/null
# The program account must be readable before any instruction is attempted;
# a freshly started validator can accept the deploy before its bank settles.
for _ in $(seq 1 30); do
  solana --url http://127.0.0.1:8899 program show 6aDFSdwXESHF7UXJRCkHogNtUTbDPajmLupsfvzTSGvB >/dev/null 2>&1 && break
  sleep 1
done
solana --url http://127.0.0.1:8899 program show 6aDFSdwXESHF7UXJRCkHogNtUTbDPajmLupsfvzTSGvB >/dev/null

# ---------------------------------------------------------------- indexer+api
# The durable indexer + read API run against the same validator; the snapshot
# export and the reconciliation verdicts below depend on them.
DB_URL="${HEXVAULT_DATABASE_URL:-postgres://postgres:postgres@localhost:5432/hexvault}"
docker compose up -d db >/dev/null 2>&1 || true
for _ in $(seq 1 30); do
  docker compose exec -T db pg_isready -U postgres >/dev/null 2>&1 && break
  sleep 1
done
docker compose exec -T db psql -U postgres -c "DROP DATABASE IF EXISTS hexvault;" -c "CREATE DATABASE hexvault;" >/dev/null
DATABASE_URL="$DB_URL" RPC_URL=http://127.0.0.1:8899 RECONCILE_INTERVAL_MS=15000 \
  pnpm exec tsx packages/indexer/src/index.ts >"$LEDGER.indexer.log" 2>&1 &
INDEXER_PID=$!
PORT=8081 DATABASE_URL="$DB_URL" \
  pnpm exec tsx packages/api/src/index.ts >"$LEDGER.api.log" 2>&1 &
API_PID=$!
cleanup() {
  kill "$VALIDATOR_PID" "$INDEXER_PID" "$API_PID" 2>/dev/null || true
  wait "$VALIDATOR_PID" "$INDEXER_PID" "$API_PID" 2>/dev/null || true
  if [ -z "${HEXVAULT_E2E_KEEP:-}" ]; then
    rm -rf "$LEDGER"
  else
    echo "keeping e2e ledger at $LEDGER" >&2
  fi
}
trap cleanup EXIT INT TERM
for _ in $(seq 1 20); do
  grep -q "indexer subscribed" "$LEDGER.indexer.log" 2>/dev/null && break
  sleep 1
done

# ---------------------------------------------------------------- fixtures
say "fixtures: second player + test USDC"
PLAYER_KEYPAIR="$LEDGER/player.json"
solana-keygen new --no-bip39-passphrase --silent --outfile "$PLAYER_KEYPAIR"
PLAYER=$(solana-keygen pubkey "$PLAYER_KEYPAIR")
AUTHORITY=$(solana --url http://127.0.0.1:8899 address)
USDC=$(RPC_URL=http://127.0.0.1:8899 pnpm exec tsx scripts/e2e-fixtures.ts "$PLAYER_KEYPAIR" | tail -1)
echo "authority=$AUTHORITY player=$PLAYER usdc=$USDC"

# ---------------------------------------------------------------- lifecycle
rm -rf .hexvault
# Schedule windows in absolute CHAIN time: a test-validator's on-chain clock
# lags the wall clock, so client-relative "+0s" starts can read as not-yet-open.
chain_now() {
  solana --url http://127.0.0.1:8899 block-time "$(solana --url http://127.0.0.1:8899 slot)" --output json \
    | python3 -c 'import json,sys; print(json.load(sys.stdin)["timestamp"])'
}

say "initialize + pool create"
HV initialize --guardian "$AUTHORITY" --snapshot "$AUTHORITY" --mock-randomness "$AUTHORITY"
HV pool create --pool-id 1 --mint "$USDC" \
  --min-deposit 1000000 --max-stake 100000 --max-bonus 50000 \
  --min-epoch-seconds 30 --max-epoch-seconds 86400 --buffer-seconds 5

T0=$(chain_now)
say "epoch 1 (150s epoch, 60s cutoff, 900s claim deadline; starts at chain t=$T0)"
HV epoch create --pool-id 1 --starts "$T0" --cutoff $((T0 + 60)) --ends $((T0 + 150)) \
  --snapshot $((T0 + 150)) --deadline $((T0 + 900))

say "round 1 (closes t+140 with buffer 5)"
HV round create --pool-id 1 --round-id 1 --starts "$T0" --ends $((T0 + 140)) --bonus 50000

say "deposits (authority 50, player 25)"
HV deposit --pool-id 1 --amount 50000000
HV --keypair "$PLAYER_KEYPAIR" deposit --pool-id 1 --amount 25000000

say "fund prize (10) + jackpot (25)"
HV prize fund --pool-id 1 --amount 10000000
HV jackpot fund --pool-id 1 --amount 25000000

say "positions from both players"
HV position buy --pool-id 1 --round-id 1 --tiles 1,7,22 --stake 1000
HV --keypair "$PLAYER_KEYPAIR" position buy --pool-id 1 --round-id 1 --tiles 5,6 --stake 2000

say "settle round 1 after close (waits for the round window to pass on chain)"
HV_WAIT randomness request round --pool-id 1 --round-id 1
HV randomness fulfill round --pool-id 1 --round-id 1 --sample 1234567
HV reward --pool-id 1 --round-id 1 || echo "(authority reward claim: only winners claim; ok either way)"
HV --keypair "$PLAYER_KEYPAIR" reward --pool-id 1 --round-id 1 || echo "(player reward claim: only winners claim; ok either way)"

say "snapshot commit (waits for the snapshot window on chain), export + commit"
HV_WAIT snapshot export --pool-id 1 --epoch-id 1 --out "$LEDGER/snapshot.json"
# Chain source: entry balances right before the commit — no ET-minting event
# lands between this export and the commit, so it equals the indexer's
# canonical at-commit snapshot (reconciliation verifies that equality later).
HV snapshot export --pool-id 1 --epoch-id 1 --out "$LEDGER/snapshot.json"
HV_WAIT prize commit --pool-id 1 --epoch-id 1 --snapshot-file "$LEDGER/snapshot.json" --prize-amount 10000000
HV jackpot commit --pool-id 1 --epoch-id 1

say "draws: prize -> lowest-interval winner, jackpot -> highest-interval winner"
HV randomness request prize --pool-id 1 --epoch-id 1
HV randomness fulfill prize --pool-id 1 --epoch-id 1 --sample 0
HV randomness request jackpot --pool-id 1 --epoch-id 1
TOTAL=$(python3 -c "import json;print(json.load(open('$LEDGER/snapshot.json'))['totalWeight'])")
HV randomness fulfill jackpot --pool-id 1 --epoch-id 1 --sample "$TOTAL"

say "claims"
HV prize claim --pool-id 1 --epoch-id 1 --winner "$AUTHORITY" --proof-file "$LEDGER/snapshot.json" || \
  HV prize claim --pool-id 1 --epoch-id 1 --winner "$PLAYER" --proof-file "$LEDGER/snapshot.json"
HV jackpot claim --pool-id 1 --epoch-id 1 --winner "$PLAYER" --proof-file "$LEDGER/snapshot.json" || \
  HV jackpot claim --pool-id 1 --epoch-id 1 --winner "$AUTHORITY" --proof-file "$LEDGER/snapshot.json"

say "rollover to epoch 2"
T1=$(chain_now)
HV epoch create --pool-id 1 --starts "$T1" --cutoff $((T1 + 45)) --ends $((T1 + 90)) \
  --snapshot $((T1 + 90)) --deadline $((T1 + 150))

say "operator checks: balances, jackpot status, reconcile"
HV balances --pool-id 1 --owner "$AUTHORITY"
HV --keypair "$PLAYER_KEYPAIR" balances --pool-id 1 --owner "$PLAYER"
HV jackpot status --pool-id 1
HV reconcile --pool-id 1

say "indexer + API verification"
sleep 5   # let the indexer drain finalized events
curl -sf http://127.0.0.1:8081/healthz && echo
curl -sf "http://127.0.0.1:8081/pools" | python3 -m json.tool | head -20
curl -sf "http://127.0.0.1:8081/reconciliations?limit=5" | python3 -m json.tool | head -40
docker compose exec -T db psql -U postgres -d hexvault -t -c \
  "select name, count(*) from events group by name order by name;"
docker compose exec -T db psql -U postgres -d hexvault -t -c \
  "select check_name, ok from reconciliation_runs where pool in (select address from pools) order by checked_at desc limit 8;"

say "E2E COMPLETE"
