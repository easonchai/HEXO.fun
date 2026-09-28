# The database outlives the pool

Until now a fresh pool meant `docker compose down -v`. Epoch, Round and Player rows were keyed
by their on-chain ids alone, and those ids restart at 1 on every pool, so the old pool's rows
collided with the new one's. The boot guard made it explicit: a Pool row for any address other
than the configured one refused to start. That was fine while every row was a mirror of the
chain and could be rebuilt. It stopped being fine when Invite codes, Referral codes and
Referrals landed: those exist only in Postgres, a wipe deletes them, and they must outlive any
one pool.

So every pool-scoped table now carries the Pool's address and is keyed by it, the database holds
as many pools as it has ever mirrored, and the backend serves the one `POOL_ID` names (the
Active pool). A Pool cutover is an env change and a redeploy. Nothing is deleted. This is how
indexers for Drift, Marginfi and the other long-lived Solana protocols work: rows carry the
market or pool address, and the database outlives the accounts it mirrors.

Considered and rejected: an admin command that deletes the pool-scoped tables in one
transaction and keeps the user-level ones. It is a day's work against a week, but it loses the
old pool's history for good, it needs a grandfather step so old depositors still pass the beta
gate, and it is a destructive command that runs against whatever `DATABASE_URL` is set. A
mainnet beta that may rewrite the program a few times cannot afford a wipe per rewrite.

Consequences: composite keys on nine tables, one row per pool for the indexer Cursor and
OperatorState instead of a singleton, and every indexer, operator and API query scoped to the
Active pool. "Has this wallet deposited" checks (beta gate, referral apply) look across every
pool, so a depositor from a retired pool stays let in. The referral job reads the Active pool
only, so a referee's Principal reads 0 after a cutover until they deposit again. Upgrades that
fit the reserved padding (ADR 0013) keep the live pool and never touch any of this.
`docs/plan/pool-cutover/spec.md` has the details.
