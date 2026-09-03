# Verifiable randomness: ORAO VRF v2 (pull model)

Status: **implemented on the program path, devnet smoke pending deploy** (2026-09-03).
Replaces the review finding "mock randomness controls round and prize outcomes"
(docs/preliminary-security-review.md) for the settle path.

## Decision record: pull over push (oracle callback)

The alternative was a push/callback oracle (MagicBlock Ephemeral-VRF, ORAO-cb).
The choice of ORAO v2 pull is not a preference; it is what the evidence and the
failure domains support:

|                              | Push (oracle callback)                                                                                                                                                                   | Pull (ORAO v2, chosen)                                                                        |
| ---------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| Liveness                     | Settles the moment randomness exists                                                                                                                                                     | Settle tx is permissionless — anyone; the operator bot and the indexer surface pending rounds |
| Failure domain               | Settle logic runs inside the **oracle's** tx: our revert becomes their retry problem; a persistently failing callback strands the round with no recovery path                            | Settle runs in our tx, our errors, our tests                                                  |
| Coupling                     | Callback discriminator + account metas declared at request time; SDK must compile against anchor-lang 1.1.2 (MagicBlock SDK 0.3.0 unverified; ORAO-cb is anchor-0.30 era — incompatible) | No crate, no CPI; account layout pinned and unit-tested                                       |
| Devnet evidence (2026-09-03) | Only an ephemeral-rollup queue documented; base-layer queue last active 2026-08-13                                                                                                       | network_state live, 4 fulfillment authorities, 214,410 requests, latest tx same day           |

Security properties are a property of the **request design**, not the delivery
model: both models need seed freshness, one-shot requests, and binding. Pull
delivers them with a smaller, auditable surface. MagicBlock remains the
documented upgrade path once its base-layer devnet story and anchor-1.x SDK are
proven.

## Architecture

One provider, three draw domains (round / prize / jackpot), each already keyed
by its own randomness-request PDA:

```
close            request (permissionless)          oracle quorum          settle (permissionless)
─────►  ─────────────────────────────►  ──►  fulfills ORAO account  ──►  fulfill_*_with_vrf
round closed     client seed ⊕ slot hash           (4 authorities XOR)     reads bound ORAO account
                 stored in RandomnessRequest       ~4–20 s on devnet       tile = unbiased_index(sample)
```

- **Round draws** (per-minute cadence): settle lands 5–25 s after close; round
  N+1 runs while N settles. Push would shave one tx (~1–2 s) — no user-visible
  gain at a per-minute cadence.
- **Epoch prize/jackpot draws** (weekly): latency-insensitive; identical flow.

### Why the seed cannot be ground

`RandomnessRequest.seed = sha256(client_seed ‖ slot_hash_of_request_slot ‖ slot_le)`
(`vrf::mix_seed`, `utils::mix_client_seed`):

- The **slot hash is unknowable before the slot exists**, so neither the
  requester nor a pre-close observer can pre-compute outcomes.
- The request PDA is `init` — exactly **one shot per (round | epoch, kind)**;
  discarded attempts do not exist.
- The requester learns nothing at request time: the ORAO value is the oracle
  quorum's verifiable function of the seed, computed after the request exists.

### Binding — nothing submitter-chosen can slip in

`fulfill_*_with_vrf` re-derives the ORAO request address from data the protocol
controls, and the accounts context enforces ownership:

```
orao_request = PDA(["orao-vrf-randomness-request", network_state, request.seed], ORAO_PROGRAM)
```

- `orao_network_state` must equal `config.vrf_randomness_state` (set at
  `initialize --vrf-state`).
- Both ORAO accounts must be **owned by the ORAO program** (Anchor `owner`
  constraint).
- `parse_fulfilled` rejects wrong discriminators and **pending** accounts —
  only finalized draws settle.
- Tile/target mapping reuses the existing bias-protected helpers
  (`unbiased_index`, `unbiased_u64`).
- Mock fulfillment stays available on localnet but is **hard-gated**:
  `production_mode == false` is required for every mock path.

## Residual trust (honest limits)

- ORAO fulfillment requires a **quorum of the configured fulfillment
  authorities** (4 on devnet, XOR-combined). A colluding quorum could bias
  outputs — this replaces "one mock authority controls everything" and is the
  remaining oracle-network assumption to carry into the audit scope.
- `config.vrf_randomness_state` is set once at `initialize`; changing providers
  is an authority-gated upgrade (no config-update instruction exists in v1).
- Provider diversity (a second VRF provider for the weekly draw) is a
  documented post-audit option: the request/fulfill shape is provider-agnostic
  per kind, so a second provider is one more instruction family, not a redesign.

## Devnet runbook

Localnet stays mock-only (`initialize` without `--vrf-state`); the browser e2e
harness is unaffected. For a devnet deployment:

1. **Deploy with VRF enabled at init** (the config field is set once):
   ```sh
   anchor build   # PATH="$HOME/.cargo/bin:$PATH" if cargo is not the rustup shim
   anchor deploy --provider.cluster devnet --program-name hex_vault
   hexvault initialize --guardian <g> --snapshot <s> --mock-randomness <m> \
     --vrf-state 5ER1oENnV4srxYdAynUfRzWeQCPQaqMiAp4VqyMbSqnK
   ```
   `5ER1o…SqnK` is ORAO's devnet network-state PDA (seed
   `orao-vrf-network-configuration`, program `VRFzZoJdhFWL8rkvu87LpKM3RbcVezpMEc6X5GVDr7y`),
   probed live on 2026-09-03.
2. **Request** (anyone, after the round closes):
   ```sh
   hexvault randomness request round --pool-id 1 --round-id 7        # --seed <hex> optional
   ```
   The program stores `sha256(seed ‖ slot_hash)`.
3. **Create the ORAO request** (operator or anyone) with the stored seed:
   read it via `hexvault randomness show` (or fetch the request account), then
   send ORAO's `request(seed)` instruction — payer, network_state, treasury
   (from the network state), request PDA
   `["orao-vrf-randomness-request", network_state, seed]`, system program;
   fee 0.001 SOL to the treasury.
4. **Settle** (anyone, once the quorum fulfills, typically 4–20 s):
   ```sh
   hexvault randomness fulfill-vrf round --pool-id 1 --round-id 7
   ```

## Changed surface (audit pointers)

- `programs/hex_vault/src/vrf.rs` — layout parser, seed mixing, ORAO PDA
  derivation, unit tests (8/8 green including pending/foreign-account
  rejection).
- `lib.rs` — `client_seed` arg + SlotHashes sysvar on the three request
  instructions; `fulfill_round_with_vrf` / `fulfill_prize_with_vrf` /
  `fulfill_jackpot_with_vrf`; `ProtocolConfig.vrf_randomness_state`.
- TS: `apps/web/src/actions.ts` (browser CSPRNG client seed), CLI
  `randomness request --seed` / `randomness fulfill-vrf`, `initialize
--vrf-state`, test helpers.
