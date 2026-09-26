# Incident playbooks

`GET /alerts` is what pages a human: 200 with an empty list when things are fine, 503 with the
active codes otherwise (production-hardening ticket 05). Each playbook below opens with the code
that usually starts it. Admin commands run through the CLI,
`pnpm --filter @hexvault/backend admin <command>`, with the target environment's `.env` exported
first; see [`docs/ops/funds.md`](funds.md) for the full convention and signing through a Ledger or
Squads.

## Chain stall mid-round

Starts with `OPERATOR_STALE`, sometimes alongside `INDEXER_STALE`.

1. Check `GET /status`: `operator.lastAction` and `operator.lastTickAt` for the operator,
   `cursor.ageSeconds` for the indexer.
2. The operator sleeps until the next chain-clock deadline, a round's `close_buffer`, a request's
   `vrf_timeout`, an epoch's `payout_timeout`, and works through one epoch and one round at a time:
   `begin_epoch`, `register`, `close_registration`, `draw`, `payout`, and `create_round`, then
   `settle_round` or `void_round`. A 60s safety tick is the backstop if a deadline is missed.
   Waiting on a deadline is not a stall by itself, as long as `lastTickAt` keeps advancing.
3. A round whose randomness never arrives voids itself once `vrf_timeout` passes its request; an
   epoch stuck `Drawn` with no payout rolls over once `payout_timeout` passes. Neither needs a
   human today. See "VRF not fulfilling" below if this keeps repeating.
4. If the tick is genuinely stuck rather than waiting, check the backend logs
   (`docker compose -f <env's compose file> logs -f backend`) for the operator's own error, and
   check `/alerts` for `RPC_DOWN` alongside: a hung RPC read stalls the tick with nothing else to
   show for it, for at most `RPC_TIMEOUT_MS`, since the per-call timeout bounds every chain read
   and send. Check `GET /status`'s `rpcEndpoint` to see whether the fallback is serving.
5. Restart the backend for the affected environment if the process looks hung, not just waiting:
   `docker compose -f docker-compose.dev.yml restart backend` (swap the compose file for the
   environment, see [`docs/ops/environments.md`](environments.md)).
6. Pause (see "Suspected exploit" below) if rounds stay visibly stuck after a restart. Pause today
   stops `create_round`, `deposit` and `buy_tickets` only; an already-open round still plays out to
   settlement.
7. Players see the countdown end at `close_buffer` and the stage read DRAWING until settle lands
   ([`runbook.md`](../../runbook.md)). A real stall shows as DRAWING, or "no open round", staying
   that way well past the usual few seconds.

## RPC provider down

Starts with `RPC_DOWN` or `RPC_FALLBACK_ACTIVE`.

1. `RPC_FALLBACK_ACTIVE` means the fallback is already serving: a timeout, 5xx or 429 from the
   primary sends that one call to `RPC_FALLBACK_URL`, and the next call tries the primary again
   (production-hardening ticket 03). Check `GET /status`'s `rpcEndpoint` (`"primary"` or
   `"fallback"`) and `rpcFallbackAt`.
2. If `RPC_FALLBACK_URL` is set and rounds and draws are still landing (`operator.lastAction`
   recent, `openRoundId` advancing), no action is needed beyond watching it.
3. `RPC_DOWN` without a working fallback needs a new endpoint. Set `RPC_URL` (and
   `RPC_FALLBACK_URL`, if a second provider is available) in the environment's env file, then
   recreate the backend so it picks up the change: `docker compose -f docker-compose.dev.yml up -d
   --force-recreate backend` (swap the compose file and add `--env-file .env.mainnet` on mainnet,
   see [`docs/ops/environments.md`](environments.md)).
4. Rotate the web's public RPC the same way: set `VITE_PUBLIC_RPC_URL` on the affected Vercel
   project to a working public endpoint and redeploy, a Vercel env var only reaches the bundle on
   the next build. Never put a keyed URL there; it ships to every visitor
   ([`runbook.md`](../../runbook.md), "Frontend RPC endpoint").

## VRF not fulfilling

Starts with `ROUND_VOIDED_RECENTLY` or `EPOCH_ROLLED_OVER_RECENTLY`.

1. Confirm it is ORAO and not the operator: check the backend logs for a sent
   `request_round_randomness` or `draw` with a confirmed signature and no matching settle, and
   check `GET /status` / `GET /epochs/current` for a round or epoch parked past its `vrf_timeout`.
2. Void and rollover fire on their own once the timeout passes: `void_round` once `vrf_timeout`
   passes a round's or a drawing epoch's request, `rollover_epoch` once `payout_timeout` passes a
   drawn epoch. Today only the operator can call either one, `has_one = operator` on the Pool
   account; once production-hardening ticket 01 lands, any signer may also call them after the
   same timeout, as a backstop if the operator itself is down.
3. Check ORAO's own status page or Discord for a network-wide outage, and whether other ORAO
   consumers on the same cluster are stuck too. A HexVault-only stall points at the operator or its
   RPC instead, see "Chain stall mid-round" above.
4. Raise `vrf_timeout` if ORAO is consistently slower than the configured value (120s at
   bootstrap), so an honest but slow draw stops voiding: `admin set-params --vrf-timeout N`.

## Suspected exploit

Starts with whichever code names the damage, or none if the report comes in first.

1. Pause first, from either key: `pnpm --filter @hexvault/backend admin pause`. It signs locally
   with whichever key the environment has loaded, admin or operator, and stops `create_round`,
   `deposit` and `buy_tickets`. An already-open round still takes `buy_position`, and
   `grant_tickets` still mints, until production-hardening ticket 02 lands.
2. Assess: compare recent events and vault balances (jackpot vault, principal vault, House Player)
   against what `GET /status`, `GET /rounds/:id` and `GET /players/:owner` report, and check the
   backend logs for anything unexpected.
3. Decide the next step:
   - **False alarm, or contained**: `pnpm --filter @hexvault/backend admin unpause` (admin-only,
     goes through Squads on mainnet).
   - **A code fix is needed**: ship it with `scripts/deploy.sh <env> --upgrade`
     ([`docs/ops/deploy.md`](deploy.md#upgrading)). Run it only once no Round is open
     (`GET /status`'s `openRoundId`).
   - **Funds need to come out for good**: `return-principal` until `principal-out` reads 0, let any
     already-drawn epoch's `payout` land, then `shutdown --confirm <pool-id>`, `emergency-crank
     [--batch N]`, `sweep-house`, in that order
     ([`docs/ops/funds.md`](funds.md#shutdown-and-the-emergency-exits)).
4. There is no on-call rotation yet (production-hardening ticket 13 sets up the uptime monitor's
   paging target); until it exists, whoever notices the incident runs this playbook and pulls the
   rest of the team in directly. `security.txt`'s `project_url` and `contacts` are still `TODO` in
   `programs/hex_vault/src/lib.rs`; once filled, an outside researcher's report lands on the
   address in that file's `contacts:` line instead.

## Operator out of SOL

Starts with `OPERATOR_SOL_LOW`.

1. Confirm with `GET /healthz`'s `operatorSol` field: below `OPERATOR_SOL_WARN` (default 0.5 SOL)
   is what triggers the alert.
2. Top up with a plain transfer: `solana transfer <operator-pubkey> 1 --url <cluster>`
   ([`docs/ops/funds.md`](funds.md#operator-sol)).
3. No restart needed. The same hot key just needed more lamports; the next tick's transactions go
   through once the balance lands.
