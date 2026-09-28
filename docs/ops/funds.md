# Fund operations

All commands run through the admin CLI: `pnpm --filter @hexvault/backend admin <command>`, with
the target environment's `.env` exported first (`set -a; . ./.env; set +a`). `DATABASE_URL` must
be set even though these commands touch no database; the CLI validates the backend's full env.
See `apps/backend/src/admin/args.ts` for exact flags, and
[`docs/ops/deploy.md`](deploy.md#admin-signing-local-key-ledger-or-squads) for signing through a
Ledger or a Squads vault (`ADMIN_KEYPAIR` / `ADMIN_ADDRESS`).

## Principal: pull, return, and how much is out

The admin can move principal off the program to a yield venue. `admin_withdraw` is the only
on-chain instruction; returning it is a plain SPL transfer with no instruction behind it, because
the program has nothing to verify that the vault balance does not already say.

```bash
admin withdraw-principal --amount 25000     # pull 25,000 USDC out
admin principal-out                          # read-only: how much is out right now
admin return-principal --amount 25000        # return 25,000 USDC
```

`principal-out` (and `return-principal`, before and after) print:

```
total_principal=<T> pending_withdrawals=<W> yield_budget=<Y> vault=<V> principal_out=<T+W+Y-V, floored at 0>
```

This is the same figure `GET /status`'s `principalOut` reports. `withdraw-principal` refuses if
the vault would drop below `pending_withdrawals`, so the admin cannot strand a depositor who
already requested a withdrawal. `return-principal` is a plain transfer from the admin's own
associated token account into the principal vault; there is no on-chain `admin_return` and no
`deployed_out` counter by design (spec.md "Out of Scope").

## Funding the prize and the yield budget

Both are permissionless top-ups; any wallet holding the accepted mint can run them.

```bash
admin fund-jackpot --amount 42069000000   # raw atomic units, 6 decimals
admin fund-yield --amount 12000000000     # raw atomic units, 6 decimals
```

`fund-jackpot` raises the jackpot vault, which `close_registration` snapshots into an epoch's
prize (an epoch closing under `min_jackpot` rolls over instead of paying dust). `fund-yield`
raises `Pool.yield_budget`, which `register` draws down once per ended epoch to credit Base
yield; when the budget runs short the credit is partial and `GET /status`'s `yieldShortfall`
reports the gap. Size a daily top-up as `total_principal * base_rate_bps / 10_000 / 365`.

## Operator SOL

The operator's hot key pays every crank transaction's fee. Top it up with a plain transfer:

```bash
solana transfer <operator-pubkey> 1 --url <cluster>
```

`GET /healthz` reports `operatorSol` and turns `degraded` below `OPERATOR_SOL_WARN` (default
0.5 SOL); alert on that field rather than waiting for cranks to start failing.

## Shutdown and the emergency exits

`shutdown` is admin-only and irreversible: it stops every inflow, the game and the draw, and lets
withdrawals skip the epoch lock (`Pool.shutdown = true`, modelled on Marginfi/Kamino
`ReduceOnly`). Run it only when the pool is being wound down for good.

```bash
admin shutdown --confirm <pool-id>          # pool-id must equal the configured pool, or nothing sends
admin emergency-crank --batch 5             # permissionless; pays every Player still owed a balance
admin sweep-house                           # admin-only; jackpot surplus + unspent yield to treasury
```

Run these in this order, and only after every winner who can still be paid has been:

1. **`return-principal`**, until `principal-out` reads 0 (or as close to 0 as the yield venue
   allows). Anything still deployed at shutdown is money `emergency-crank` and `sweep-house`
   cannot reach.
2. **Let any already-drawn epoch pay out first.** `payout` of an epoch already in `Drawn` status
   is still allowed after shutdown (an epoch that has not drawn yet can never reach `Drawn`
   post-shutdown, since `draw` is refused). `sweep_house` only ever sweeps the jackpot vault's
   balance above `pool.jackpot_reserved`, precisely so it cannot stall a winner who has not
   claimed yet, but running `payout` before you sweep is still the safer order.
3. **`shutdown --confirm <pool-id>`.**
4. **`emergency-crank [--batch N]`.** Permissionless: lists every Player (House excluded) with
   `principal + pending_withdraw > 0` read straight off the chain (not the indexer, so it works
   even if Postgres is behind), creates each owner's associated token account if missing, and
   pays `emergency_withdraw` in batches of `N` (default 5). Stops at the first `InsufficientVault`
   and reports paid, skipped and the shortfall; safe to re-run.
5. **`sweep-house`.** Moves the jackpot vault's balance above `jackpot_reserved`, and whatever of
   `yield_budget` the principal vault still holds above `total_principal + pending_withdrawals`,
   to `pool.treasury`. Never touches principal; safe to run more than once (a later `fund_jackpot`
   can be swept again).

The House never receives an `emergency_withdraw`; its principal is protocol money and only ever
leaves through `sweep_house`.
