#!/bin/sh
# HexVault WEB end-to-end: boots the full local stack (validator + program +
# Postgres indexer + API + operator bot + Vite dev server with the dev burner
# wallet), then a Playwright pass drives the real UI. The browser automation
# itself lives in scripts/e2e-web.mjs (Playwright API) so this script stays
# a single self-contained entry point:
#
#   sh scripts/e2e-web.sh           # stack + headless browser flow + checks
#   HEXVAULT_E2E_WEB_ONLY=1 sh ...  # stack only (drive the UI yourself)
set -eu

cd "$(dirname "$0")/.."
ROOT="$PWD"
export PATH="$HOME/.cargo/bin:$PATH"

say() { printf '\n=== %s ===\n' "$1"; }

HV() {
  attempt=1
  while :; do
    status=0
    out=$(pnpm exec tsx packages/cli/src/index.ts "$@" 2>&1) || status=$?
    if [ $status -eq 0 ]; then printf '%s\n' "$out" | /usr/bin/grep -v punycode | /usr/bin/grep -v 'bigint:' | /usr/bin/grep -v DeprecationWarning || true; return 0; fi
    if printf '%s\n' "$out" | /usr/bin/grep -Eq "Attempt to load a program that does not exist|Program is not deployed" && [ "$attempt" -lt 8 ]; then
      attempt=$((attempt + 1)); sleep 3; continue
    fi
    printf '%s\n' "$out" | /usr/bin/grep -v punycode | /usr/bin/grep -v 'bigint:' | /usr/bin/grep -v DeprecationWarning || true
    return $status
  done
}

chain_now() {
  solana --url http://127.0.0.1:8899 block-time "$(solana --url http://127.0.0.1:8899 slot)" --output json \
    | python3 -c 'import json,sys; print(json.load(sys.stdin)["timestamp"])'
}

# ---------------------------------------------------------------- validator
LEDGER="${TMPDIR:-/tmp}/hx-web-ledger-$$"
LOG="$LEDGER.log"
VALIDATOR_PID=""; INDEXER_PID=""; API_PID=""; OPERATOR_PID=""; VITE_PID=""
solana-test-validator --ledger "$LEDGER" --reset --quiet >"$LOG" 2>&1 &
VALIDATOR_PID=$!
cleanup() {
  for pid in $VALIDATOR_PID $INDEXER_PID $API_PID $OPERATOR_PID $VITE_PID; do
    kill "$pid" 2>/dev/null || true
  done
  for pid in $VALIDATOR_PID $INDEXER_PID $API_PID $OPERATOR_PID $VITE_PID; do
    wait "$pid" 2>/dev/null || true
  done
  if [ -z "${HEXVAULT_E2E_KEEP:-}" ]; then rm -rf "$LEDGER"; else echo "keeping ledger at $LEDGER" >&2; fi
}
trap cleanup EXIT INT TERM

for _ in $(seq 1 30); do
  solana --url http://127.0.0.1:8899 cluster-version >/dev/null 2>&1 && break
  sleep 1
done
solana --url http://127.0.0.1:8899 cluster-version >/dev/null

say "deploy program"
solana program deploy target/deploy/hex_vault.so \
  --url http://127.0.0.1:8899 \
  --upgrade-authority ~/.config/solana/id.json >/dev/null
for _ in $(seq 1 30); do
  solana --url http://127.0.0.1:8899 program show 6aDFSdwXESHF7UXJRCkHogNtUTbDPajmLupsfvzTSGvB >/dev/null 2>&1 && break
  sleep 1
done

# ---------------------------------------------------------------- indexer+api
DB_URL="${HEXVAULT_DATABASE_URL:-postgres://postgres:postgres@localhost:5432/hexvault}"
docker compose up -d db >/dev/null 2>&1 || true
for _ in $(seq 1 30); do
  docker compose exec -T db pg_isready -U postgres >/dev/null 2>&1 && break
  sleep 1
done
docker compose exec -T db psql -U postgres -c "DROP DATABASE IF EXISTS hexvault;" -c "CREATE DATABASE hexvault;" >/dev/null
DATABASE_URL="$DB_URL" RPC_URL=http://127.0.0.1:8899 RECONCILE_INTERVAL_MS=60000 \
  pnpm exec tsx packages/indexer/src/index.ts >"$LEDGER.indexer.log" 2>&1 &
INDEXER_PID=$!
PORT=8081 DATABASE_URL="$DB_URL" \
  pnpm exec tsx packages/api/src/index.ts >"$LEDGER.api.log" 2>&1 &
API_PID=$!
for _ in $(seq 1 20); do
  /usr/bin/grep -q "indexer subscribed" "$LEDGER.indexer.log" 2>/dev/null && break
  sleep 1
done

# ---------------------------------------------------------------- fixtures
say "fixtures + protocol init"
AUTHORITY=$(solana --url http://127.0.0.1:8899 address)
PLAYER_KEYPAIR="$LEDGER/player.json"
solana-keygen new --no-bip39-passphrase --silent --outfile "$PLAYER_KEYPAIR"
USDC=$(RPC_URL=http://127.0.0.1:8899 pnpm exec tsx scripts/e2e-fixtures.ts "$PLAYER_KEYPAIR" | tail -1)
echo "authority=$AUTHORITY usdc=$USDC"

rm -rf .hexvault
HV initialize --guardian "$AUTHORITY" --snapshot "$AUTHORITY" --mock-randomness "$AUTHORITY"
HV pool create --pool-id 1 --mint "$USDC" \
  --min-deposit 1000000 --max-stake 100000 --max-bonus 50000 \
  --min-epoch-seconds 30 --max-epoch-seconds 86400 --buffer-seconds 5

T0=$(chain_now)
# Long-lived epoch (24h) so browser sessions and the operator loop have room;
# rounds are what cycle quickly (OPERATOR_ROUND_SECONDS), not the epoch.
HV epoch create --pool-id 1 --starts "$T0" --cutoff $((T0 + 28800)) --ends $((T0 + 86400)) \
  --snapshot $((T0 + 86400)) --deadline $((T0 + 90000))
HV prize fund --pool-id 1 --amount 20000000
HV jackpot fund --pool-id 1 --amount 35000000
HV deposit --pool-id 1 --amount 50000000

# ---------------------------------------------------------------- operator bot
say "operator bot + web app"
POOL_ID=1 RPC_URL=http://127.0.0.1:8899 OPERATOR_ROUND_SECONDS=150 \
  pnpm exec tsx scripts/web-operator.ts >"$LEDGER.operator.log" 2>&1 &
OPERATOR_PID=$!
sleep 4

VITE_PID=""
WEB_ONLY="${HEXVAULT_E2E_WEB_ONLY:-}"
WEB_PORT="${HEXVAULT_WEB_PORT:-5199}"
if [ -z "$WEB_ONLY" ]; then
  # ---------------------------------------------------------------- browser flow
  say "browser flow (Playwright)"
  VITE_BURNER_WALLET=1 VITE_CLUSTER=localnet VITE_PRIVY_APP_ID= \
    pnpm --filter @hexvault/web exec vite --port "$WEB_PORT" --strictPort >"$LEDGER.vite.log" 2>&1 &
  VITE_PID=$!
  for _ in $(seq 1 30); do
    curl -sf "http://localhost:$WEB_PORT/" >/dev/null 2>&1 && break
    sleep 1
  done
  curl -sf "http://localhost:$WEB_PORT/" >/dev/null

  HEXVAULT_WEB_URL="http://localhost:$WEB_PORT" RPC_URL=http://127.0.0.1:8899 \
    HEXVAULT_E2E_USDC="$USDC" \
    pnpm exec tsx scripts/e2e-web.mjs
  say "browser flow passed"
else
  # Manual mode: start the web server ourselves (Privy cleared so the funded
  # dev burner is the one-click connection) and pre-fund it for play.
  say "web app"
  VITE_BURNER_WALLET=1 VITE_CLUSTER=localnet VITE_PRIVY_APP_ID= \
    pnpm --filter @hexvault/web exec vite --port "$WEB_PORT" --strictPort >"$LEDGER.vite.log" 2>&1 &
  VITE_PID=$!
  for _ in $(seq 1 30); do
    curl -sf "http://localhost:$WEB_PORT/" >/dev/null 2>&1 && break
    sleep 1
  done
  curl -sf "http://localhost:$WEB_PORT/" >/dev/null
  BURNER=$(pnpm --dir apps/web exec tsx -e \
    'import {burnerKeypair} from "./src/dev-burner.ts"; console.log(burnerKeypair().publicKey.toBase58())' \
    | /usr/bin/grep -v punycode | /usr/bin/grep -v bigint | tail -1)
  RPC_URL=http://127.0.0.1:8899 pnpm exec tsx scripts/fund-wallet.ts "$BURNER" "$USDC" \
    | /usr/bin/grep -v punycode | /usr/bin/grep -v bigint || true
  echo "HEXVAULT_E2E_WEB_ONLY=1 — stack is up:" >&2
  echo "  web:     http://localhost:$WEB_PORT   (burner $BURNER pre-funded)" >&2
  echo "  api:     http://127.0.0.1:8081" >&2
  echo "  rpc:     http://127.0.0.1:8899" >&2
  echo "  press Ctrl-C to tear down" >&2
  wait
fi

say "E2E-WEB COMPLETE"
