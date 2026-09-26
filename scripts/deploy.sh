#!/usr/bin/env bash
# Builds, checks and deploys or upgrades the hex_vault program for one
# environment. See docs/plan/ops-and-envs/spec.md ("Deploy tooling") and
# docs/plan/production-hardening/spec.md ("Deploy tooling"), issues 12 and
# 11. Run from the repo root, same as scripts/check-deployable.sh and
# tests/run-local.sh:
#
#   scripts/deploy.sh <dev|devnew|staging|mainnet> [--upgrade] [--dry-run]
#   scripts/deploy.sh <dev|devnew|staging|mainnet> --idl [--dry-run]
#   scripts/deploy.sh <dev|devnew|staging|mainnet> verify
#
# --dry-run builds, runs check-deployable.sh, asserts the keypair against the
# built declare_id!, and (with --upgrade) reads the current ProgramData size,
# but never calls solana program write-buffer/set-buffer-authority/extend/
# deploy and never runs sync-idl. It touches no network write and nothing
# outside target/, so it is safe to run against real keys and a real cluster.
#
# write-buffer and deploy always carry a priority fee
# (--with-compute-unit-price, env DEPLOY_CU_PRICE, default 100000) and
# --max-sign-attempts 50, and mainnet also adds --use-rpc (only mainnet's RPC
# is staked). After a deploy or upgrade the script fails if any buffer is
# left under the deploy authority, or if the on-chain upgrade authority is
# not the one expected for the env.
#
# --idl runs `anchor idl init` the first time and `anchor idl upgrade` after,
# from the freshly built target/idl/hex_vault.json, signing with the same
# authority as a deploy. `verify` runs `solana-verify verify-from-repo` then
# `solana-verify remote submit-job` against the current commit and refuses on
# a dirty working tree (VERIFY_REPO_URL overrides the repo URL; VERIFY_UPLOADER
# is the base58 pubkey submit-job records as the uploader). Both are opt-in so
# a plain deploy stays fast.
#
# Mainnet's upgrade authority is a Ledger (usb://ledger); plug it in before
# running this for mainnet. The buffer is written by the locally configured
# hot keypair (`solana config get`), because the loader's Write instruction
# needs the buffer authority to sign every chunk and a Ledger would prompt
# for each one; the script then hands the buffer to the Ledger with one
# `set-buffer-authority` signature from the hot key, and only the final
# `deploy` is signed on the device. The fee payer for write-buffer and deploy
# also defaults to the locally configured keypair; set FEE_PAYER_KEYPAIR (a
# keypair file path) to pay those two from somewhere else. A usb://ledger
# fee payer would put the device back on every write chunk, so keep it a
# file. set-buffer-authority is always paid by the locally configured key.
#
# A keyed RPC URL (.env.mainnet's RPC_URL, or DEPLOY_RPC_URL on devnet) is
# never echoed: every printed command shows --url "$RPC_URL" or
# --url "$DEPLOY_RPC_URL" instead, so export that variable before pasting one.
#
# If the repo stays private (so `verify` cannot run), run `solana-verify
# build -- --features mainnet` (this script already does) plus `solana-verify
# get-executable-hash` locally and publish the hash instead of the OtterSec
# job.
set -euo pipefail

usage() {
  echo "usage: $0 <dev|devnew|staging|mainnet> [--upgrade] [--dry-run] [--idl]" >&2
  echo "       $0 <dev|devnew|staging|mainnet> verify" >&2
  exit 1
}

[ "$#" -ge 1 ] || usage
env_name="$1"
shift

upgrade=0
dry_run=0
action="deploy"
while [ "$#" -gt 0 ]; do
  case "$1" in
    --upgrade) upgrade=1 ;;
    --dry-run) dry_run=1 ;;
    --idl) action="idl" ;;
    verify) action="verify" ;;
    *) usage ;;
  esac
  shift
done

case "$env_name" in
  dev | devnew | staging | mainnet) ;;
  *) usage ;;
esac

# --- 1. env -> feature, keypair, cluster --------------------------------
feature=""
keypair="keys/hex_vault-$env_name-keypair.json"
# The public devnet endpoint drops buffer writes under load ("Blockhash
# expired", "N write transactions failed"); DEPLOY_RPC_URL points devnet
# deploys at a keyed RPC instead. Mainnet reads RPC_URL from .env.mainnet.
cluster="${DEPLOY_RPC_URL:-devnet}"
# What the script prints in place of $cluster. A keyed RPC URL carries its
# api key (in the query string, or in the path for some providers), so no
# echoed line ever shows the URL itself: it shows the variable to export.
cluster_shown="$cluster"
if [ -n "${DEPLOY_RPC_URL:-}" ]; then
  cluster_shown='"$DEPLOY_RPC_URL"'
fi

if [ "$env_name" = "staging" ] || [ "$env_name" = "devnew" ]; then
  feature="$env_name"
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
  cluster_shown='"$RPC_URL"'
fi

if [ ! -f "$keypair" ]; then
  echo "deploy: $keypair is missing" >&2
  exit 1
fi
keypair_pubkey=$(solana-keygen pubkey "$keypair")

# --- verify: solana-verify against the current commit, no local build ------
if [ "$action" = "verify" ]; then
  if ! command -v solana-verify >/dev/null 2>&1; then
    echo "deploy: solana-verify is required for verify (cargo install solana-verify)" >&2
    exit 1
  fi
  if [ -n "$(git status --porcelain)" ]; then
    echo "deploy: working tree is dirty; commit or stash before verify" >&2
    exit 1
  fi
  commit_sha=$(git rev-parse HEAD)
  repo_url="${VERIFY_REPO_URL:-$(git config --get remote.origin.url)}"
  case "$repo_url" in
    git@*) repo_url=$(printf '%s' "$repo_url" | sed -E 's#^git@([^:]+):(.+)\.git$#https://\1/\2#') ;;
  esac
  echo "==> verifying $keypair_pubkey against $repo_url @ $commit_sha"
  # The trailing cargo args only belong to verify-from-repo, which rebuilds;
  # submit-job records the job and takes no build flags.
  if [ -n "$feature" ]; then
    set -- -- --features "$feature"
  else
    set --
  fi
  solana-verify verify-from-repo --url "$cluster" --program-id "$keypair_pubkey" \
    "$repo_url" --commit-hash "$commit_sha" "$@"
  if [ -n "${VERIFY_UPLOADER:-}" ]; then
    solana-verify remote submit-job --program-id "$keypair_pubkey" --uploader "$VERIFY_UPLOADER"
  else
    solana-verify remote submit-job --program-id "$keypair_pubkey"
  fi
  exit 0
fi

# --- 2. build -------------------------------------------------------------
echo "==> building $env_name"
so_path="target/deploy/hex_vault.so"
idl_path="target/idl/hex_vault.json"
if [ "$env_name" = "mainnet" ]; then
  if ! command -v solana-verify >/dev/null 2>&1; then
    echo "deploy: solana-verify is required for a mainnet build (cargo install solana-verify)" >&2
    exit 1
  fi
  solana-verify build -- --features mainnet
  # solana-verify only produces the .so; the IDL under target/idl would be
  # whatever the last `anchor build` left there, with that build's
  # declare_id!. Regenerate it for this feature so step 4, --idl and the
  # post-deploy sync-idl all read the mainnet IDL. Anchor 1.x: cargo args
  # go after `--`, -o names the output file.
  mkdir -p "$(dirname "$idl_path")"
  anchor idl build -o "$idl_path" -- --features mainnet
elif [ -n "$feature" ]; then
  anchor build -- --features "$feature"
else
  anchor build
fi

# --- 3. refuse a test-vrf artifact -----------------------------------------
sh scripts/check-deployable.sh "$so_path"

# --- 4. keypair must match this build's declare_id! ------------------------
idl_address=$(grep -m1 '"address"' "$idl_path" | sed -E 's/.*"address": *"([^"]+)".*/\1/')
if [ "$idl_address" != "$keypair_pubkey" ]; then
  echo "deploy: $keypair ($keypair_pubkey) does not match this build's declare_id! ($idl_address)" >&2
  exit 1
fi
echo "==> $env_name program id $keypair_pubkey matches the build"

# --- --idl: publish the freshly built IDL on chain, no deploy --------------
if [ "$action" = "idl" ]; then
  idl_wallet=""
  if [ "$env_name" = "mainnet" ]; then
    idl_wallet="usb://ledger"
  fi

  idl_tmp=$(mktemp)
  idl_exists=0
  if anchor idl fetch "$keypair_pubkey" --provider.cluster "$cluster" -o "$idl_tmp" >/dev/null 2>&1; then
    idl_exists=1
  fi
  rm -f "$idl_tmp"

  if [ "$idl_exists" -eq 1 ]; then
    idl_verb="upgrade"
  else
    idl_verb="init"
  fi

  if [ "$dry_run" -eq 1 ]; then
    echo "[dry-run] would run: anchor idl $idl_verb -f $idl_path --provider.cluster $cluster_shown${idl_wallet:+ --provider.wallet $idl_wallet} $keypair_pubkey"
    exit 0
  fi

  if [ -n "$idl_wallet" ]; then
    set -- --provider.wallet "$idl_wallet"
  else
    set --
  fi
  echo "==> anchor idl $idl_verb for $keypair_pubkey"
  anchor idl "$idl_verb" -f "$idl_path" --provider.cluster "$cluster" "$@" "$keypair_pubkey"
  echo "==> syncing IDL"
  pnpm --filter @hexvault/web sync-idl
  pnpm --filter @hexvault/backend sync-idl
  exit 0
fi

# --- 5. on upgrade, check ProgramData has room for the new build -----------
if [ "$upgrade" -eq 1 ]; then
  echo "==> checking ProgramData size for $keypair_pubkey on $cluster_shown"
  current_len=""
  if show_json=$(solana program show "$keypair_pubkey" --url "$cluster" --output json 2>/dev/null); then
    current_len=$(printf '%s' "$show_json" | grep -m1 '"dataLen"' | sed -E 's/[^0-9]*([0-9]+).*/\1/')
  fi
  so_size=$(wc -c <"$so_path" | tr -d ' ')
  # UpgradeableLoaderState::ProgramData header: 4-byte enum tag + 8-byte slot
  # + 1-byte Option tag + 32-byte upgrade authority pubkey = 45 bytes.
  required_len=$((so_size + 45))
  if [ -z "$current_len" ]; then
    echo "deploy: could not read ProgramData size for $keypair_pubkey on $cluster_shown (not deployed yet?)" >&2
  elif [ "$required_len" -gt "$current_len" ]; then
    extend_by=$((required_len - current_len))
    echo "ProgramData is $current_len bytes; the new build needs $required_len bytes."
    echo "  solana program extend $keypair_pubkey $extend_by --url $cluster_shown"
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

# --- 6. write-buffer, hand it to the upgrade authority, then deploy --------
# (deploy also covers upgrades)
cu_price="${DEPLOY_CU_PRICE:-100000}"
fee_payer_shown="${FEE_PAYER_KEYPAIR:+ --fee-payer $FEE_PAYER_KEYPAIR}"

if [ "$dry_run" -eq 1 ]; then
  echo "[dry-run] would run:"
  if [ "$env_name" = "mainnet" ]; then
    echo "  solana program write-buffer $so_path --url $cluster_shown --with-compute-unit-price $cu_price --max-sign-attempts 50 --use-rpc$fee_payer_shown"
    echo "  solana program set-buffer-authority <buffer> --new-buffer-authority <ledger pubkey> --url $cluster_shown"
    echo "  solana program deploy --buffer <buffer> --program-id $keypair --url $cluster_shown --with-compute-unit-price $cu_price --max-sign-attempts 50 --use-rpc --upgrade-authority usb://ledger$fee_payer_shown"
  else
    echo "  solana program write-buffer $so_path --url $cluster_shown --with-compute-unit-price $cu_price --max-sign-attempts 50$fee_payer_shown"
    echo "  solana program deploy --buffer <buffer> --program-id $keypair --url $cluster_shown --with-compute-unit-price $cu_price --max-sign-attempts 50$fee_payer_shown"
  fi
  echo "[dry-run] would then check for stray buffers, assert the upgrade authority, and run: pnpm --filter @hexvault/web sync-idl && pnpm --filter @hexvault/backend sync-idl"
  exit 0
fi

# The buffer is written under the hot key on every env, so the Ledger is not
# asked to sign each Write chunk; mainnet moves it to the Ledger right after.
if [ "$env_name" = "mainnet" ]; then
  printf 'Type the mainnet program id to confirm (%s): ' "$keypair_pubkey"
  read -r confirm
  if [ "$confirm" != "$keypair_pubkey" ]; then
    echo "deploy: confirmation did not match; aborting" >&2
    exit 1
  fi
  expected_authority=$(solana-keygen pubkey usb://ledger)
  set -- --with-compute-unit-price "$cu_price" --max-sign-attempts 50 --use-rpc
else
  expected_authority=$(solana address)
  set -- --with-compute-unit-price "$cu_price" --max-sign-attempts 50
fi
if [ -n "${FEE_PAYER_KEYPAIR:-}" ]; then
  set -- "$@" --fee-payer "$FEE_PAYER_KEYPAIR"
fi

echo "==> writing buffer"
buffer_output=$(solana program write-buffer "$so_path" --url "$cluster" "$@")
echo "$buffer_output"
buffer_pubkey=$(printf '%s\n' "$buffer_output" | sed -n 's/^Buffer: //p' | head -1)
if [ -z "$buffer_pubkey" ]; then
  echo "deploy: could not parse the buffer pubkey from write-buffer output" >&2
  exit 1
fi

# A stranded buffer still pays rent to nobody in particular. If anything from
# here to the end of the deploy fails, print exactly how to reclaim it. The
# close has to be signed by whoever holds the buffer authority: the hot key
# until set-buffer-authority lands, the Ledger from then on, so the trap
# reads $buffer_close_signer, which flips at that point.
buffer_close_signer=""
buffer_trap() {
  echo "deploy: a later step failed; recover the buffer with:" >&2
  echo "  solana program close $buffer_pubkey --bypass-warning --url $cluster_shown$buffer_close_signer" >&2
  if [ -n "$buffer_close_signer" ]; then
    echo "  (the buffer authority is the Ledger now, so the close is signed on the device)" >&2
  fi
  echo "  (recipient defaults to whichever keypair runs that command; pass --recipient <address> to send the rent elsewhere)" >&2
}
trap buffer_trap ERR

if [ "$env_name" = "mainnet" ]; then
  echo "==> handing buffer $buffer_pubkey to the Ledger ($expected_authority)"
  solana program set-buffer-authority "$buffer_pubkey" --new-buffer-authority "$expected_authority" --url "$cluster"
  buffer_close_signer=" --buffer-authority usb://ledger"
  set -- --with-compute-unit-price "$cu_price" --max-sign-attempts 50 --use-rpc --upgrade-authority usb://ledger
else
  set -- --with-compute-unit-price "$cu_price" --max-sign-attempts 50
fi
if [ -n "${FEE_PAYER_KEYPAIR:-}" ]; then
  set -- "$@" --fee-payer "$FEE_PAYER_KEYPAIR"
fi

echo "==> deploying (buffer $buffer_pubkey)"
solana program deploy --buffer "$buffer_pubkey" --program-id "$keypair" --url "$cluster" "$@"

trap - ERR

# --- 7. buffer and authority checks, then report and sync both apps' IDL ---
show_json=$(solana program show "$keypair_pubkey" --url "$cluster" --output json)
echo "$show_json"

actual_authority=$(printf '%s' "$show_json" | grep -m1 '"authority"' | sed -E 's/.*"authority": *"?([^",}]+)"?.*/\1/')
if [ "$actual_authority" != "$expected_authority" ]; then
  echo "deploy: upgrade authority is $actual_authority, expected $expected_authority for $env_name" >&2
  exit 1
fi
echo "==> upgrade authority $actual_authority matches $env_name"

# How many buffers a `solana program show --buffers --output json` listing
# holds. jq when it is there, else a count of "address" keys (one per
# buffer); anything the listing does other than list buffers is not a
# failure of this check.
count_buffers() {
  count=""
  if command -v jq >/dev/null 2>&1; then
    count=$(printf '%s' "$1" | jq -r '.buffers | length' 2>/dev/null) || count=""
  fi
  case "$count" in
    '' | *[!0-9]*) count=$(printf '%s' "$1" | grep -o '"address"' | wc -l | tr -d ' ' || true) ;;
  esac
  printf '%s\n' "${count:-0}"
}

# The RPC's account index lags the deploy by a few seconds, so the buffer the
# deploy just consumed can still show up. Re-check before calling it stray.
buffer_count=0
for attempt in 1 2 3 4 5 6; do
  buffers_json=$(solana program show --buffers --buffer-authority "$expected_authority" --url "$cluster" --output json)
  buffer_count=$(count_buffers "$buffers_json")
  [ "$buffer_count" -eq 0 ] && break
  [ "$attempt" -lt 6 ] && sleep 5
done
if [ "$buffer_count" -ne 0 ]; then
  echo "$buffers_json" >&2
  echo "deploy: $buffer_count buffer(s) left under $expected_authority; close them:" >&2
  echo "  solana program close <buffer> --bypass-warning --url $cluster_shown$buffer_close_signer" >&2
  exit 1
fi
echo "==> no stray buffers under $expected_authority"

echo "==> syncing IDL"
pnpm --filter @hexvault/web sync-idl
pnpm --filter @hexvault/backend sync-idl
