#!/bin/sh
set -eu

# Program integration tests against an isolated solana-test-validator with the
# freshly built program deployed as upgradeable.
#
# Set HEXVAULT_RPC_PORT to run several validators side by side (parallel
# agents, or a second suite while one is already running). Every port the
# validator binds is derived from it, so two runs never collide.
#
# Usage:  tests/run-local.sh [vitest args...]
#         HEXVAULT_RPC_PORT=8999 tests/run-local.sh tests/02-rounds.test.ts

port="${HEXVAULT_RPC_PORT:-8899}"
ledger="${TMPDIR:-/tmp}/hexvault-validator-$port-$$"
rpc="http://127.0.0.1:$port"
export ANCHOR_PROVIDER_URL="$rpc"
export ANCHOR_WALLET="${ANCHOR_WALLET:-$HOME/.config/solana/id.json}"

cleanup() {
  kill "$validator_pid" 2>/dev/null || true
  wait "$validator_pid" 2>/dev/null || true
  rm -r "$ledger" 2>/dev/null || true
}

# `test-vrf` compiles in `test_fulfill`, which fabricates a fulfilled ORAO
# randomness account. The round and epoch suites cannot settle without it, and
# the devnet build is a separate explicit `anchor build` with no feature flag.
anchor build -- --features test-vrf

solana-test-validator \
  --ledger "$ledger" --reset --quiet \
  --rpc-port "$port" \
  --faucet-port $((port + 2)) \
  --gossip-port $((port + 3)) \
  --dynamic-port-range $((port + 4))-$((port + 44)) \
  >"$ledger.log" 2>&1 &
validator_pid=$!
trap cleanup EXIT INT TERM

for _ in $(seq 1 60); do
  if solana --url "$rpc" cluster-version >/dev/null 2>&1; then
    break
  fi
  sleep 1
done

program_id=$(node -e "process.stdout.write(require('./target/idl/hex_vault.json').address)")
solana --url "$rpc" program deploy \
  target/deploy/hex_vault.so \
  --program-id target/deploy/hex_vault-keypair.json \
  --upgrade-authority "$ANCHOR_WALLET" \
  --use-rpc >/dev/null
echo "deployed $program_id at $rpc"

pnpm exec vitest run "${@:-tests}"
