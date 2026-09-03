# Localnet UI plan and program-specific CLI plan

The production UI is owned by the designer; this cycle ships the **functional skeleton**
needed to validate every program flow end-to-end locally, plus the **ops CLI** that
exercises the program the way operators and tests will.

## 1. Program-specific CLI (`packages/cli`, shipped)

Single binary `hexvault` (tsx entrypoint, `@solana/web3.js` + Anchor program client from
the committed IDL). Wallet = keypair file (`--keypair` or `HEXVAULT_KEYPAIR`, default
`~/.config/solana/id.json`); cluster = `--url` (default localnet). Global `--pool` for
per-pool commands. Output: JSON by default (`--text` for humans), so scripts and tests
consume it directly.

### Command surface

| Group           | Commands                                                                                                                                                                                                             |
| --------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----- | ---------------------------------- | ----- | ------------------- |
| Protocol        | `initialize --guardian K --snapshot K --mock-randomness K --min-deposit N --max-stake N --buffer S` · `pause --pool ID on/off` · `status`                                                                            |
| Pools           | `pool create --id ID --mint M --token-program P --min-deposit N --max-stake N --max-bonus N --min-epoch S --max-epoch S --buffer S` · `pool show --pool ID`                                                          |
| Epochs          | `epoch create --pool ID --id N --starts T --cutoff T --ends T --snapshot T --deadline T` · `epoch next …` · `epoch show`                                                                                             |
| Custody         | `deposit --pool ID --amount N` · `withdraw --pool ID --amount N` · `refresh --pool ID` · `balances --pool ID --owner K`                                                                                              |
| Game            | `round create --pool ID --id N --starts T --ends T --bonus N` · `position buy --pool ID --tiles "1,7,22" --stake N` · `round show`                                                                                   |
| Randomness      | `randomness request round                                                                                                                                                                                            | prize | jackpot`·`randomness fulfill round | prize | jackpot --sample N` |
| Rewards         | `reward claim --round N`                                                                                                                                                                                             |
| Prize           | `prize fund --amount N` · `prize commit --root 0x… --weight N --amount N` · `prize claim --weight N --proof proof.json` · `prize expire`                                                                             |
| Jackpot         | `jackpot fund --amount N` · `jackpot commit` · `jackpot claim --weight N --proof proof.json` · `jackpot expire` · `jackpot status`                                                                                   |
| Indexer support | `snapshot export --pool ID --epoch N --out snapshot.json` (reads Postgres, computes canonical Merkle root + per-player proofs) · `reconcile` (PT supply vs principal vault, prize/jackpot solvency, root comparison) |

### Notable behaviors

- `snapshot export` is the bridge between indexer data and on-chain claims: it derives
  `(owner, weight)` leaves from indexed `DepositRecorded`/entries state, computes the same
  domain-tagged Merkle tree as the program, emits the root (for `prize commit`) and each
  player's proof file (for `prize claim`). This makes the I-03 trust boundary _inspectable_:
  anyone with the exported snapshot can verify the committed root.
- `reconcile` is the operator's independent check and is also used by the indexer service.
- Exit codes distinguish usage errors, chain errors, and failed assertions (scriptable).

## 2. Localnet UI plan (minimal functional app this cycle; designer replaces presentation)

### Scope this cycle (shipped, `apps/web`)

Vite + React + TypeScript, wallet-adapter standard wallets (Privy stays opt-in per policy).
Reads state from the indexer API; all writes are user-signed program transactions. Purely
functional styling — the designer owns the real presentation.

Screens (single page, tabbed):

1. **Connect / network bar** — cluster indicator (localnet only hard-allowed), wallet button.
2. **Dashboard** — pool selector; principal / entries / immediately-withdrawable; current
   epoch timeline with the six PRD states; prize + jackpot amounts and statuses; pause banner
   with withdrawal-still-live disclosure (G-06 behavior).
3. **Board** — 36 tiles, multi-select, per-tile stake input with live "entries spent" and
   "withdrawable after" preview (PRD §11: consequence shown pre-confirmation, not in a
   tooltip), submit → one immutable position.
4. **Rounds & rewards** — round list, settlement status, winning tile, claim reward button.
5. **Prize** — snapshot info (root, weight, amount), randomness status, claim with exported
   proof, deadline countdown.
6. **Jackpot** — vault balance, committed amount, draw status, claim/deadline.

### Hard requirements carried into the designer brief

- On-chain state is authoritative; the API is a cache (PRD principle 5).
- Withdrawal-consequence preview is part of the confirmation flow, never a tooltip.
- Values rendered from atomic u64 with explicit decimal handling; no float math (money path).
- Accessible board (labels per tile, non-color state cues) and reduced-motion support are
  acceptance criteria, not polish (PRD §11) — flag to designer as Phase-2 gate.
- Addresses treated as sensitive in analytics; none collected this cycle.

### Deliberately deferred to the designer cycle

Visual design, animations/orb, theming, mobile layout refinement, marketing copy,
notification center UI. The data plumbing and state machine this cycle exposes are exactly
what the designed UI will consume, so no rework is expected beyond presentation.

## 3. Backend service topology (shipped)

```
┌────────────┐   logs(finalized)   ┌──────────────┐   SQL   ┌───────────┐
│ solana-test│ ──────────────────▶ │   indexer    │ ──────▶ │ Postgres  │
│ validator  │                     │ (workspace   │         └─────┬─────┘
│ + program  │ ◀────────────────── │  pkg, node)  │  reconcile    │
└────────────┘   CLI txs (ops)     └──────┬───────┘◀──────────────┘
                                          │ SQL reads
                                   ┌──────▼───────┐        ┌──────────┐
                                   │  API (Fastify)│◀──────▶│ browser  │
                                   └──────────────┘  HTTP  └──────────┘
```

- **Indexer**: finalized-only subscription, Anchor event decode, cursor table
  (slot/signature/event_index) written in the same transaction as projections → restart-safe,
  idempotent, out-of-order rejected. Computes canonical snapshot roots; reconciliation job
  compares chain balances vs projections vs committed roots.
- **API**: read-only REST (`/pools`, `/epochs`, `/rounds`, `/players/:owner`, `/prizes`,
  `/jackpots`, `/snapshot/:epoch`, `/healthz`, `/readyz`, `/metrics` in Prometheus text).
- **Ops**: the CLI is the only writer besides user wallets.
- **Compose**: `db` + `migrate` + `indexer` + `api`, optional `--profile chain` adds
  validator + program deploy; healthchecks gate startup order; pino JSON logs everywhere.
