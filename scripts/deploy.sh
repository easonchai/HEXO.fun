#!/usr/bin/env bash
# Builds, checks and deploys or upgrades the hex_vault program for one
# environment. See docs/plan/ops-and-envs/spec.md ("Deploy tooling") and
# issue 12. Run from the repo root, same as scripts/check-deployable.sh and
# tests/run-local.sh:
#
#   scripts/deploy.sh <dev|staging|mainnet> [--upgrade] [--dry-run]
#
# --dry-run builds, runs check-deployable.sh, asserts the keypair against the
# built declare_id!, and (with --upgrade) reads the current ProgramData size,
# but never calls solana program write-buffer/extend/deploy and never runs
# sync-idl. It touches no network write and nothing outside target/, so it is
# safe to run against real keys and a real cluster.
#
# Mainnet's upgrade authority is a Ledger (usb://ledger); plug it in before
# running this for mainnet. The fee payer defaults to the locally configured
# keypair (`solana config get`), which keeps day-to-day upgrades from
# needing the Ledger for every prompt; set FEE_PAYER_KEYPAIR (a path or
# another usb://ledger[?key=N]) to pay fees from somewhere else.
#
# Verifiable mainnet build (documented here, not scripted: OtterSec's remote
# job needs a public repo at the deployed commit, which is the user's call).
# After a real mainnet deploy, from a machine with `solana-verify` installed
# (cargo install solana-verify) and the repo pushed at the deployed commit:
#
#   solana-verify verify-from-repo \
#     --url <mainnet RPC> --program-id <mainnet program id> \
#     <repo-url> --commit-hash <deployed sha> -- --features mainnet
#
#   solana-verify remote submit-job \
#     --program-id <mainnet program id> \
#     --uploader <your key> \
#     -- --features mainnet
#
# If the repo stays private, run `solana-verify build -- --features mainnet`
# (this script already does) plus `solana-verify get-executable-hash` locally
# and publish the hash instead of the OtterSec job.
set -euo pipefail

usage() {
  echo "usage: $0 <dev|staging|mainnet> [--upgrade] [--dry-run]" >&2
  exit 1
}

[ "$#" -ge 1 ] || usage
env_name="$1"
shift

upgrade=0
dry_run=0
while [ "$#" -gt 0 ]; do
  case "$1" in
    --upgrade) upgrade=1 ;;
    --dry-run) dry_run=1 ;;
    *) usage ;;
  esac
  shift
done

case "$env_name" in
  dev | staging | mainnet) ;;
  *) usage ;;
esac

# --- 1. env -> feature, keypair, cluster --------------------------------
feature=""
keypair="keys/hex_vault-$env_name-keypair.json"
cluster="devnet"

if [ "$env_name" = "staging" ]; then
  feature="staging"
elif [ "$env_name" = "mainnet" ]; then
  feature="mainnet"
  mainnet_env=".env.mainnet"
  if [ ! -f "$mainnet_env" ]; then
    echo "deploy: $mainnet_env is missing; copy .env.mainnet.example and fill in RPC_URL" >&2
    exit 1
  fi
  cluster=$(grep -E '^RPC_URL=' "$mainnet_env" | tail -1 | cut -d= -f2-)
  if [ -z "$cluster" ]; then
    echo "deploy: RPC_URL is empty in $mainnet_env" >&2
    exit 1
  fi
fi

if [ ! -f "$keypair" ]; then
  echo "deploy: $keypair is missing" >&2
  exit 1
fi

# --- 2. build -------------------------------------------------------------
echo "==> building $env_name"
if [ "$env_name" = "mainnet" ]; then
  if ! command -v solana-verify >/dev/null 2>&1; then
    echo "deploy: solana-verify is required for a mainnet build (cargo install solana-verify)" >&2
    exit 1
  fi
  solana-verify build -- --features mainnet
elif [ -n "$feature" ]; then
  anchor build -- --features "$feature"
else
  anchor build
fi

so_path="target/deploy/hex_vault.so"
idl_path="target/idl/hex_vault.json"

# --- 3. refuse a test-vrf artifact -----------------------------------------
sh scripts/check-deployable.sh "$so_path"

# --- 4. keypair must match this build's declare_id! ------------------------
idl_address=$(grep -m1 '"address"' "$idl_path" | sed -E 's/.*"address": *"([^"]+)".*/\1/')
keypair_pubkey=$(solana-keygen pubkey "$keypair")
if [ "$idl_address" != "$keypair_pubkey" ]; then
  echo "deploy: $keypair ($keypair_pubkey) does not match this build's declare_id! ($idl_address)" >&2
  exit 1
fi
echo "==> $env_name program id $keypair_pubkey matches the build"

# --- 5. on upgrade, check ProgramData has room for the new build -----------
if [ "$upgrade" -eq 1 ]; then
  echo "==> checking ProgramData size for $keypair_pubkey on $cluster"
  current_len=""
  if show_json=$(solana program show "$keypair_pubkey" --url "$cluster" --output json 2>/dev/null); then
    current_len=$(printf '%s' "$show_json" | grep -m1 '"dataLen"' | sed -E 's/[^0-9]*([0-9]+).*/\1/')
  fi
  so_size=$(wc -c <"$so_path" | tr -d ' ')
  # UpgradeableLoaderState::ProgramData header: 4-byte enum tag + 8-byte slot
  # + 1-byte Option tag + 32-byte upgrade authority pubkey = 45 bytes.
  required_len=$((so_size + 45))
  if [ -z "$current_len" ]; then
    echo "deploy: could not read ProgramData size for $keypair_pubkey on $cluster (not deployed yet?)" >&2
  elif [ "$required_len" -gt "$current_len" ]; then
    extend_by=$((required_len - current_len))
    echo "ProgramData is $current_len bytes; the new build needs $required_len bytes."
    echo "  solana program extend $keypair_pubkey $extend_by --url $cluster"
    if [ "$dry_run" -eq 1 ]; then
      echo "[dry-run] not prompting; not running the extend"
    else
      printf 'Run this extend now? [y/N] '
      read -r reply
      case "$reply" in
        y | Y) solana program extend "$keypair_pubkey" "$extend_by" --url "$cluster" ;;
        *) echo "deploy: skipped the extend; deploy still auto-extends if it is short" ;;
      esac
    fi
  else
    echo "ProgramData is $current_len bytes; the new build needs $required_len bytes. No extend needed."
  fi
fi

# --- 6. write-buffer, then deploy (deploy also covers upgrades) -----------
if [ "$dry_run" -eq 1 ]; then
  echo "[dry-run] would run:"
  if [ "$env_name" = "mainnet" ]; then
    echo "  solana program write-buffer $so_path --url $cluster --buffer-authority usb://ledger"
    echo "  solana program deploy --buffer <buffer> --program-id $keypair --url $cluster --upgrade-authority usb://ledger${FEE_PAYER_KEYPAIR:+ --fee-payer $FEE_PAYER_KEYPAIR}"
  else
    echo "  solana program write-buffer $so_path --url $cluster"
    echo "  solana program deploy --buffer <buffer> --program-id $keypair --url $cluster"
  fi
  echo "[dry-run] would then run: pnpm --filter @hexvault/web sync-idl && pnpm --filter @hexvault/backend sync-idl"
  exit 0
fi

if [ "$env_name" = "mainnet" ]; then
  printf 'Type the mainnet program id to confirm (%s): ' "$keypair_pubkey"
  read -r confirm
  if [ "$confirm" != "$keypair_pubkey" ]; then
    echo "deploy: confirmation did not match; aborting" >&2
    exit 1
  fi
  set -- --buffer-authority usb://ledger
else
  set --
fi

echo "==> writing buffer"
buffer_output=$(solana program write-buffer "$so_path" --url "$cluster" "$@")
echo "$buffer_output"
buffer_pubkey=$(printf '%s\n' "$buffer_output" | sed -n 's/^Buffer: //p' | head -1)
if [ -z "$buffer_pubkey" ]; then
  echo "deploy: could not parse the buffer pubkey from write-buffer output" >&2
  exit 1
fi

if [ "$env_name" = "mainnet" ]; then
  set -- --upgrade-authority usb://ledger
  if [ -n "${FEE_PAYER_KEYPAIR:-}" ]; then
    set -- "$@" --fee-payer "$FEE_PAYER_KEYPAIR"
  fi
else
  set --
fi

echo "==> deploying (buffer $buffer_pubkey)"
solana program deploy --buffer "$buffer_pubkey" --program-id "$keypair" --url "$cluster" "$@"

# --- 7. report, then sync both apps' IDL copies ----------------------------
solana program show "$keypair_pubkey" --url "$cluster"

echo "==> syncing IDL"
pnpm --filter @hexvault/web sync-idl
pnpm --filter @hexvault/backend sync-idl
