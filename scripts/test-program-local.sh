#!/bin/sh
set -eu

ledger="${TMPDIR:-/tmp}/hexvault-validator-$$"
cleanup() {
  kill "$validator_pid" 2>/dev/null || true
  wait "$validator_pid" 2>/dev/null || true
  rm -rf "$ledger"
}

solana-test-validator --ledger "$ledger" --reset --quiet >"$ledger.log" 2>&1 &
validator_pid=$!
trap cleanup EXIT INT TERM

for attempt in $(seq 1 30); do
  if solana --url http://127.0.0.1:8899 cluster-version >/dev/null 2>&1; then
    anchor test --skip-local-validator
    exit $?
  fi
  sleep 1
done

cat "$ledger.log" >&2
exit 1
