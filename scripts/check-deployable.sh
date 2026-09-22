#!/bin/sh
# Refuses a program artifact built with --features test-vrf, which stubs the
# ORAO CPI and puts the randomness account at a PDA of this program. Deploying
# one is silent: the program loads, and every draw is fabricated. There is no
# CI here, so the runbook's deploy steps call this first.
#
# Unconditional, so it also covers ops-and-envs ticket 06's rule that
# test-vrf may never combine with the staging or mainnet feature: any deploy
# target (dev, staging or mainnet) refuses a test-vrf-tainted binary here,
# before scripts/deploy.sh ever gets to `solana program deploy`.
#
# Usage: sh scripts/check-deployable.sh [path/to/hex_vault.so]
set -eu

SO="${1:-target/deploy/hex_vault.so}"

if [ ! -f "$SO" ]; then
  echo "check-deployable: $SO is missing; run anchor build (no --features)" >&2
  exit 1
fi

hits=$(strings "$SO" | grep -c test-vrf || true)
if [ "$hits" -ne 0 ]; then
  echo "check-deployable: $SO is a test-vrf build ($hits matches); rebuild with a plain anchor build" >&2
  exit 1
fi

echo "check-deployable: $SO carries no test-vrf symbols"
