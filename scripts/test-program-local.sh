#!/bin/sh
set -eu

# Program integration tests run against an isolated solana-test-validator with
# the freshly built program deployed as upgradeable (the initialize guard
# requires the provider wallet to be the upgrade authority).
#
# This deliberately does not go through `anchor test`: its [scripts] test hook
# runs `pnpm run test:unit` first, and the indexer package's tests need a live
# Postgres. The program suite only needs a validator.

ledger="${TMPDIR:-/tmp}/hexvault-validator-$$"
rpc="http://127.0.0.1:8899"
export ANCHOR_PROVIDER_URL="$rpc"
export ANCHOR_WALLET="${ANCHOR_WALLET:-$HOME/.config/solana/id.json}"

cleanup() {
  kill "$validator_pid" 2>/dev/null || true
  wait "$validator_pid" 2>/dev/null || true
  rm -rf "$ledger"
}

solana-test-validator --ledger "$ledger" --reset --quiet >"$ledger.log" 2>&1 &
validator_pid=$!
trap cleanup EXIT INT TERM

for attempt in $(seq 1 60); do
  if solana --url "$rpc" cluster-version >/dev/null 2>&1; then
    break
  fi
  sleep 1
done

program_id=$(node -e "process.stdout.write(require('./target/idl/hex_vault.json').address)")
anchor build
solana --url "$rpc" program deploy \
  target/deploy/hex_vault.so \
  --program-id target/deploy/hex_vault-keypair.json \
  --upgrade-authority "$ANCHOR_WALLET" >/dev/null
echo "deployed $program_id"

pnpm exec vitest run tests
